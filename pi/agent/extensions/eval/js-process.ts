import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { Language, type Node, Parser } from "web-tree-sitter";

interface EvalRequest {
	id: number;
	code: string;
	cwd: string;
}

interface EvalResponse {
	id: number;
	output: string;
	error?: string;
}

const writeProtocol = process.stdout.write.bind(process.stdout);
const requireFromExtension = createRequire(import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
let parserPromise: Promise<Parser> | undefined;
let output: string[] = [];
let cwd = process.cwd();

function format(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function captureWrite(chunk: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean {
	const text = Buffer.isBuffer(chunk)
		? chunk.toString(typeof encoding === "string" ? encoding : "utf8")
		: String(chunk);
	output.push(text.replace(/\n$/, ""));
	if (typeof encoding === "function") encoding();
	else callback?.();
	return true;
}

process.stdout.write = captureWrite as typeof process.stdout.write;
process.stderr.write = captureWrite as typeof process.stderr.write;

const sandbox: Record<string, unknown> = {
	Bun,
	Buffer,
	URL,
	URLSearchParams,
	TextEncoder,
	TextDecoder,
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	fetch,
	process,
	require: (specifier: string) => createRequire(resolve(cwd, "__eval__.js"))(specifier),
	console: {
		log: (...values: unknown[]) => output.push(values.map(format).join(" ")),
		info: (...values: unknown[]) => output.push(values.map(format).join(" ")),
		warn: (...values: unknown[]) => output.push(values.map(format).join(" ")),
		error: (...values: unknown[]) => output.push(values.map(format).join(" ")),
	},
	display: (value: unknown) => output.push(format(value)),
	read: async (path: string) => Bun.file(resolve(cwd, path)).text(),
};
const context = vm.createContext(sandbox);

async function parser(): Promise<Parser> {
	parserPromise ??= (async () => {
		await Parser.init();
		const instance = new Parser();
		const language = await Language.load(
			requireFromExtension.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm"),
		);
		instance.setLanguage(language);
		return instance;
	})();
	return parserPromise;
}

function collectPatternNames(node: Node | null, names: Set<string>): void {
	if (!node) return;
	if (node.type === "identifier" || node.type === "shorthand_property_identifier_pattern") {
		names.add(node.text);
		return;
	}
	for (const child of node.namedChildren) collectPatternNames(child, names);
}

async function persistentNames(code: string): Promise<string[]> {
	const tree = (await parser()).parse(code);
	const names = new Set<string>();
	for (const node of tree.rootNode.namedChildren) {
		if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
			for (const child of node.namedChildren) {
				if (child.type === "variable_declarator") collectPatternNames(child.childForFieldName("name"), names);
			}
		} else if (
			node.type === "function_declaration" ||
			node.type === "class_declaration" ||
			node.type === "enum_declaration"
		) {
			collectPatternNames(node.childForFieldName("name"), names);
		}
	}
	tree.delete();
	return [...names];
}

function importForEval(specifier: string) {
	const resolved =
		specifier.startsWith(".") || specifier.startsWith("/") ? pathToFileURL(resolve(cwd, specifier)).href : specifier;
	return import(resolved);
}

async function evaluate(request: EvalRequest): Promise<EvalResponse> {
	output = [];
	cwd = request.cwd;
	try {
		process.chdir(cwd);
		const names = await persistentNames(request.code);
		const javascript = transpiler.transformSync(request.code);
		const persist = names.map((name) => `globalThis[${JSON.stringify(name)}] = ${name};`).join("\n");
		const script = new vm.Script(`(async () => {\n${javascript}\n${persist}\n})()`, {
			filename: `eval-${request.id}.ts`,
			importModuleDynamically: importForEval,
		});
		await script.runInContext(context);
		return { id: request.id, output: output.join("\n") || "(no output)" };
	} catch (error) {
		const message = error instanceof Error ? error.stack || error.message : String(error);
		return { id: request.id, output: output.join("\n"), error: message };
	}
}

for await (const line of createInterface({ input: process.stdin })) {
	let response: EvalResponse;
	try {
		response = await evaluate(JSON.parse(line) as EvalRequest);
	} catch (error) {
		response = { id: -1, output: "", error: error instanceof Error ? error.message : String(error) };
	}
	writeProtocol(`${JSON.stringify(response)}\n`);
}
