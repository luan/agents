/**
 * Syntax validation for formats `WASM_BY_EXTENSION` (block-resolver.ts:26) has
 * no grammar for. Those returned `unsupported_language`, which patcher.ts read
 * as "nothing to check", so corrupting edits applied silently.
 *
 * A census of 4693 real `edit` calls put grammar-less volume at ~530 (11%):
 * `.md` 303, `.svelte` 53, `.txt` 33, `.json` 23, `.html` 22, `.toml` 14,
 * `.yml` 8. Each format gets the cheapest exact check available. The delta
 * rule in patcher.ts still decides, so an already-broken file never blocks.
 */
import { createRequire } from "node:module";
import { treeSitterSyntaxValidator } from "./block-resolver.ts";
import type { SyntaxValidationResult, SyntaxValidator } from "./hashline/types.ts";

const require = createRequire(import.meta.url);

function extensionOf(path: string): string {
	const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function firstLine(value: unknown): string {
	return String(value).split("\n")[0].trim().slice(0, 160);
}

/** JSON-with-comments files fail both before and after, so the delta rule leaves them editable. */
function validateJson(text: string): SyntaxValidationResult {
	try {
		JSON.parse(text);
		return { kind: "valid", errorCount: 0 };
	} catch (error) {
		return { kind: "invalid", errorCount: 1, detail: firstLine(error instanceof Error ? error.message : error) };
	}
}

let yamlModule: { parseDocument(source: string): { errors: unknown[] } } | null | undefined;

/** `yaml` ships inside `@earendil-works/pi-agent-core`, so this adds no install. */
function loadYaml(): typeof yamlModule {
	if (yamlModule !== undefined) return yamlModule;
	try {
		yamlModule = require("yaml");
	} catch {
		yamlModule = null;
	}
	return yamlModule;
}

function validateYaml(text: string): SyntaxValidationResult {
	const yaml = loadYaml();
	if (!yaml) return { kind: "parser_unavailable" };
	try {
		const errors = yaml.parseDocument(text).errors;
		if (errors.length === 0) return { kind: "valid", errorCount: 0 };
		return { kind: "invalid", errorCount: errors.length, detail: firstLine((errors[0] as Error)?.message) };
	} catch (error) {
		return { kind: "invalid", errorCount: 1, detail: firstLine(error instanceof Error ? error.message : error) };
	}
}

// CommonMark: 3+ backticks or tildes, indented at most 3 spaces.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Markdown has no syntax errors. Code-fence balance is the one invariant with
 * a defined failure mode: losing a closing fence renders the rest as code.
 * This checks that and nothing else — it is not a markdown guard.
 */
function validateMarkdownFences(text: string): SyntaxValidationResult {
	let open: { char: string; length: number; line: number } | null = null;
	let line = 0;
	for (const raw of text.split("\n")) {
		line++;
		const match = FENCE_LINE.exec(raw);
		if (!match) continue;
		const char = match[1][0];
		const length = match[1].length;
		if (open === null) {
			// A backtick fence's info string may not hold a backtick, so ``` `x` ``` opens nothing.
			if (char === "`" && match[2].includes("`")) continue;
			open = { char, length, line };
			continue;
		}
		if (char === open.char && length >= open.length && match[2].trim() === "") open = null;
	}
	if (open === null) return { kind: "valid", errorCount: 0 };
	return {
		kind: "invalid",
		errorCount: 1,
		detail: `unclosed ${open.char.repeat(open.length)} code fence opened on line ${open.line}`,
	};
}

const SVELTE_SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

/** Synthetic path routing embedded script bodies to the TypeScript grammar. */
const SVELTE_SCRIPT_PATH = "svelte-embedded-script.ts";

/**
 * The Svelte compiler is not a dependency, but `<script>` bodies are plain TS —
 * runes are ordinary calls — so `treeSitterSyntaxValidator` handles them.
 * Markup stays unchecked, and a file with no `<script>` reports unsupported so
 * a markup-only file is never implied to have passed.
 */
function validateSvelte(text: string): SyntaxValidationResult {
	let total = 0;
	let blocks = 0;
	for (const match of text.matchAll(SVELTE_SCRIPT)) {
		blocks++;
		const result = treeSitterSyntaxValidator({ path: SVELTE_SCRIPT_PATH, text: match[1] });
		if (result.kind === "invalid") total += result.errorCount;
		else if (result.kind !== "valid") return result;
	}
	if (blocks === 0) return { kind: "unsupported_language" };
	if (total === 0) return { kind: "valid", errorCount: 0 };
	return { kind: "invalid", errorCount: total, detail: `${total} error(s) inside <script>` };
}

const VALIDATORS: Record<string, (text: string) => SyntaxValidationResult> = {
	json: validateJson,
	yaml: validateYaml,
	yml: validateYaml,
	md: validateMarkdownFences,
	markdown: validateMarkdownFences,
	svelte: validateSvelte,
};

/** Formats validated here rather than by a tree-sitter grammar. */
export const formatSyntaxValidator: SyntaxValidator = ({ path, text }) => {
	const validate = VALIDATORS[extensionOf(path)];
	return validate === undefined ? { kind: "unsupported_language" } : validate(text);
};

/** `preloadBlockLanguages` infers grammars from the section path, which never names `.svelte`'s TypeScript bodies. */
export function embeddedGrammarPaths(path: string): string[] {
	return extensionOf(path) === "svelte" ? [SVELTE_SCRIPT_PATH] : [];
}

/** First validator that recognises the file wins; `unsupported_language` means none claimed it. */
export function composeSyntaxValidators(...validators: readonly SyntaxValidator[]): SyntaxValidator {
	return (request) => {
		let last: SyntaxValidationResult = { kind: "unsupported_language" };
		for (const validate of validators) {
			last = validate(request);
			if (last.kind !== "unsupported_language") return last;
		}
		return last;
	};
}

/** Every format guard the edit path knows: tree-sitter first, then the rest. */
export const fileSyntaxValidator: SyntaxValidator = composeSyntaxValidators(
	treeSitterSyntaxValidator,
	formatSyntaxValidator,
);
