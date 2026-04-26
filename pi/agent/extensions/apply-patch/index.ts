import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type ExtensionAPI,
	getLanguageFromPath,
	highlightCode,
	keyHint,
} from "@mariozechner/pi-coding-agent";
import { codeToANSI } from "@shikijs/cli";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { BundledLanguage, BundledTheme } from "shiki";
import { Type } from "typebox";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const ANSI_RESET = "\x1b[0m";

const APPLY_PATCH_USAGE_ENTRY = "apply_patch_usage";

const APPLY_PATCH_PROMPT_APPENDIX = `## apply_patch

Use the \`apply_patch\` tool for all file edits. The patch payload format is:

*** Begin Patch
*** Add File: path/to/new-file.txt
+file contents
*** Update File: path/to/existing-file.txt
*** Move to: path/to/new-name.txt
@@
-old line
+new line
*** Delete File: path/to/remove.txt
*** End Patch

Rules:
- Include exactly one Begin Patch / End Patch envelope.
- Prefix all new file contents and added lines with '+'.`;

const applyPatchToolSchema = Type.Object({
	input: Type.String({
		description: "The full apply_patch payload in apply_patch format.",
	}),
});

type ApplyPatchProgressFile = {
	path: string;
	moveTo?: string;
	operation: "add" | "delete" | "update";
	added: number;
	removed: number;
	done?: boolean;
};

type ApplyPatchRenderDetails = {
	stage?: "validate" | "apply" | "done";
	diff?: string;
	highlightedDiffRows?: ParsedDiffLine[];
	filesChanged?: number;
	operations?: number;
	currentFile?: string;
	files?: ApplyPatchProgressFile[];
	fileDiffs?: ApplyPatchProgressFile[];
};

type ToolResult = {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
};

type ThemeLike = {
	fg(color: string, text: string): string;
	bg?(color: "toolSuccessBg" | "toolPendingBg" | "toolErrorBg", text: string): string;
	getBgAnsi?(color: "toolSuccessBg" | "toolPendingBg" | "toolErrorBg"): string;
	bold(text: string): string;
};

type DiffViewMode = "unified" | "side-by-side" | "auto";

type ApplyPatchConfig = {
	diffView: DiffViewMode;
	sideBySideMinWidth: number;
	maxDiffLines: number;
};

const DEFAULT_CONFIG: ApplyPatchConfig = {
	diffView: "auto",
	sideBySideMinWidth: 120,
	maxDiffLines: 160,
};

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

function loadConfig(): ApplyPatchConfig {
	try {
		if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<ApplyPatchConfig>;
		const diffView = parsed.diffView === "unified" || parsed.diffView === "side-by-side" || parsed.diffView === "auto"
			? parsed.diffView
			: DEFAULT_CONFIG.diffView;
		return {
			diffView,
			sideBySideMinWidth: Number.isFinite(parsed.sideBySideMinWidth)
				? Math.max(40, Number(parsed.sideBySideMinWidth))
				: DEFAULT_CONFIG.sideBySideMinWidth,
			maxDiffLines: Number.isFinite(parsed.maxDiffLines)
				? Math.max(1, Number(parsed.maxDiffLines))
				: DEFAULT_CONFIG.maxDiffLines,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

function saveConfig(config: ApplyPatchConfig): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

type DiffLineKind = "add" | "remove" | "context";

type ParsedDiffLine = {
	kind: DiffLineKind;
	oldLine: number | null;
	newLine: number | null;
	content: string;
	path?: string;
	highlightedContent?: string;
};

type SplitDiffRow = {
	left?: ParsedDiffLine;
	right?: ParsedDiffLine;
};

const ADD_ROW_BG = "\x1b[48;2;20;53;31m";
const REMOVE_ROW_BG = "\x1b[48;2;59;29;36m";
const SAFE_MUTED_FG = "\x1b[38;2;139;148;158m";
const BORDER_BAR = "▌";
const SPLIT_MIN_CODE_WIDTH = 60;
const SPLIT_MAX_WRAP_RATIO = 0.2;
const SPLIT_MAX_WRAP_LINES = 8;
const LANGUAGE_ALIASES: Record<string, { inline?: string; shiki?: BundledLanguage }> = {
	svelte: {
		inline: "html",
		shiki: "svelte",
	},
};
const SHIKI_THEME = (process.env.APPLY_PATCH_SHIKI_THEME ?? "github-dark") as BundledTheme;
const SHIKI_MAX_CHARS = 80_000;
const SHIKI_CACHE_LIMIT = 64;
const SHIKI_BACKGROUND_PATTERN = /\x1b\[(?:48;2;\d+;\d+;\d+|48;5;\d+|49)m/g;
const shikiCache = new Map<string, string[]>();

codeToANSI("", "typescript", SHIKI_THEME).catch(() => {});

class ApplyPatchDiffView {
	constructor(
		private label: string,
		private files: ApplyPatchProgressFile[],
		private fallbackBody: string,
		private theme: ThemeLike,
		private config: ApplyPatchConfig,
		private state: "success" | "pending" | "error" = "success",
		private status?: string,
		private diff?: string,
		private expanded = false,
		private rows?: ParsedDiffLine[],
	) {}

	invalidate() {}

	render(width: number): string[] {
		const safeWidth = Math.max(24, width);
		const bgToken = this.state === "error" ? "toolErrorBg" : this.state === "pending" ? "toolPendingBg" : "toolSuccessBg";
		const bgAnsi = this.theme.getBgAnsi?.(bgToken);
		const paintLine = (line: string) => {
			const padded = truncateToWidth(line, safeWidth, "", true);
			if (bgAnsi) {
				return `${bgAnsi}${keepBackgroundAcrossResets(padded, bgAnsi)}${ANSI_RESET}`;
			}
			return this.theme.bg ? this.theme.bg(bgToken, padded) : padded;
		};

		if (hasVisibleText(this.diff)) {
			const diffLines = renderNativeDiff(this.diff, this.rows, this.theme, safeWidth, bgAnsi, this.config, this.expanded);
			return [paintLine(this.renderHeader(safeWidth)), paintLine(""), ...diffLines];
		}

		const bodyLines = this.fallbackBody.split("\n");
		while (bodyLines.length > 0 && bodyLines[0].trim() === "") {
			bodyLines.shift();
		}
		while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
			bodyLines.pop();
		}
		const content = bodyLines.length > 0 ? bodyLines : [this.theme.fg("muted", "(no diff)")];
		return [paintLine(this.renderHeader(safeWidth)), paintLine(""), ...content.map((line) => paintLine(line))];
	}

	private renderHeader(width: number): string {
		const added = this.files.reduce((sum, file) => sum + file.added, 0);
		const removed = this.files.reduce((sum, file) => sum + file.removed, 0);
		const stats = this.files.length > 0
			? ` ${this.theme.fg("muted", "(")}${this.theme.fg("toolDiffAdded", `+${added}`)} ${this.theme.fg("toolDiffRemoved", `-${removed}`)}${this.theme.fg("muted", ")")}`
			: "";
		const verb = this.status ?? (this.state === "error" ? "Patch failed" : this.state === "pending" ? "Patching" : "Patched");
		const marker = this.state === "error" ? "×" : this.state === "pending" ? "◌" : "•";
		const markerColor = this.state === "error" ? "error" : this.state === "pending" ? "warning" : "toolTitle";
		const title = `${this.theme.fg(markerColor, marker)} ${this.theme.fg("toolTitle", this.theme.bold(verb))} ${this.theme.fg("accent", this.label)}${stats}`;
		return truncateToWidth(title, width, "…", true);
	}
}

function sgrResetsBackground(rawParams: string): boolean {
	if (rawParams.trim() === "") return true;
	return rawParams
		.split(";")
		.map((param) => Number.parseInt(param, 10))
		.some((param) => param === 0 || param === 49);
}

function keepBackgroundAcrossResets(text: string, backgroundAnsi: string): string {
	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		if (!sgrResetsBackground(rawParams)) return sequence;
		return `${sequence}${backgroundAnsi}`;
	});
}

function isLowContrastShikiFg(rawParams: string): boolean {
	if (rawParams === "30" || rawParams === "90") return true;
	if (rawParams === "38;5;0" || rawParams === "38;5;8") return true;
	if (!rawParams.startsWith("38;2;")) return false;
	const parts = rawParams.split(";").map(Number);
	if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) return false;
	const [, , red, green, blue] = parts;
	const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
	return luminance < 72;
}

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) =>
		isLowContrastShikiFg(rawParams) ? SAFE_MUTED_FG : sequence,
	);
}

function hasVisibleText(text: string | undefined): text is string {
	return !!text && text.replace(ANSI_PATTERN, "").trim().length > 0;
}

function normalizeLineForDiff(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
}

function highlightedLineMatches(candidate: string | undefined, expected: string): candidate is string {
	if (!candidate) return false;
	return candidate.replace(ANSI_PATTERN, "") === normalizeLineForDiff(expected);
}

function normalizeRepoPath(path: string): string {
	return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

function normalizeDiffHeaderPath(rawPath: string): string | undefined {
	const normalized = rawPath.trim().replace(/^a\//, "").replace(/^b\//, "");
	if (!normalized || normalized === "/dev/null") return undefined;
	return normalizeRepoPath(normalized);
}

function fileExtension(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const extension = extname(path).slice(1).toLowerCase();
	return extension || undefined;
}

function shikiLanguageForPath(path: string | undefined): BundledLanguage | undefined {
	const extension = fileExtension(path);
	try {
		const language = path ? getLanguageFromPath(path) : undefined;
		if (language) return language as BundledLanguage;
	} catch {
		// Fall back to explicit aliases below.
	}
	return extension ? LANGUAGE_ALIASES[extension]?.shiki : undefined;
}

function touchShikiCache(key: string, value: string[]): string[] {
	shikiCache.delete(key);
	shikiCache.set(key, value);
	while (shikiCache.size > SHIKI_CACHE_LIMIT) {
		const oldest = shikiCache.keys().next().value;
		if (oldest === undefined) break;
		shikiCache.delete(oldest);
	}
	return value;
}

async function highlightWithShiki(code: string, language: BundledLanguage): Promise<string[]> {
	if (!code) return [""];
	if (code.length > SHIKI_MAX_CHARS) return code.split("\n");

	const normalized = normalizeLineForDiff(code);
	const cacheKey = `${SHIKI_THEME}\0${language}\0${normalized}`;
	const cached = shikiCache.get(cacheKey);
	if (cached) return touchShikiCache(cacheKey, cached);

	try {
		const ansi = normalizeShikiContrast(
			(await codeToANSI(normalized, language, SHIKI_THEME)).replace(SHIKI_BACKGROUND_PATTERN, ""),
		);
		const lines = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return touchShikiCache(cacheKey, lines);
	} catch {
		return normalized.split("\n");
	}
}

type HighlightedFileSource = {
	path: string;
	language: BundledLanguage;
	content: string;
};

function readNormalizedTextFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
	} catch {
		return undefined;
	}
}

function collectShikiSources(
	cwd: string,
	files: ApplyPatchProgressFile[],
	pathForFile: (file: ApplyPatchProgressFile) => string | undefined,
): HighlightedFileSource[] {
	const sources: HighlightedFileSource[] = [];
	for (const file of files) {
		const targetPath = pathForFile(file);
		if (!targetPath) continue;
		const language = shikiLanguageForPath(targetPath);
		if (!language) continue;
		const content = readNormalizedTextFile(resolve(cwd, targetPath));
		if (content === undefined) continue;
		sources.push({
			path: normalizeRepoPath(targetPath),
			language,
			content,
		});
	}
	return sources;
}

function collectPrePatchShikiSources(cwd: string, files: ApplyPatchProgressFile[]): HighlightedFileSource[] {
	return collectShikiSources(cwd, files, (file) =>
		file.operation === "add" ? undefined : file.path,
	);
}

function collectPostPatchShikiSources(cwd: string, files: ApplyPatchProgressFile[]): HighlightedFileSource[] {
	return collectShikiSources(cwd, files, (file) =>
		file.operation === "delete" ? undefined : file.moveTo ?? file.path,
	);
}

async function highlightSources(
	sources: HighlightedFileSource[],
	signal?: AbortSignal,
): Promise<Map<string, string[]>> {
	const entries = await Promise.all(sources.map(async (source) => {
		if (signal?.aborted) return undefined;
		return [source.path, await highlightWithShiki(source.content, source.language)] as const;
	}));
	return new Map(entries.filter((entry): entry is readonly [string, string[]] => entry !== undefined));
}

function highlightedContentForRow(
	row: ParsedDiffLine,
	oldHighlights: Map<string, string[]>,
	newHighlights: Map<string, string[]>,
): string | undefined {
	const path = row.path ? normalizeRepoPath(row.path) : undefined;
	if (!path) return undefined;
	let candidate: string | undefined;

	if (row.kind === "remove" && row.oldLine !== null) {
		candidate = oldHighlights.get(path)?.[row.oldLine - 1];
		return highlightedLineMatches(candidate, row.content) ? candidate : undefined;
	}

	if (row.newLine !== null) {
		const oldIndex = row.oldLine !== null ? row.oldLine - 1 : row.newLine - 1;
		candidate = newHighlights.get(path)?.[row.newLine - 1] ?? oldHighlights.get(path)?.[oldIndex];
		return highlightedLineMatches(candidate, row.content) ? candidate : undefined;
	}

	return undefined;
}

async function buildHighlightedDiffRows(
	diff: string,
	oldSources: HighlightedFileSource[],
	newSources: HighlightedFileSource[],
	signal?: AbortSignal,
): Promise<ParsedDiffLine[]> {
	const rows = parseUnifiedDiff(diff);
	if (rows.length === 0 || signal?.aborted) return rows;

	const [oldHighlights, newHighlights] = await Promise.all([
		highlightSources(oldSources, signal),
		highlightSources(newSources, signal),
	]);

	if (oldHighlights.size === 0 && newHighlights.size === 0) return rows;

	return rows.map((row) => ({
		...row,
		highlightedContent: highlightedContentForRow(row, oldHighlights, newHighlights),
	}));
}

function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
	const rows: ParsedDiffLine[] = [];
	let currentPath: string | undefined;
	let oldPath: string | undefined;
	let newPath: string | undefined;
	let oldLine: number | null = null;
	let newLine: number | null = null;

	for (const rawLine of diff.replace(/\r\n?/g, "\n").split("\n")) {
		if (rawLine.startsWith("--- ")) {
			oldPath = normalizeDiffHeaderPath(rawLine.slice(4));
			currentPath = oldPath ?? newPath;
			continue;
		}

		if (rawLine.startsWith("+++ ")) {
			newPath = normalizeDiffHeaderPath(rawLine.slice(4));
			currentPath = newPath ?? oldPath;
			continue;
		}

		const hunk = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
		if (hunk) {
			oldLine = Number.parseInt(hunk[1] ?? "0", 10);
			newLine = Number.parseInt(hunk[2] ?? "0", 10);
			continue;
		}

		if (oldLine === null || newLine === null) continue;
		if (rawLine.startsWith("\\")) continue;

		if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
			rows.push({
				kind: "remove",
				oldLine,
				newLine: null,
				content: rawLine.slice(1),
				path: oldPath ?? currentPath,
			});
			oldLine += 1;
			continue;
		}

		if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
			rows.push({
				kind: "add",
				oldLine: null,
				newLine,
				content: rawLine.slice(1),
				path: newPath ?? currentPath,
			});
			newLine += 1;
			continue;
		}

		if (rawLine.startsWith(" ")) {
			rows.push({
				kind: "context",
				oldLine,
				newLine,
				content: rawLine.slice(1),
				path: newPath ?? oldPath ?? currentPath,
			});
			oldLine += 1;
			newLine += 1;
		}
	}

	return rows;
}

function languageForPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const extension = fileExtension(path);
	try {
		return getLanguageFromPath(path) ?? (extension ? LANGUAGE_ALIASES[extension]?.inline : undefined);
	} catch {
		return extension ? LANGUAGE_ALIASES[extension]?.inline : undefined;
	}
}


function highlightDiffContent(content: string, path: string | undefined): string {
	const normalized = content.replace(/\t/g, "  ");
	const language = languageForPath(path);
	if (!language || normalized.length === 0) return normalized;
	try {
		return highlightCode(normalized, language)[0] ?? normalized;
	} catch {
		return normalized;
	}
}

function formatDiffLineNumber(value: number | null, width: number): string {
	return value === null ? " ".repeat(width) : String(value).padStart(width, " ");
}

function rowBackground(kind: DiffLineKind): string | undefined {
	if (kind === "add") return ADD_ROW_BG;
	if (kind === "remove") return REMOVE_ROW_BG;
	return undefined;
}

function paintDiffRow(line: string, width: number, background: string | undefined): string {
	const padded = truncateToWidth(line, width, "", true);
	if (!background) return padded;
	return `${background}${keepBackgroundAcrossResets(padded, background)}${ANSI_RESET}`;
}

function paintDiffSegment(line: string, width: number, background: string | undefined): string {
	return paintDiffRow(line, width, background);
}

function diffLineNumberWidth(rows: ParsedDiffLine[]): number {
	const maxLineNumber = rows.reduce(
		(max, row) => Math.max(max, row.oldLine ?? 0, row.newLine ?? 0),
		0,
	);
	return Math.max(2, String(maxLineNumber).length);
}

function diffWrapRows(width: number): number {
	if (width >= 180) return 3;
	if (width >= 120) return 2;
	return 1;
}

function wrapDiffContent(content: string, width: number, maxRows: number): string[] {
	if (width <= 0) return [""];
	const wrapped = content.length === 0 ? [""] : wrapTextWithAnsi(content, width);
	if (wrapped.length <= maxRows) {
		return wrapped.map((line) => truncateToWidth(line, width, "", true));
	}
	return wrapped.slice(0, maxRows).map((line, index) =>
		truncateToWidth(line, width, index === maxRows - 1 ? "…" : "", true)
	);
}

function diffContentForRow(row: ParsedDiffLine): string {
	return row.highlightedContent ?? highlightDiffContent(row.content, row.path);
}

function stripedDiffFill(width: number, theme: ThemeLike): string {
	return truncateToWidth(theme.fg("dim", "╱".repeat(Math.max(width, 1))), width, "", true);
}

// Adapted from buddingnewinsights/pi-diff (MIT): prefer split diffs only when
// each side still has enough code width to be readable.
function shouldUseSideBySideDiff(rows: ParsedDiffLine[], width: number, config: ApplyPatchConfig): boolean {
	if (config.diffView === "unified") return false;
	if (config.diffView === "side-by-side") return true;
	const hasRemovals = rows.some((row) => row.kind === "remove");
	const hasAdditions = rows.some((row) => row.kind === "add");
	if (!hasRemovals || !hasAdditions) return false;
	const splitRows = buildSplitRows(rows);
	const pairedChangeRows = splitRows.filter((row) =>
		row.left?.kind === "remove" && row.right?.kind === "add"
	).length;
	const oneSidedChangeRows = splitRows.filter((row) =>
		(row.left?.kind === "remove" || row.right?.kind === "add") && (!row.left || !row.right)
	).length;
	if (pairedChangeRows === 0) return false;
	if (oneSidedChangeRows > pairedChangeRows * 2) return false;
	if (width < config.sideBySideMinWidth) return false;

	const numberWidth = diffLineNumberWidth(rows);
	const separatorWidth = 1;
	const halfWidth = Math.max(20, Math.floor((width - separatorWidth) / 2));
	const codeWidth = Math.max(8, halfWidth - (numberWidth + 5));
	if (codeWidth < SPLIT_MIN_CODE_WIDTH) return false;

	const sampledRows = rows.slice(0, config.maxDiffLines);
	let contentRows = 0;
	let wrapCandidates = 0;
	for (const row of sampledRows) {
		contentRows += 1;
		if (visibleWidth(row.content.replace(/\t/g, "  ")) > codeWidth) {
			wrapCandidates += 1;
		}
	}

	if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
	if (contentRows > 0 && wrapCandidates / contentRows >= SPLIT_MAX_WRAP_RATIO) return false;
	return true;
}

function buildSplitRows(rows: ParsedDiffLine[]): SplitDiffRow[] {
	const output: SplitDiffRow[] = [];
	let index = 0;

	while (index < rows.length) {
		const row = rows[index];
		if (!row) break;

		if (row.kind === "context") {
			output.push({ left: row, right: row });
			index += 1;
			continue;
		}

		if (row.kind === "add") {
			output.push({ right: row });
			index += 1;
			continue;
		}

		const removed: ParsedDiffLine[] = [];
		while (rows[index]?.kind === "remove") {
			removed.push(rows[index]);
			index += 1;
		}

		const added: ParsedDiffLine[] = [];
		while (rows[index]?.kind === "add") {
			added.push(rows[index]);
			index += 1;
		}

		const pairCount = Math.max(removed.length, added.length);
		for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
			output.push({ left: removed[pairIndex], right: added[pairIndex] });
		}
	}

	return output;
}

function renderUnifiedDiffRows(
	rows: ParsedDiffLine[],
	theme: ThemeLike,
	width: number,
	baseBackground: string | undefined,
): string[] {
	const numberWidth = diffLineNumberWidth(rows);
	const gutterWidth = numberWidth + 5;
	const codeWidth = Math.max(8, width - gutterWidth);
	const wrapLimit = diffWrapRows(width);

	return rows.flatMap((row) => {
		const kindColor = row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : "dim";
		const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
		const lineNumber = row.kind === "remove" ? row.oldLine : row.newLine;
		const background = rowBackground(row.kind) ?? baseBackground;
		const border = row.kind === "context" ? " " : theme.fg(kindColor, BORDER_BAR);
		const prefix = `${border}${theme.fg(kindColor, formatDiffLineNumber(lineNumber, numberWidth))}${theme.fg(kindColor, sign)} ${theme.fg("dim", "│")} `;
		const continuation = `${border}${" ".repeat(numberWidth + 1)} ${theme.fg("dim", "│")} `;
		const bodyLines = wrapDiffContent(diffContentForRow(row), codeWidth, wrapLimit);
		return bodyLines.map((body, index) =>
			paintDiffRow(`${index === 0 ? prefix : continuation}${body}`, width, background)
		);
	});
}

function renderSplitCellRows(
	row: ParsedDiffLine | undefined,
	side: "left" | "right",
	theme: ThemeLike,
	halfWidth: number,
	numberWidth: number,
	baseBackground: string | undefined,
	wrapLimit: number,
): string[] {
	const gutterWidth = numberWidth + 5;
	const codeWidth = Math.max(8, halfWidth - gutterWidth);
	if (!row) {
		const prefix = `${" ".repeat(numberWidth + 2)}${theme.fg("dim", "│")} `;
		return [paintDiffSegment(`${prefix}${stripedDiffFill(codeWidth, theme)}`, halfWidth, baseBackground)];
	}

	const kindColor = row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : "dim";
	const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
	const lineNumber = side === "left" ? row.oldLine : row.newLine;
	const background = rowBackground(row.kind) ?? baseBackground;
	const border = row.kind === "context" ? " " : theme.fg(kindColor, BORDER_BAR);
	const prefix = `${border}${theme.fg(kindColor, formatDiffLineNumber(lineNumber, numberWidth))}${theme.fg(kindColor, sign)} ${theme.fg("dim", "│")} `;
	const continuation = `${border}${" ".repeat(numberWidth + 1)} ${theme.fg("dim", "│")} `;
	const bodyLines = wrapDiffContent(diffContentForRow(row), codeWidth, wrapLimit);
	return bodyLines.map((body, index) =>
		paintDiffSegment(`${index === 0 ? prefix : continuation}${body}`, halfWidth, background)
	);
}

function renderSplitContinuationCell(
	row: ParsedDiffLine | undefined,
	theme: ThemeLike,
	halfWidth: number,
	numberWidth: number,
	baseBackground: string | undefined,
): string {
	const gutterWidth = numberWidth + 5;
	const codeWidth = Math.max(8, halfWidth - gutterWidth);
	if (!row) {
		const prefix = `${" ".repeat(numberWidth + 2)}${theme.fg("dim", "│")} `;
		return paintDiffSegment(`${prefix}${stripedDiffFill(codeWidth, theme)}`, halfWidth, baseBackground);
	}

	const kindColor = row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : "dim";
	const border = row.kind === "context" ? " " : theme.fg(kindColor, BORDER_BAR);
	const continuation = `${border}${" ".repeat(numberWidth + 1)} ${theme.fg("dim", "│")} `;
	const background = rowBackground(row.kind) ?? baseBackground;
	return paintDiffSegment(`${continuation}${" ".repeat(codeWidth)}`, halfWidth, background);
}

function renderSideBySideDiffRows(
	rows: ParsedDiffLine[],
	theme: ThemeLike,
	width: number,
	baseBackground: string | undefined,
): string[] {
	const separator = baseBackground
		? `${baseBackground}${theme.fg("dim", "┊")}${ANSI_RESET}`
		: theme.fg("dim", "┊");
	const separatorWidth = 1;
	const halfWidth = Math.max(20, Math.floor((width - separatorWidth) / 2));
	const numberWidth = diffLineNumberWidth(rows);
	const gutterWidth = numberWidth + 5;
	const wrapLimit = diffWrapRows(width);
	const headerPadding = Math.max(0, gutterWidth - 3);
	const header = [
		paintDiffSegment(`${" ".repeat(headerPadding)}${theme.fg("toolDiffRemoved", "old")}`, halfWidth, baseBackground),
		separator,
		paintDiffSegment(`${" ".repeat(headerPadding)}${theme.fg("toolDiffAdded", "new")}`, halfWidth, baseBackground),
	].join("");
	const rule = [
		paintDiffSegment(theme.fg("dim", "─".repeat(halfWidth)), halfWidth, baseBackground),
		separator,
		paintDiffSegment(theme.fg("dim", "─".repeat(halfWidth)), halfWidth, baseBackground),
	].join("");

	const lines = [header, rule];
	for (const row of buildSplitRows(rows)) {
		const leftLines = renderSplitCellRows(row.left, "left", theme, halfWidth, numberWidth, baseBackground, wrapLimit);
		const rightLines = renderSplitCellRows(row.right, "right", theme, halfWidth, numberWidth, baseBackground, wrapLimit);
		const maxRows = Math.max(leftLines.length, rightLines.length);
		for (let index = 0; index < maxRows; index += 1) {
			lines.push([
				leftLines[index] ?? renderSplitContinuationCell(row.left, theme, halfWidth, numberWidth, baseBackground),
				separator,
				rightLines[index] ?? renderSplitContinuationCell(row.right, theme, halfWidth, numberWidth, baseBackground),
			].join(""));
		}
	}
	return lines;
}

function limitDiffRows(
	rows: string[],
	config: ApplyPatchConfig,
	theme: ThemeLike,
	width: number,
	baseBackground: string | undefined,
	expanded: boolean,
): string[] {
	if (expanded) return rows;
	if (rows.length <= config.maxDiffLines) return rows;
	const shown = rows.slice(0, config.maxDiffLines);
	const remaining = rows.length - shown.length;
	return [
		...shown,
		paintDiffRow(
			theme.fg("muted", `… ${remaining} more diff line${remaining === 1 ? "" : "s"} (`) +
				keyHint("app.tools.expand", "or click to expand") +
				theme.fg("muted", ")"),
			width,
			baseBackground,
		),
	];
}

function renderNativeDiff(
	diff: string,
	rows: ParsedDiffLine[] | undefined,
	theme: ThemeLike,
	width: number,
	baseBackground: string | undefined,
	config: ApplyPatchConfig,
	expanded: boolean,
): string[] {
	const diffRows = rows ?? parseUnifiedDiff(diff);
	if (diffRows.length === 0) return [];
	const rendered = shouldUseSideBySideDiff(diffRows, width, config)
		? renderSideBySideDiffRows(diffRows, theme, width, baseBackground)
		: renderUnifiedDiffRows(diffRows, theme, width, baseBackground);
	return limitDiffRows(rendered, config, theme, width, baseBackground, expanded);
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function patchInputKey(input: string): string {
	return input.replace(/\r\n?/g, "\n").trimEnd();
}

function formatTarget(
	file: Pick<ApplyPatchProgressFile, "path" | "moveTo">,
): string {
	return file.moveTo ? `${file.path} -> ${file.moveTo}` : file.path;
}

function operationCode(
	operation: ApplyPatchProgressFile["operation"],
	moveTo?: string,
): string {
	if (moveTo) return "R";
	if (operation === "add") return "A";
	if (operation === "delete") return "D";
	return "U";
}

function formatCounterLine(
	theme: {
		fg(color: string, text: string): string;
		bold(text: string): string;
	},
	file: ApplyPatchProgressFile,
	options?: { currentFile?: string; showDone?: boolean; includePath?: boolean },
): string {
	const includePath = options?.includePath ?? true;
	let line = `${theme.fg("toolDiffAdded", `+${file.added}`)} ${theme.fg("toolDiffRemoved", `-${file.removed}`)} ${theme.fg("warning", operationCode(file.operation, file.moveTo))}`;
	if (includePath) {
		line += ` ${theme.fg("accent", formatTarget(file))}`;
	}
	if (options?.showDone && file.done) {
		line += theme.fg("muted", " ✓");
	} else if (options?.currentFile && options.currentFile === file.path) {
		line += theme.fg("warning", " ← applying");
	}
	return line;
}

function renderPatchSummary(
	theme: ThemeLike,
	files: ApplyPatchProgressFile[],
	count: number,
	options?: { currentFile?: string; showDone?: boolean },
): string {
	const title = theme.fg("toolTitle", theme.bold("apply_patch"));
	if (files.length === 1) {
		return `${title} ${formatCounterLine(theme, files[0], options)}`;
	}

	let text = title;
	text += theme.fg("muted", ` (${count} file${count === 1 ? "" : "s"})`);
	if (files.length > 0) {
		text += `\n${files.map((file) => formatCounterLine(theme, file, options)).join("\n")}`;
	}
	return text;
}

function renderApplyPatchBox(
	theme: ThemeLike,
	diff: string | undefined,
	files: ApplyPatchProgressFile[],
	count: number,
	config: ApplyPatchConfig,
	state: "success" | "pending" | "error" = "success",
	status?: string,
	expanded = false,
	rows?: ParsedDiffLine[],
): ApplyPatchDiffView {
	const target = files.length === 1 ? formatTarget(files[0]) : `${count} files`;
	const summary = renderPatchSummary(theme, files, count, { showDone: true });
	return new ApplyPatchDiffView(target, files, summary, theme, config, state, status, diff, expanded, rows);
}

function parsePatchInputProgress(input: string): {
	totalOperations: number;
	files: ApplyPatchProgressFile[];
} {
	const files: ApplyPatchProgressFile[] = [];
	const lines = input.replace(/\r\n?/g, "\n").split("\n");
	let current: ApplyPatchProgressFile | undefined;
	let inPatch = false;

	const flush = () => {
		if (!current) return;
		files.push(current);
		current = undefined;
	};

	for (const line of lines) {
		if (line === "*** Begin Patch") {
			inPatch = true;
			continue;
		}
		if (line === "*** End Patch") {
			flush();
			break;
		}
		if (!inPatch) continue;

		if (line.startsWith("*** Add File: ")) {
			flush();
			current = {
				path: line.slice("*** Add File: ".length).trim(),
				operation: "add",
				added: 0,
				removed: 0,
			};
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			flush();
			current = {
				path: line.slice("*** Delete File: ".length).trim(),
				operation: "delete",
				added: 0,
				removed: 0,
			};
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			flush();
			current = {
				path: line.slice("*** Update File: ".length).trim(),
				operation: "update",
				added: 0,
				removed: 0,
			};
			continue;
		}
		if (line.startsWith("*** Move to: ")) {
			if (current) current.moveTo = line.slice("*** Move to: ".length).trim();
			continue;
		}

		if (!current) continue;
		if (current.operation === "delete") continue;
		if (current.operation === "add") {
			if (line.startsWith("+")) current.added += 1;
			continue;
		}

		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) current.added += 1;
		if (line.startsWith("-")) current.removed += 1;
	}

	flush();
	return { totalOperations: files.length, files };
}

function parseApplyPatchSummary(stdout: string): number {
	return stdout
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^(?:A|M|D|R)\s+/.test(line)).length;
}

function trimOutput(text: string): string {
	return text.trim();
}

function errorResult(
	message: string,
	details: Record<string, unknown> = {},
): ToolResult {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: { error: true, message, ...details },
	};
}

function makeResult(
	command: string,
	cwd: string,
	stdout: string,
	stderr: string,
	details: Record<string, unknown>,
): ToolResult {
	const text = trimOutput(stdout) || trimOutput(stderr) || "(no output)";
	return {
		content: [{ type: "text", text }],
		details: { command, cwd, stdout, stderr, ...details },
	};
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	input?: string,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdinError: NodeJS.ErrnoException | undefined;
		const resolveOnce = (value: { stdout: string; stderr: string }) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		child.stdin.on("error", (error) => {
			stdinError = error as NodeJS.ErrnoException;
			if (stdinError.code === "EPIPE" || stdinError.code === "ERR_STREAM_DESTROYED") {
				return;
			}
			rejectOnce(stdinError);
		});
		child.on("error", (error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				rejectOnce(new Error(`${command} not found on PATH`));
				return;
			}
			rejectOnce(error instanceof Error ? error : new Error(String(error)));
		});

		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });

		if (input === undefined) {
			child.stdin.end();
		} else {
			child.stdin.end(input);
		}

		child.on("close", (exitCode) => {
			signal?.removeEventListener("abort", onAbort);
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (exitCode === 0) {
				resolveOnce({ stdout, stderr });
				return;
			}
			const stdinMessage = stdinError ? `: ${stdinError.message}` : "";
			rejectOnce(
				new Error(
					`${command} ${args.join(" ")} failed with exit code ${exitCode ?? 1}${trimOutput(stderr) ? `: ${trimOutput(stderr)}` : stdinMessage}`,
				),
			);
		});
	});
}

function runApplyPatch(
	cwd: string,
	input: string,
	dryRun: boolean,
	signal?: AbortSignal,
) {
	const args = ["tool", "apply-patch", "--cwd", cwd];
	if (dryRun) args.push("--dry-run");
	return runCommand("ct", args, cwd, signal, input);
}

function enforceToolPolicy(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	const next = active.filter(
		(toolName) => toolName !== "edit" && toolName !== "write",
	);

	if (!next.includes("apply_patch")) {
		next.push("apply_patch");
	}

	if (!arraysEqual(active, next)) {
		pi.setActiveTools(next);
	}
}

function normalizeDiffView(value: string): DiffViewMode | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "u" || normalized === "unified") return "unified";
	if (
		normalized === "sbs" ||
		normalized === "side" ||
		normalized === "split" ||
		normalized === "side-by-side"
	) {
		return "side-by-side";
	}
	if (normalized === "a" || normalized === "auto") return "auto";
	return undefined;
}

function formatConfig(config: ApplyPatchConfig): string {
	return `apply_patch diff: ${config.diffView} (side-by-side ≥ ${config.sideBySideMinWidth} cols, max ${config.maxDiffLines} lines)`;
}

export default function applyPatchExtension(pi: ExtensionAPI) {
	let config = loadConfig();
	const executingPatchInputs = new Set<string>();
	const completedPatchInputs = new Set<string>();

	const resetSessionState = () => {
		executingPatchInputs.clear();
		completedPatchInputs.clear();
		enforceToolPolicy(pi);
	};

	pi.on("session_start", resetSessionState);
	pi.on("session_tree", resetSessionState);
	pi.on("model_select", () => {
		enforceToolPolicy(pi);
	});

	pi.on("before_agent_start", (event) => {
		enforceToolPolicy(pi);
		if (event.systemPrompt.includes("## apply_patch")) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${APPLY_PATCH_PROMPT_APPENDIX}`,
		};
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: "edit and write are disabled. Use apply_patch instead.",
			};
		}
	});

	pi.registerCommand("apply-patch-diff", {
		description: "Configure apply_patch diff rendering: auto, unified, or side-by-side",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "auto", label: "auto" },
				{ value: "unified", label: "unified" },
				{ value: "side-by-side", label: "side-by-side" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				ctx.ui.notify(formatConfig(config), "info");
				return;
			}

			const diffView = normalizeDiffView(parts[0]);
			if (!diffView) {
				ctx.ui.notify("Usage: /apply-patch-diff [auto|unified|side-by-side] [sideBySideMinWidth] [maxDiffLines]", "error");
				return;
			}

			const next = { ...config, diffView };
			if (parts[1]) {
				const width = Number.parseInt(parts[1], 10);
				if (!Number.isFinite(width) || width < 40) {
					ctx.ui.notify("sideBySideMinWidth must be at least 40.", "error");
					return;
				}
				next.sideBySideMinWidth = width;
			}
			if (parts[2]) {
				const maxLines = Number.parseInt(parts[2], 10);
				if (!Number.isFinite(maxLines) || maxLines < 1) {
					ctx.ui.notify("maxDiffLines must be at least 1.", "error");
					return;
				}
				next.maxDiffLines = maxLines;
			}

			config = next;
			saveConfig(config);
			ctx.ui.notify(formatConfig(config), "info");
		},
	});

	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: "Edit files using the apply_patch format.",
		promptSnippet: "Edit files using the apply_patch format.",
		promptGuidelines: ["Use apply_patch for every file edit."],
		parameters: applyPatchToolSchema,
		renderShell: "self",
		executionMode: "sequential",
		renderCall(args, theme) {
			const input = typeof args?.input === "string" ? args.input : "";
			const inputKey = patchInputKey(input);
			if (
				inputKey &&
				(executingPatchInputs.has(inputKey) ||
					completedPatchInputs.has(inputKey))
			) {
				return new Text("", 0, 0);
			}

			const progress = parsePatchInputProgress(input);
			let text = theme.fg("toolTitle", theme.bold("apply_patch"));
			if (progress.totalOperations > 0) {
				text += theme.fg(
					"muted",
					` (${progress.totalOperations} file${progress.totalOperations === 1 ? "" : "s"})`,
				);
			}
			if (progress.files.length > 0) {
				text += `\n${progress.files.map((file) => formatCounterLine(theme, file)).join("\n")}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ApplyPatchRenderDetails | undefined;
			const textBlock = result.content.find((block) => block.type === "text");
			const baseText = textBlock?.type === "text" ? textBlock.text : "";
			const files = details?.fileDiffs ?? details?.files ?? [];
			const count = details?.filesChanged ?? details?.operations ?? files.length;
			const highlightedRows = details?.highlightedDiffRows;

			if (isPartial) {
				if (details?.stage === "validate") {
					return new ApplyPatchDiffView(
						"patch",
						files,
						theme.fg("warning", "Validating patch..."),
						theme,
						config,
						"pending",
						"Validating",
					);
				}
				if (details?.stage === "apply") {
					if (count > 0) {
						return renderApplyPatchBox(
							theme,
							details.diff,
							files,
							count,
							config,
							"pending",
							"Patching",
							expanded,
						);
					}
					return new ApplyPatchDiffView(
						"patch",
						files,
						theme.fg("warning", "Applying patch..."),
						theme,
						config,
						"pending",
						"Patching",
					);
				}
				return new ApplyPatchDiffView(
					"patch",
					files,
					theme.fg("warning", baseText || "Applying patch..."),
					theme,
					config,
					"pending",
					"Patching",
				);
			}

			if (baseText.startsWith("Error:")) {
				return new ApplyPatchDiffView(
					"patch",
					files,
					theme.fg("error", baseText),
					theme,
					config,
					"error",
					"Patch failed",
				);
			}

			if (details?.diff && details.diff.length > 0) {
				if (count > 0) {
					return renderApplyPatchBox(
						theme,
						details.diff,
						files,
						count,
						config,
						"success",
						undefined,
						expanded,
						highlightedRows,
					);
				}
				return renderApplyPatchBox(
					theme,
					details.diff,
					files,
					0,
					config,
					"success",
					undefined,
					expanded,
					highlightedRows,
				);
			}

			if (baseText) {
				return new ApplyPatchDiffView("patch", files, baseText, theme, config);
			}

			return new ApplyPatchDiffView(
				"patch",
				files,
				theme.fg("muted", "(no output)"),
				theme,
				config,
			);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			enforceToolPolicy(pi);

			const input = typeof params.input === "string" ? params.input : "";
			const inputKey = patchInputKey(input);
			executingPatchInputs.add(inputKey);
			completedPatchInputs.delete(inputKey);

			try {
				if (signal?.aborted) {
					return errorResult("apply_patch aborted before validation.");
				}

				const progress = parsePatchInputProgress(input);
				onUpdate?.({
					content: [
						{ type: "text", text: "Validating apply_patch payload..." },
					],
					details: {
						stage: "validate",
						operations: progress.totalOperations,
						files: progress.files,
					},
				});

				const dryRun = await runApplyPatch(ctx.cwd, input, true, signal).catch(
					(error: unknown) => {
						const message =
							error instanceof Error ? error.message : String(error);
						return { error: message } as const;
					},
				);
				if ("error" in dryRun) {
					return errorResult(dryRun.error, { stage: "validate" });
				}

				if (signal?.aborted) {
					return errorResult("apply_patch aborted before applying changes.");
				}

				const prePatchShikiSources = collectPrePatchShikiSources(ctx.cwd, progress.files);

				onUpdate?.({
					content: [{ type: "text", text: "Applying patch..." }],
					details: {
						stage: "apply",
						operations: progress.totalOperations,
						files: progress.files,
						diff: dryRun.stdout,
					},
				});

				const applied = await runApplyPatch(
					ctx.cwd,
					input,
					false,
					signal,
				).catch((error: unknown) => {
					const message =
						error instanceof Error ? error.message : String(error);
					return { error: message } as const;
				});
				if ("error" in applied) {
					return errorResult(applied.error, {
						stage: "apply",
						diff: dryRun.stdout,
					});
				}

				const filesChanged = parseApplyPatchSummary(applied.stdout);
				const diff = dryRun.stdout.trim();
				const highlightedDiffRows = diff.length > 0
					? await buildHighlightedDiffRows(
						diff,
						prePatchShikiSources,
						collectPostPatchShikiSources(ctx.cwd, progress.files),
						signal,
					)
					: [];
				pi.appendEntry(APPLY_PATCH_USAGE_ENTRY, {
					used: true,
					modelId: ctx.model?.id,
					timestamp: Date.now(),
				});

				for (const file of progress.files) {
					const targets = file.moveTo
						? [
							{ path: resolve(ctx.cwd, file.path), operation: "delete" },
							{ path: resolve(ctx.cwd, file.moveTo), operation: "add" },
						]
						: [{ path: resolve(ctx.cwd, file.path), operation: file.operation }];
					for (const target of targets) {
						pi.events.emit("apply-patch:file-modified", target);
						pi.events.emit("context-guard:file-modified", { path: target.path });
					}
				}

				return makeResult(
					"ct tool apply-patch",
					ctx.cwd,
					applied.stdout,
					applied.stderr,
					{
						filesChanged,
						operations: progress.totalOperations,
						diff,
						highlightedDiffRows,
						fileDiffs: progress.files,
					},
				);
			} finally {
				executingPatchInputs.delete(inputKey);
				completedPatchInputs.add(inputKey);
			}
		},
	} as any);
}
