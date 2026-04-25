import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

type CtResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

type SymDetails = {
	operation: string;
	command: string;
	cwd: string;
	exitCode: number;
	results: unknown;
	stdout: string;
	stderr: string;
};

const commonOptions = {
	db: Type.Optional(Type.String({ description: "Override sym database path" })),
};

const targetList = Type.Array(Type.String({ description: "Symbol, file, or range target" }), {
	description: "Symbols, file paths, or ranges to analyze",
});

const ctSymSearchSchema = Type.Object({
	query: Type.String({ description: "Symbol or text query" }),
	text: Type.Optional(Type.Boolean({ description: "Search full text instead of indexed symbols" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results to return" })),
	kind: Type.Optional(Type.String({ description: "Symbol kind filter" })),
	lang: Type.Optional(Type.String({ description: "Language filter" })),
	exact: Type.Optional(Type.Boolean({ description: "Require exact matching" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive matching" })),
	paths: Type.Optional(Type.Array(Type.String({ description: "Include globs" }))),
	excludes: Type.Optional(Type.Array(Type.String({ description: "Exclude globs" }))),
	...commonOptions,
});

const ctSymTargetsSchema = Type.Object({
	targets: targetList,
	...commonOptions,
});

const ctSymShowSchema = Type.Object({
	targets: targetList,
	context: Type.Optional(Type.Number({ description: "Context lines around definitions" })),
	all: Type.Optional(Type.Boolean({ description: "Return every definition for ambiguous targets" })),
	...commonOptions,
});

const ctSymOutlineSchema = Type.Object({
	file: Type.String({ description: "File to outline" }),
	signatures: Type.Optional(Type.Boolean({ description: "Include signatures" })),
	names: Type.Optional(Type.Boolean({ description: "Only return names" })),
	...commonOptions,
});

const ctSymRefsSchema = Type.Object({
	targets: targetList,
	importers: Type.Optional(Type.Boolean({ description: "Also include importers" })),
	impact: Type.Optional(Type.Boolean({ description: "Include shallow impact" })),
	depth: Type.Optional(Type.Number({ description: "Reference/importer depth" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
	context: Type.Optional(Type.Number({ description: "Context lines around references" })),
	paths: Type.Optional(Type.Array(Type.String({ description: "Include globs" }))),
	excludes: Type.Optional(Type.Array(Type.String({ description: "Exclude globs" }))),
	file: Type.Optional(Type.String({ description: "Limit references to paths containing this fragment" })),
	...commonOptions,
});

const ctSymGraphSchema = Type.Object({
	targets: targetList,
	depth: Type.Optional(Type.Number({ description: "Traversal depth" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
	context: Type.Optional(Type.Number({ description: "Context lines around hits; impact only" })),
	kinds: Type.Optional(Type.String({ description: "Trace edge kinds, e.g. call or call,use" })),
	...commonOptions,
});

const ctSymImplsSchema = Type.Object({
	targets: targetList,
	lang: Type.Optional(Type.String({ description: "Language filter" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
	paths: Type.Optional(Type.Array(Type.String({ description: "Include globs" }))),
	excludes: Type.Optional(Type.Array(Type.String({ description: "Exclude globs" }))),
	of: Type.Optional(Type.String({ description: "Find protocols/interfaces implemented by this symbol" })),
	resolved: Type.Optional(Type.Boolean({ description: "Only include resolved implementation targets" })),
	unresolved: Type.Optional(Type.Boolean({ description: "Only include unresolved implementation targets" })),
	...commonOptions,
});

const ctSymContextSchema = Type.Object({
	targets: targetList,
	callers: Type.Optional(Type.Number({ description: "Maximum callers per symbol" })),
	...commonOptions,
});

const ctSymStructureSchema = Type.Object({
	limit: Type.Optional(Type.Number({ description: "Maximum entries per section" })),
	...commonOptions,
});

const ctSymDiffSchema = Type.Object({
	target: Type.String({ description: "Symbol whose definition-scoped diff should be shown" }),
	base: Type.Optional(Type.String({ description: "Base ref" })),
	stat: Type.Optional(Type.Boolean({ description: "Return diffstat instead of full diff" })),
	...commonOptions,
});

function runCommand(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<CtResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		child.on("error", (error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error(`${command} not found on PATH`));
				return;
			}
			reject(error);
		});

		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("close", (exitCode) => {
			signal?.removeEventListener("abort", onAbort);
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (exitCode === 0) {
				resolve({ stdout, stderr, exitCode: 0 });
				return;
			}
			reject(new Error(`${formatCommand(command, args)} failed with exit code ${exitCode ?? 1}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
		});
	});
}

function formatCommand(command: string, args: string[]): string {
	return [command, ...args.map((arg) => (/[\s\t]/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

function pushFlag(args: string[], enabled: unknown, flag: string) {
	if (enabled === true) args.push(flag);
}

function pushOpt(args: string[], flag: string, value: unknown) {
	if (value !== undefined && value !== null) args.push(flag, String(value));
}

function pushMany(args: string[], flag: string, values: unknown) {
	if (!Array.isArray(values)) return;
	for (const value of values) args.push(flag, String(value));
}

function parseSymResults(stdout: string): unknown {
	const parsed = JSON.parse(stdout);
	if (parsed && typeof parsed === "object" && "results" in parsed) return parsed.results;
	return parsed;
}

async function runSym(operation: string, args: string[], cwd: string, signal?: AbortSignal, db?: string) {
	const fullArgs = ["sym", "--json"];
	if (db) fullArgs.push("--db", db);
	fullArgs.push(...args);
	const result = await runCommand("ct", fullArgs, cwd, signal);
	const results = parseSymResults(result.stdout);
	const command = formatCommand("ct", fullArgs);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
		details: {
			operation,
			command,
			cwd,
			exitCode: result.exitCode,
			results,
			stdout: result.stdout,
			stderr: result.stderr,
		} satisfies SymDetails,
	};
}

function truncate(text: string, max = 96): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function relPath(item: any): string | undefined {
	return item?.rel_path ?? item?.path ?? item?.file;
}

function resultCount(results: unknown): number | undefined {
	if (Array.isArray(results)) return results.length;
	if (results && typeof results === "object") {
		const obj = results as Record<string, unknown>;
		for (const key of ["results", "symbols", "references", "items", "matches", "callers", "entries"]) {
			if (Array.isArray(obj[key])) return obj[key].length;
		}
	}
	return undefined;
}

function summarize(details: SymDetails | undefined, expanded: boolean, theme: any): string {
	if (!details) return "";
	const count = resultCount(details.results);
	const prefix = theme.fg("success", "✓ ") + theme.fg("toolTitle", theme.bold(`sym ${details.operation}`));
	const suffix = count === undefined ? "" : theme.fg("muted", ` → ${count} result${count === 1 ? "" : "s"}`);
	if (!expanded) return prefix + suffix;

	const lines = [prefix + suffix];
	const results = details.results;
	if (Array.isArray(results)) {
		for (const item of results.slice(0, 20)) {
			if (item && typeof item === "object") {
				const anyItem = item as any;
				const name = anyItem.name ?? anyItem.target ?? anyItem.symbol ?? anyItem.kind ?? "result";
				const kind = anyItem.kind ? theme.fg("muted", ` ${anyItem.kind}`) : "";
				const path = relPath(anyItem);
				const loc = path ? theme.fg("dim", ` ${path}${anyItem.start_line ? `:${anyItem.start_line}` : ""}`) : "";
				lines.push(`  ${theme.fg("accent", String(name))}${kind}${loc}`);
			} else {
				lines.push(`  ${theme.fg("toolOutput", truncate(String(item)))}`);
			}
		}
		if (results.length > 20) lines.push(theme.fg("muted", `  … ${results.length - 20} more`));
		return lines.join("\n");
	}

	const text = JSON.stringify(results, null, 2);
	for (const line of text.split("\n").slice(0, 40)) lines.push(theme.fg("toolOutput", line));
	return lines.join("\n");
}

function renderCall(operation: string, target: string | undefined, theme: any) {
	let text = theme.fg("toolTitle", theme.bold("sym ")) + theme.fg("accent", operation);
	if (target) text += " " + theme.fg("muted", truncate(target));
	return new Text(text, 0, 0);
}

function renderResult(result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: any) {
	if (options.isPartial) return new Text(theme.fg("warning", "sym running…"), 0, 0);
	return new Text(summarize(result.details as SymDetails | undefined, options.expanded === true, theme), 0, 0);
}

export default function symExtension(pi: ExtensionAPI) {
	const registerTool = pi.registerTool.bind(pi) as any;

	registerTool({
		name: "sym_search",
		label: "sym search",
		description: "Search indexed symbols, or full text with text=true.",
		promptSnippet: "Search indexed symbols with ct sym.",
		promptGuidelines: ["Use sym_search instead of grep/find when looking for code symbols."],
		parameters: ctSymSearchSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["search"];
			pushFlag(args, params.text, "--text");
			pushOpt(args, "--limit", params.limit);
			pushOpt(args, "--kind", params.kind);
			pushOpt(args, "--lang", params.lang);
			pushFlag(args, params.exact, "--exact");
			pushFlag(args, params.ignoreCase, "--ignore-case");
			pushMany(args, "--path", params.paths);
			pushMany(args, "--exclude", params.excludes);
			args.push(params.query);
			return runSym("search", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("search", args.query, theme),
		renderResult,
	});

	registerTool({
		name: "sym_investigate",
		label: "sym investigate",
		description: "Resolve and inspect symbols with kind-adaptive context.",
		promptSnippet: "Investigate symbols with source, callers, and references.",
		promptGuidelines: ["Use sym_investigate before reading unfamiliar symbols."],
		parameters: ctSymTargetsSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runSym("investigate", ["investigate", ...params.targets], ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("investigate", args.targets?.join(", "), theme),
		renderResult,
	});

	registerTool({
		name: "sym_show",
		label: "sym show",
		description: "Read source by symbol, file path, or file:line-line range.",
		promptSnippet: "Read source by symbol or file range.",
		parameters: ctSymShowSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["show"];
			pushOpt(args, "--context", params.context);
			pushFlag(args, params.all, "--all");
			args.push(...params.targets);
			return runSym("show", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("show", args.targets?.join(", "), theme),
		renderResult,
	});

	registerTool({
		name: "sym_outline",
		label: "sym outline",
		description: "List symbols defined in a file.",
		promptSnippet: "Outline symbols in a source file.",
		promptGuidelines: ["Use sym_outline before opening large or unfamiliar source files."],
		parameters: ctSymOutlineSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["outline"];
			pushFlag(args, params.signatures, "--signatures");
			pushFlag(args, params.names, "--names");
			args.push(params.file);
			return runSym("outline", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("outline", args.file, theme),
		renderResult,
	});

	registerTool({
		name: "sym_refs",
		label: "sym refs",
		description: "Find direct references to symbols.",
		promptSnippet: "Find direct references to symbols.",
		parameters: ctSymRefsSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["refs"];
			pushFlag(args, params.importers, "--importers");
			pushFlag(args, params.impact, "--impact");
			pushOpt(args, "--depth", params.depth);
			pushOpt(args, "--limit", params.limit);
			pushOpt(args, "--context", params.context);
			pushMany(args, "--path", params.paths);
			pushMany(args, "--exclude", params.excludes);
			pushOpt(args, "--file", params.file);
			args.push(...params.targets);
			return runSym("refs", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("refs", args.targets?.join(", "), theme),
		renderResult,
	});

	registerTool({
		name: "sym_impact",
		label: "sym impact",
		description: "Find transitive callers/dependents of symbols.",
		promptSnippet: "Trace who depends on a symbol.",
		parameters: ctSymGraphSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["impact"];
			pushOpt(args, "--depth", params.depth);
			pushOpt(args, "--limit", params.limit);
			pushOpt(args, "--context", params.context);
			args.push(...params.targets);
			return runSym("impact", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("impact", args.targets?.join(", "), theme),
		renderResult,
	});

	registerTool({
		name: "sym_trace",
		label: "sym trace",
		description: "Follow the call graph downward from symbols.",
		promptSnippet: "Trace what a symbol calls.",
		parameters: ctSymGraphSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["trace"];
			pushOpt(args, "--depth", params.depth);
			pushOpt(args, "--limit", params.limit);
			pushOpt(args, "--kinds", params.kinds);
			args.push(...params.targets);
			return runSym("trace", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("trace", args.targets?.join(", "), theme),
		renderResult,
	});

	registerTool({
		name: "sym_impls",
		label: "sym impls",
		description: "Find types that implement/extend/conform to symbols.",
		promptSnippet: "Find implementations or conformances for a type/interface.",
		parameters: ctSymImplsSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["impls"];
			pushOpt(args, "--lang", params.lang);
			pushOpt(args, "--limit", params.limit);
			pushMany(args, "--path", params.paths);
			pushMany(args, "--exclude", params.excludes);
			pushOpt(args, "--of", params.of);
			pushFlag(args, params.resolved, "--resolved");
			pushFlag(args, params.unresolved, "--unresolved");
			args.push(...params.targets);
			return runSym("impls", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("impls", args.targets?.join(", "), theme),
		renderResult,
	});

	registerTool({
		name: "sym_context",
		label: "sym context",
		description: "Bundle source, callers, conformance, and file imports for symbols.",
		promptSnippet: "Get bundled symbol context.",
		parameters: ctSymContextSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["context"];
			pushOpt(args, "--callers", params.callers);
			args.push(...params.targets);
			return runSym("context", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("context", args.targets?.join(", "), theme),
		renderResult,
	});

	registerTool({
		name: "sym_structure",
		label: "sym structure",
		description: "Return a structural overview of the indexed codebase.",
		promptSnippet: "Get a structural overview of the indexed codebase.",
		parameters: ctSymStructureSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["structure"];
			pushOpt(args, "--limit", params.limit);
			return runSym("structure", args, ctx.cwd, signal, params.db);
		},
		renderCall: (_args, theme) => renderCall("structure", undefined, theme),
		renderResult,
	});

	registerTool({
		name: "sym_diff",
		label: "sym diff",
		description: "Return git diff scoped to a symbol definition.",
		promptSnippet: "Show git diff scoped to a symbol definition.",
		parameters: ctSymDiffSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["diff"];
			pushFlag(args, params.stat, "--stat");
			args.push(params.target);
			if (params.base) args.push(params.base);
			return runSym("diff", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme) => renderCall("diff", args.target, theme),
		renderResult,
	});
}
