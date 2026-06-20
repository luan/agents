/**
 * AST tool engine choice: use the installed ast-grep CLI (`sg`) instead of
 * OMP's native ast-grep-core addon. This repo does not ship `@oh-my-pi/pi-natives`
 * or an ast-grep JS binding, while `sg` is already available in the local tool
 * search path. The tradeoff is process-spawn overhead and a smaller rewrite
 * surface; the benefit is no native packaging work and real ast-grep
 * metavariable matching today. `ast_edit` uses CLI matches plus local rewrite
 * application so dry-run previews and fresh hashline tags remain under fileops.
 */
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCommand as runExternalCommand } from "../shared/command-runner.ts";
import { recordHashlineSnapshot, SNAPSHOT_MAX_BYTES } from "./hashline/anchors.js";
import { formatHashlineHeader } from "./hashline/format.ts";
import type { InMemorySnapshotStore } from "./hashline/snapshots.ts";

const AST_TOOL_SEARCH_PATHS = [
	"~/.local/bin",
	"~/.cargo/bin",
	"~/.zerobrew/bin",
	"/opt/zerobrew/bin",
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
];

const AST_MATCH_LIMIT = 200;

const astGrepSchema = Type.Object({
	pattern: Type.String({ description: "ast-grep structural pattern, e.g. `foo($X)`" }),
	path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
	lang: Type.Optional(Type.String({ description: "ast-grep language for the pattern, e.g. ts, js, rust, python" })),
	limit: Type.Optional(Type.Number({ description: "Maximum matches to return (default 200)" })),
});

const astEditSchema = Type.Object({
	pattern: Type.String({ description: "ast-grep structural pattern to rewrite" }),
	rewrite: Type.String({ description: "Replacement template, with metavariables like `$X`" }),
	path: Type.String({ description: "File or directory to rewrite" }),
	lang: Type.Optional(Type.String({ description: "ast-grep language for the pattern, e.g. ts, js, rust, python" })),
	apply: Type.Optional(Type.Boolean({ description: "Write changes. Defaults to false for dry-run preview." })),
	limit: Type.Optional(Type.Number({ description: "Maximum matches to rewrite/preview (default 200)" })),
});

type ToolTextResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

type SnapshotResolver = (ctx: Pick<ExtensionContext, "sessionManager"> | undefined) => InMemorySnapshotStore;

type AstMatch = {
	text: string;
	file: string;
	range: {
		byteOffset: { start: number; end: number };
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	metaVariables?: {
		single?: Record<string, { text: string }>;
	};
};

function absolutePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function textLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function parseAstMatches(stdout: string): AstMatch[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	const parsed = JSON.parse(trimmed) as unknown;
	if (!Array.isArray(parsed)) throw new Error("ast-grep returned unexpected JSON output");
	return parsed as AstMatch[];
}

function astGrepArgs(input: { pattern: string; path?: string; lang?: string }, cwd: string): string[] {
	const args = ["run", "-p", input.pattern, "--json=compact"];
	if (input.lang) args.push("-l", input.lang);
	args.push(input.path ? absolutePath(cwd, input.path) : ".");
	return args;
}

async function runAstGrep(input: { pattern: string; path?: string; lang?: string }, cwd: string, signal?: AbortSignal) {
	const result = await runExternalCommand("sg", astGrepArgs(input, cwd), cwd, {
		signal,
		allowNonZero: true,
		extraSearchPaths: AST_TOOL_SEARCH_PATHS,
	});
	if (result.exitCode !== 0) {
		throw new Error(`ast-grep failed${result.stderr.trim() ? `:\n${result.stderr.trim()}` : ""}`);
	}
	return { matches: parseAstMatches(result.stdout), stderr: result.stderr.trim() };
}

function groupMatchesByFile(matches: readonly AstMatch[]): Map<string, AstMatch[]> {
	const byFile = new Map<string, AstMatch[]>();
	for (const match of matches) byFile.set(match.file, [...(byFile.get(match.file) ?? []), match]);
	return byFile;
}

function renderMeta(match: AstMatch): string | undefined {
	const single = match.metaVariables?.single ?? {};
	const entries = Object.entries(single);
	if (entries.length === 0) return undefined;
	return `meta: ${entries.map(([name, value]) => `${name}=${JSON.stringify(value.text)}`).join(", ")}`;
}

async function renderAstGrepOutput(
	matches: readonly AstMatch[],
	cwd: string,
	snapshots: InMemorySnapshotStore,
	limit: number,
	parseDiagnostics: string,
): Promise<string> {
	if (matches.length === 0)
		return parseDiagnostics ? `No matches found\n\nDiagnostics:\n${parseDiagnostics}` : "No matches found";
	const sections: string[] = [];
	for (const [file, fileMatches] of groupMatchesByFile(matches.slice(0, limit))) {
		const source = normalizeToLf(await readFile(file, "utf-8"));
		const explicit = [...new Set(fileMatches.map((match) => match.range.start.line + 1))];
		const tag =
			Buffer.byteLength(source, "utf8") <= SNAPSHOT_MAX_BYTES
				? recordHashlineSnapshot(snapshots, file, source, { explicit })
				: undefined;
		const lines = textLines(source);
		const rows = fileMatches.map((match) => {
			const line = match.range.start.line + 1;
			const meta = renderMeta(match);
			return [`${line}:${lines[line - 1] ?? match.text}`, meta].filter(Boolean).join("\n");
		});
		sections.push(
			[tag ? formatHashlineHeader(displayPath(cwd, file), tag) : displayPath(cwd, file), ...rows].join("\n"),
		);
	}
	if (matches.length > limit) sections.push(`… ${matches.length - limit} additional match(es) omitted`);
	if (parseDiagnostics) sections.push(`Diagnostics:\n${parseDiagnostics}`);
	return sections.join("\n\n");
}

function renderRewrite(template: string, match: AstMatch): string {
	const single = match.metaVariables?.single ?? {};
	return template.replace(/\${1,3}([A-Za-z_][A-Za-z0-9_]*)/g, (token, name: string) => {
		const value = single[name]?.text;
		return value === undefined ? token : value;
	});
}

function rewriteSource(source: string, matches: readonly AstMatch[], template: string): string {
	const sourceBytes = Buffer.from(source, "utf8");
	let cursor = 0;
	const out: string[] = [];
	for (const match of [...matches].sort((left, right) => left.range.byteOffset.start - right.range.byteOffset.start)) {
		const { start, end } = match.range.byteOffset;
		if (start < cursor) continue;
		out.push(sourceBytes.subarray(cursor, start).toString("utf8"));
		out.push(renderRewrite(template, match));
		cursor = end;
	}
	out.push(sourceBytes.subarray(cursor).toString("utf8"));
	return out.join("");
}

function changedLineCount(before: string, after: string): number {
	const beforeLines = textLines(before);
	const afterLines = textLines(after);
	const total = Math.max(beforeLines.length, afterLines.length);
	let changed = 0;
	for (let index = 0; index < total; index++) if ((beforeLines[index] ?? "") !== (afterLines[index] ?? "")) changed++;
	return changed;
}

async function executeAstGrep(
	params: { pattern: string; path?: string; lang?: string; limit?: number },
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	snapshotsForContext: SnapshotResolver,
	signal?: AbortSignal,
): Promise<ToolTextResult> {
	const limit = Math.max(1, Math.min(AST_MATCH_LIMIT, Math.trunc(params.limit ?? AST_MATCH_LIMIT)));
	const { matches, stderr } = await runAstGrep(params, ctx.cwd, signal);
	const text = await renderAstGrepOutput(matches, ctx.cwd, snapshotsForContext(ctx), limit, stderr);
	return { content: [{ type: "text", text }], details: { matches: matches.length, diagnostics: stderr || undefined } };
}

async function executeAstEdit(
	params: { pattern: string; rewrite: string; path: string; lang?: string; apply?: boolean; limit?: number },
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	snapshotsForContext: SnapshotResolver,
	signal?: AbortSignal,
): Promise<ToolTextResult> {
	const limit = Math.max(1, Math.min(AST_MATCH_LIMIT, Math.trunc(params.limit ?? AST_MATCH_LIMIT)));
	const { matches, stderr } = await runAstGrep(params, ctx.cwd, signal);
	const limited = matches.slice(0, limit);
	if (limited.length === 0)
		return {
			content: [{ type: "text", text: stderr ? `No matches found\n\nDiagnostics:\n${stderr}` : "No matches found" }],
		};
	const snapshots = snapshotsForContext(ctx);
	const sections: string[] = [];
	for (const [file, fileMatches] of groupMatchesByFile(limited)) {
		const before = normalizeToLf(await readFile(file, "utf-8"));
		const after = rewriteSource(before, fileMatches, params.rewrite);
		const changed = changedLineCount(before, after);
		if (params.apply && after !== before) {
			await withFileMutationQueue(file, () => writeFile(file, after, "utf-8"));
			const tag = recordHashlineSnapshot(snapshots, file, after);
			sections.push(
				`${formatHashlineHeader(displayPath(ctx.cwd, file), tag)}\nApplied ${fileMatches.length} rewrite(s), ${changed} changed line(s).`,
			);
		} else {
			sections.push(
				`${displayPath(ctx.cwd, file)}\nPreview: ${fileMatches.length} rewrite(s), ${changed} changed line(s). Re-run with apply=true to write.`,
			);
		}
	}
	if (matches.length > limit) sections.push(`… ${matches.length - limit} additional match(es) omitted`);
	if (stderr) sections.push(`Diagnostics:\n${stderr}`);
	return {
		content: [{ type: "text", text: sections.join("\n\n") }],
		details: { matches: matches.length, applied: params.apply === true },
	};
}

export function registerAstTools(pi: ExtensionAPI, snapshotsForContext: SnapshotResolver): void {
	pi.registerTool({
		name: "ast_grep",
		label: "ast_grep",
		description: "Structural AST search using ast-grep CLI (`sg`). Supports metavariable patterns such as `foo($X)`.",
		parameters: astGrepSchema,
		renderShell: "self",
		renderCall(params) {
			return `ast_grep ${JSON.stringify((params as { pattern?: string }).pattern ?? "")}`;
		},
		renderResult(result) {
			return (result as ToolTextResult).content[0]?.text ?? "";
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeAstGrep(params as any, ctx, snapshotsForContext, signal);
		},
	});

	pi.registerTool({
		name: "ast_edit",
		label: "ast_edit",
		description: "Structural AST rewrite using ast-grep CLI (`sg`). Dry-run by default; set apply=true to write.",
		parameters: astEditSchema,
		renderShell: "self",
		renderCall(params) {
			const input = params as { pattern?: string; apply?: boolean };
			return `ast_edit ${input.apply ? "apply" : "preview"} ${JSON.stringify(input.pattern ?? "")}`;
		},
		renderResult(result) {
			return (result as ToolTextResult).content[0]?.text ?? "";
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeAstEdit(params as any, ctx, snapshotsForContext, signal);
		},
	});
}
