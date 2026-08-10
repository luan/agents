import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createTwoFilesPatch } from "diff";
import { Type } from "typebox";
import { runCommand as runExternalCommand } from "../shared/command-runner.ts";
import { type CardTheme, darkerCardBackgroundAnsi, framedBlock, renderStatusLine } from "../shared/tui/card.ts";
import { EmptyComponent } from "../shared/tui/index.ts";
import {
	buildHighlightedDiffRows,
	type DiffRenderRow,
	EditDiffView,
	highlightCodeRowsSync,
	languageFromPath,
	type RenderTheme,
} from "./diff-render.ts";
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
	const diffs: string[] = [];
	for (const [file, fileMatches] of groupMatchesByFile(limited)) {
		const before = normalizeToLf(await readFile(file, "utf-8"));
		const after = rewriteSource(before, fileMatches, params.rewrite);
		const changed = changedLineCount(before, after);
		if (after !== before) {
			diffs.push(
				createTwoFilesPatch(displayPath(ctx.cwd, file), displayPath(ctx.cwd, file), before, after, "", "", {
					context: 3,
				}),
			);
		}
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
	const diff = diffs.join("\n");
	return {
		content: [{ type: "text", text: sections.join("\n\n") }],
		details: {
			matches: matches.length,
			applied: params.apply === true,
			diff: diff || undefined,
			highlightedDiffRows: diff ? await buildHighlightedDiffRows(diff) : undefined,
		},
	};
}

type AstTheme = CardTheme & RenderTheme;

type AstOutputSection = {
	header: string;
	path: string;
	rows: Array<{ line: number; code: string; meta?: string }>;
};

const EMPTY_VIEW = new EmptyComponent();

function parseAstOutputSections(text: string): AstOutputSection[] {
	const sections: AstOutputSection[] = [];
	for (const block of text.split(/\n{2,}/)) {
		const lines = block.split("\n");
		const header = lines.shift()?.trim();
		if (!header) continue;
		const rows: AstOutputSection["rows"] = [];
		for (const line of lines) {
			const match = /^([1-9]\d*):(.*)$/.exec(line);
			if (match) {
				rows.push({ line: Number(match[1]), code: match[2] ?? "" });
			} else if (line.startsWith("meta:") && rows.length > 0) {
				rows[rows.length - 1]!.meta = line;
			}
		}
		if (rows.length === 0) continue;
		const taggedPath = /^\[(.+?)#[0-9A-Fa-f]{4}\]$/.exec(header)?.[1];
		sections.push({ header, path: taggedPath ?? header, rows });
	}
	return sections;
}

function renderAstSearchLines(text: string, theme: AstTheme, expanded: boolean, failed: boolean): string[] {
	const sections = parseAstOutputSections(text);
	if (sections.length === 0) {
		return text.split("\n").map((line) => theme.fg(failed ? "error" : "toolOutput", line));
	}
	const maxRows = expanded ? Number.POSITIVE_INFINITY : 12;
	const lines: string[] = [];
	let emitted = 0;
	for (const [sectionIndex, section] of sections.entries()) {
		if (emitted >= maxRows) break;
		const visibleRows = section.rows.slice(0, maxRows - emitted);
		const lastSection = sectionIndex === sections.length - 1 || emitted + visibleRows.length >= maxRows;
		const branch = lastSection ? (theme.tree?.last ?? "└─") : (theme.tree?.branch ?? "├─");
		const continuation = lastSection ? "   " : `${theme.tree?.vertical ?? "│"}  `;
		const icon = theme.getLangIcon?.(languageFromPath(section.path));
		lines.push(`${theme.fg("dim", `${branch} ${icon ? `${icon} ` : ""}`)}${theme.fg("accent", section.header)}`);
		const highlighted = highlightCodeRowsSync(
			section.path,
			visibleRows.map((row) => row.code),
		);
		for (const [rowIndex, row] of visibleRows.entries()) {
			const lineNumber = String(row.line).padStart(4, " ");
			lines.push(`${theme.fg("dim", `${continuation}${lineNumber}│`)}${highlighted[rowIndex] ?? row.code}`);
			if (row.meta) lines.push(`${theme.fg("dim", `${continuation}     ${row.meta}`)}`);
			emitted++;
		}
	}
	const totalRows = sections.reduce((count, section) => count + section.rows.length, 0);
	if (emitted < totalRows) lines.push(theme.fg("muted", `... (${totalRows - emitted} more matches)`));
	return lines;
}

type AstRenderContext = {
	args?: { pattern?: string; path?: string; apply?: boolean };
	isError?: boolean;
};

function astHeader(
	theme: AstTheme,
	title: string,
	params: { pattern?: string; path?: string; apply?: boolean },
	status: "pending" | "success" | "error",
	meta?: string[],
): string {
	return renderStatusLine(theme, {
		icon: status,
		title,
		description: params.pattern ? JSON.stringify(params.pattern) : undefined,
		meta: [params.path ?? ".", ...(meta ?? [])],
	});
}

function astResultCard(
	title: string,
	result: ToolTextResult,
	options: { expanded?: boolean },
	theme: AstTheme,
	context: AstRenderContext | undefined,
	body: { lines?: string[]; component?: Component } = {},
) {
	const failed = context?.isError === true;
	const text = result.content[0]?.text ?? "";
	const allLines = text ? text.split("\n") : [];
	const lines = body.lines ?? (options.expanded ? allLines : allLines.slice(0, 12));
	if (!body.lines && lines.length < allLines.length) lines.push(`… ${allLines.length - lines.length} more lines`);
	const matches = typeof result.details?.matches === "number" ? [`${result.details.matches} matches`] : [];
	const backgroundColor = failed ? "toolErrorBg" : "toolPendingBg";
	return framedBlock(theme, {
		header: astHeader(theme, title, context?.args ?? {}, failed ? "error" : "success", matches),
		sections: [
			...(lines.length > 0 ? [{ lines }] : []),
			...(body.component ? [{ label: theme.fg("toolTitle", "Diff"), component: body.component }] : []),
		],
		borderColor: failed ? "error" : "borderMuted",
		backgroundColor,
		backgroundAnsi: darkerCardBackgroundAnsi(theme, backgroundColor),
	});
}

export function registerAstTools(pi: ExtensionAPI, snapshotsForContext: SnapshotResolver): void {
	pi.registerTool({
		name: "ast_grep",
		label: "ast_grep",
		description: "Structural AST search using ast-grep CLI (`sg`). Supports metavariable patterns such as `foo($X)`.",
		parameters: astGrepSchema,
		renderShell: "self",
		renderCall(params, theme, context) {
			if (context?.isPartial === false) return EMPTY_VIEW;
			const input = params as { pattern?: string; path?: string };
			return framedBlock(theme, {
				header: astHeader(theme, "AST search", input, "pending"),
				borderColor: "borderMuted",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, "toolPendingBg"),
			});
		},
		renderResult(result, options, theme, context) {
			const output = result as ToolTextResult;
			const failed = context?.isError === true;
			const lines = renderAstSearchLines(
				output.content[0]?.text ?? "",
				theme as AstTheme,
				options.expanded === true,
				failed,
			);
			return astResultCard("AST search", output, options, theme as AstTheme, context as AstRenderContext, { lines });
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
		renderCall(params, theme, context) {
			if (context?.isPartial === false) return EMPTY_VIEW;
			const input = params as { pattern?: string; path?: string; apply?: boolean };
			return framedBlock(theme, {
				header: astHeader(theme, "AST edit", input, "pending", [input.apply ? "apply" : "preview"]),
				borderColor: "borderMuted",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, "toolPendingBg"),
			});
		},
		renderResult(result, options, theme, context) {
			const output = result as ToolTextResult;
			const diff = typeof output.details?.diff === "string" ? output.details.diff : "";
			const rows = Array.isArray(output.details?.highlightedDiffRows)
				? (output.details.highlightedDiffRows as DiffRenderRow[])
				: undefined;
			const backgroundAnsi = darkerCardBackgroundAnsi(theme, "toolPendingBg");
			const component = diff
				? new EditDiffView(diff, rows, options.expanded === true, theme as RenderTheme, backgroundAnsi)
				: undefined;
			return astResultCard("AST edit", output, options, theme as AstTheme, context as AstRenderContext, {
				component,
			});
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeAstEdit(params as any, ctx, snapshotsForContext, signal);
		},
	});
}
