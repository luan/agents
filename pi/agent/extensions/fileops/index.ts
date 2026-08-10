import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createFindToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type ExtensionAPI,
	type ExtensionContext,
	keyHint,
	type ToolRenderContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, type Text } from "@earendil-works/pi-tui";
import { createTwoFilesPatch, diffChars } from "diff";
import { Type } from "typebox";
import { resolveCommand, runCommand as runExternalCommand } from "../shared/command-runner.ts";
import {
	readAction,
	registerExplorationEventHandlers,
	registerExplorationTool,
	renderExplorationCall,
} from "../shared/exploration-rendering.ts";
import { readPreviewImageFromPath } from "../shared/image-preview.ts";
import { KittyVirtualImage } from "../shared/kitty-virtual-image.ts";
import { detachToolResultImages, registerToolResultImageRestore } from "../shared/tool-result-images.ts";
import {
	EmptyComponent,
	keepBackgroundAcrossResets,
	markLiveTurnStarted,
	RenderedLineCache,
	runningCellElapsedMs,
	runningFrame,
	sharedAnimationRenderAllowed,
	shouldAnimateRunningCell,
	textComponent,
} from "../shared/tui";
import { type CardBackgroundColor, darkerCardBackgroundAnsi, framedBlock } from "../shared/tui/card.ts";
import { registerAstTools } from "./ast-tools.ts";
import { buildLineEntriesWithBlockContext } from "./block-context.ts";
import {
	preloadBlockLanguages,
	summarizeCodeStructure,
	treeSitterBlockResolver,
	treeSitterSyntaxValidator,
} from "./block-resolver.ts";
import {
	buildHighlightedDiffRows,
	type DiffRenderRow,
	type DiffSectionHeaderRenderer,
	EditDiffView,
	highlightCodeRows,
	highlightCodeRowsSync,
	highlightSearchMatches,
	languageFromPath,
	type RenderTheme,
} from "./diff-render.ts";
import {
	FALLBACK_HASHLINE_SNAPSHOT_SESSION_ID,
	hashlineSnapshotStoreForSession,
	recordHashlineFileSnapshot,
	recordHashlineSnapshot,
	SNAPSHOT_MAX_BYTES,
} from "./hashline/anchors.js";
import { buildCompactDiffPreview, generateNumberedDiff } from "./hashline/diff-preview.ts";
import { formatHashlineHeader } from "./hashline/format.ts";
import { Filesystem, NotFoundError, type WriteResult } from "./hashline/fs.ts";
import { Patch } from "./hashline/input.ts";
import { Patcher } from "./hashline/patcher.ts";
import { stripHashlinePrefixes } from "./hashline/prefixes.ts";
import type { InMemorySnapshotStore } from "./hashline/snapshots.ts";
import type { BlockResolution } from "./hashline/types.ts";

const FILEOPS_TOOL_SEARCH_PATHS = [
	"~/.local/bin",
	"~/.cargo/bin",
	"~/.zerobrew/bin",
	"/opt/zerobrew/bin",
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/pkg/env/global/bin",
	"/usr/bin",
	"/bin",
];

type EditMode = "apply_patch" | "patch" | "hashline" | "replace";
const EDIT_FRAME_MS = 120;
const CONTEXT_PROTECTION_READ_BYTES = 50_000;
const CONTEXT_PROTECTION_READ_LABEL = "Large file read blocked";
const DEFAULT_SEARCH_RESULT_LIMIT = 200;
const DEFAULT_FIND_RESULT_LIMIT = 200;

const READ_SUMMARY_MIN_LINES = 200;
const READ_SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
type EditConfig = {
	mode: EditMode;
	fuzzyMatch: boolean;
	fuzzyThreshold: number;
	allowReplaceAll: boolean;
	autoDropPureInsertDuplicates: boolean;
};

type ReplaceEntry = {
	oldText?: string;
	newText?: string;
	old_text?: string;
	new_text?: string;
	all?: boolean;
};

type PatchEntry = {
	op: "create" | "delete" | "update";
	diff?: string;
	rename?: string;
};

type EditInput = {
	input?: string;
	path?: string;
	edits?: Array<ReplaceEntry | PatchEntry> | string;
	oldText?: string;
	newText?: string;
	old_text?: string;
	new_text?: string;
	all?: boolean;
};

type NormalizedReplaceEntry = {
	oldText: string;
	newText: string;
	all?: boolean;
};

type NormalizedReplaceInput = {
	path: string;
	edits: NormalizedReplaceEntry[];
};

function largeReadGuidance(path: string, bytes: number): ToolTextResult {
	return {
		content: [
			{
				type: "text",
				text: [
					`${CONTEXT_PROTECTION_READ_LABEL}: ${path} is ${bytes.toLocaleString()} bytes.`,
					"",
					"Reading the whole file would put all bytes into the conversation.",
					'Use bounded read arguments for edit targeting, for example `ranges: ["120-180"]` or `offset` with `limit`.',
					"For analysis, summarization, filtering, or extraction, use bounded reads and search only the needed ranges.",
				].join("\n"),
			},
		],
		details: { protected: true, bytes },
	};
}

function hasBoundedReadRequest(params: { limit?: number; ranges?: string[] }, ranges: readonly LineRange[]): boolean {
	return ranges.length > 0 || (params.ranges?.length ?? 0) > 0 || params.limit !== undefined;
}

async function maybeBlockLargeWholeFileRead(
	display: string,
	absolute: string,
	params: { limit?: number; ranges?: string[] },
	ranges: readonly LineRange[],
): Promise<ToolTextResult | undefined> {
	if (hasBoundedReadRequest(params, ranges)) return undefined;
	const info = await stat(absolute);
	if (!info.isFile() || info.size <= CONTEXT_PROTECTION_READ_BYTES) return undefined;
	return largeReadGuidance(display, info.size);
}

async function trySummarizeWholeFileRead(
	display: string,
	absolute: string,
	params: { limit?: number; ranges?: string[]; raw?: boolean },
	ranges: readonly LineRange[],
	snapshots: InMemorySnapshotStore,
): Promise<ToolTextResult | undefined> {
	if (params.raw || hasBoundedReadRequest(params, ranges)) return undefined;
	const info = await stat(absolute);
	if (!info.isFile() || info.size > READ_SUMMARY_MAX_BYTES) return undefined;
	const { text: rawText } = stripBom(await readFile(absolute, "utf-8"));
	const text = normalizeToLf(rawText);
	if (text.split("\n").length < READ_SUMMARY_MIN_LINES) return undefined;
	await preloadBlockLanguages([absolute]);
	const summary = summarizeCodeStructure(absolute, text);
	if (!summary) return undefined;
	const explicit = summary.rows.flatMap((row) => (row.kind === "line" ? [row.lineNumber] : []));
	const tag =
		Buffer.byteLength(text, "utf8") <= SNAPSHOT_MAX_BYTES
			? recordHashlineSnapshot(snapshots, absolute, text, { explicit, synthetic: [] })
			: undefined;
	const rows = summary.rows.map((row) => (row.kind === "line" ? `${row.lineNumber}:${row.text}` : "…"));
	const selector = summary.elidedRanges
		.slice(0, 2)
		.map((range) => `${range.startLine}-${range.endLine}`)
		.join(",");
	const footer = `[…${summary.elidedLines} lines elided; re-read needed ranges with ${display}:${selector}]`;
	return {
		content: [
			{
				type: "text",
				text: [...(tag ? [formatHashlineHeader(display, tag)] : []), ...rows, "", footer].join("\n"),
			},
		],
		details: {
			hashlineTag: tag,
			summary: {
				elidedLines: summary.elidedLines,
				elidedSpans: summary.elidedRanges.length,
			},
		},
	};
}

async function detectSupportedReadImageMimeType(absolute: string): Promise<string | undefined> {
	const file = await open(absolute, "r");
	try {
		const buffer = Buffer.alloc(12);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (
			bytesRead >= 8 &&
			buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		) {
			return "image/png";
		}
		if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
		const header = buffer.subarray(0, Math.min(bytesRead, 12)).toString("ascii");
		if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
		if (bytesRead >= 12 && header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
		return undefined;
	} finally {
		await file.close();
	}
}

type ToolTextResult = {
	content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
	details?: Record<string, unknown>;
};

type PreviewImageDetails = {
	data: string;
	mimeType: "image/png";
	sourcePath?: string;
};

function previewImageDetails(value: unknown): PreviewImageDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.data !== "string" || candidate.mimeType !== "image/png") return undefined;
	return {
		data: candidate.data,
		mimeType: candidate.mimeType,
		sourcePath: typeof candidate.sourcePath === "string" ? candidate.sourcePath : undefined,
	};
}

type HighlightedSection = {
	path: string;
	rows: string[];
};

const EDIT_MODES: EditMode[] = ["apply_patch", "patch", "hashline", "replace"];
const DEFAULT_CONFIG: EditConfig = {
	mode: "apply_patch",
	fuzzyMatch: true,
	fuzzyThreshold: 0.95,
	allowReplaceAll: true,
	autoDropPureInsertDuplicates: false,
};
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");

const readToolSchema = Type.Object({
	path: Type.String({
		description:
			"Path to the file to read (relative or absolute). Supports file:LINE or file:START-END in hashline mode.",
	}),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	ranges: Type.Optional(Type.Array(Type.String({ description: "Line range such as 10, 10-20, or L10-L20" }))),
	raw: Type.Optional(Type.Boolean({ description: "Return raw file contents without hashline headers" })),
});

const searchToolSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(
		Type.String({
			description:
				"Directory or file to search (default: current directory). Single-file paths support :LINE ranges.",
		}),
	),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of regex" })),
	context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return" })),
	ranges: Type.Optional(Type.Array(Type.String({ description: "Single-file line range such as 10 or 10-20" }))),
});

const writeToolSchema = Type.Object({
	path: Type.String({ description: "Path to write" }),
	content: Type.String({ description: "Full file content" }),
	makeExecutable: Type.Optional(Type.Boolean({ description: "Mark written file executable" })),
});

const findToolSchema = Type.Object({
	paths: Type.Optional(Type.Array(Type.String({ description: "Glob including search path" }))),
	pattern: Type.Optional(Type.String({ description: "Legacy glob pattern to match files" })),
	path: Type.Optional(Type.String({ description: "Legacy directory to search in" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files" })),
	gitignore: Type.Optional(Type.Boolean({ description: "Respect gitignore" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export const HASHLINE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "hashline", "grammar.lark"), "utf-8");
const HASHLINE_PROMPT = readFileSync(join(EXTENSION_DIR, "hashline", "prompt.md"), "utf-8");
const APPLY_PATCH_MODE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "apply-patch.lark"), "utf-8");
export const PATCH_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "patch.lark"), "utf-8");
export const REPLACE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "replace.lark"), "utf-8");

export function getEditFreeformToolConfig(): { description: string; grammar: string } {
	const config = loadConfig();
	return { description: modeDescription(config), grammar: modeGrammar(config.mode) };
}

const inputSchema = Type.Object({
	input: Type.String({ description: "Full edit payload in the configured edit grammar." }),
});

function normalizeMode(value: unknown): EditMode | undefined {
	return typeof value === "string" && (EDIT_MODES as string[]).includes(value) ? (value as EditMode) : undefined;
}

function loadConfig(): EditConfig {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<EditConfig>;
		const fuzzyThreshold = Number(parsed.fuzzyThreshold);
		return {
			mode:
				normalizeMode(process.env.PI_FILEOPS_EDIT_VARIANT) ??
				normalizeMode(process.env.PI_EDIT_VARIANT) ??
				normalizeMode(parsed.mode) ??
				DEFAULT_CONFIG.mode,
			fuzzyMatch:
				process.env.PI_EDIT_FUZZY === "1" || process.env.PI_EDIT_FUZZY === "true"
					? true
					: process.env.PI_EDIT_FUZZY === "0" || process.env.PI_EDIT_FUZZY === "false"
						? false
						: typeof parsed.fuzzyMatch === "boolean"
							? parsed.fuzzyMatch
							: DEFAULT_CONFIG.fuzzyMatch,
			fuzzyThreshold: Number.isFinite(Number(process.env.PI_EDIT_FUZZY_THRESHOLD))
				? Math.max(0, Math.min(1, Number(process.env.PI_EDIT_FUZZY_THRESHOLD)))
				: Number.isFinite(fuzzyThreshold)
					? Math.max(0, Math.min(1, fuzzyThreshold))
					: DEFAULT_CONFIG.fuzzyThreshold,
			autoDropPureInsertDuplicates:
				process.env.PI_FILEOPS_HASHLINE_AUTO_DROP_PURE_INSERT_DUPLICATES === "1" ||
				process.env.PI_FILEOPS_HASHLINE_AUTO_DROP_PURE_INSERT_DUPLICATES === "true"
					? true
					: process.env.PI_FILEOPS_HASHLINE_AUTO_DROP_PURE_INSERT_DUPLICATES === "0" ||
							process.env.PI_FILEOPS_HASHLINE_AUTO_DROP_PURE_INSERT_DUPLICATES === "false"
						? false
						: typeof parsed.autoDropPureInsertDuplicates === "boolean"
							? parsed.autoDropPureInsertDuplicates
							: DEFAULT_CONFIG.autoDropPureInsertDuplicates,
			allowReplaceAll:
				typeof parsed.allowReplaceAll === "boolean" ? parsed.allowReplaceAll : DEFAULT_CONFIG.allowReplaceAll,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

async function saveConfig(config: EditConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function modeParameters() {
	return inputSchema;
}

function modeGrammar(mode: EditMode): string {
	switch (mode) {
		case "apply_patch":
			return APPLY_PATCH_MODE_GRAMMAR;
		case "patch":
			return PATCH_GRAMMAR;
		case "hashline":
			return HASHLINE_GRAMMAR;
		case "replace":
			return REPLACE_GRAMMAR;
	}
}

function modeDescription(config: EditConfig): string {
	switch (config.mode) {
		case "apply_patch":
			return "Edit files using the apply_patch envelope format. For Codex this is exposed as a FREEFORM grammar-constrained custom tool.";
		case "patch":
			return "Edit one file using the patch-mode freeform grammar: *** File, then create, update diff hunks, delete, or rename entries.";
		case "hashline":
			// The full teaching doc is the tool description, mirroring oh-my-pi's
			// edit tool — the prompt is the only place the model learns the verb
			// grammar and the re-grounding discipline.
			return HASHLINE_PROMPT;
		case "replace":
			return "Edit one file using the replace-mode freeform grammar: *** File, *** Old, *** New, and optional *** All blocks.";
	}
}

function absolutePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

function textToDisplayLines(text: string): string[] {
	const normalized = normalizeToLf(text);
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

type LineRange = { start: number; end: number };

function parseLineRange(raw: string): LineRange {
	const cleaned = raw
		.trim()
		.replace(/^:/, "")
		.replace(/[Ll](?=\d)/g, "");
	const match = /^([1-9]\d*)(?:\s*(?:-|\.\.)\s*([1-9]\d*))?$/.exec(cleaned);
	if (!match) throw new Error(`Invalid read line selector: ${raw}`);
	const start = Number(match[1]);
	const end = Number(match[2] ?? match[1]);
	if (end < start) throw new Error(`Invalid read line selector ${raw}: end is before start.`);
	return { start, end };
}

function splitReadPathSelector(path: string): { path: string; ranges: LineRange[] } {
	const colon = path.lastIndexOf(":");
	if (colon <= 0) return { path, ranges: [] };
	const suffix = path.slice(colon + 1);
	if (!/^[Ll]?\d+(?:\s*(?:-|\.\.)\s*[Ll]?\d+)?(?:,\s*[Ll]?\d+(?:\s*(?:-|\.\.)\s*[Ll]?\d+)?)*$/.test(suffix)) {
		return { path, ranges: [] };
	}
	return { path: path.slice(0, colon), ranges: suffix.split(",").map(parseLineRange) };
}

function mergeLineRanges(ranges: readonly LineRange[]): LineRange[] {
	const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: LineRange[] = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (previous && range.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function selectedLineEntries(lines: readonly string[], ranges: readonly LineRange[]): Array<[number, string]> {
	const entries: Array<[number, string]> = [];
	for (const range of ranges) {
		if (range.start > lines.length)
			throw new Error(`Line ${range.start} is beyond end of file (${lines.length} lines total)`);
		const end = Math.min(range.end, lines.length);
		for (let line = range.start; line <= end; line++) entries.push([line, lines[line - 1] ?? ""]);
	}
	return entries;
}

function lineNumberInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
	if (ranges.length === 0) return true;
	return ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end);
}

function firstTextContent(result: ToolTextResult): string {
	const content = result.content.find(
		(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
	);
	return content?.text ?? "";
}

function renderText(text: string): Text {
	return textComponent(text);
}

/**
 * `key` reports the live inputs the text producer reads, so the producer itself stays
 * behind the cache. Building the text is the expensive half for search and find results
 * (per-row highlighting), and render() runs on every animation frame.
 */
class DynamicTextView {
	private readonly cache = new RenderedLineCache();

	constructor(
		private readonly text: () => string,
		private readonly shouldRender: () => boolean = () => true,
		private readonly key: () => string = () => "",
	) {}

	invalidate() {
		this.cache.clear();
	}

	render(width: number): string[] {
		if (!this.shouldRender()) return [];
		return this.cache.get(width, this.key(), () => textComponent(this.text()).render(width));
	}
}
const EMPTY_TOOL_CALL_IDS = new Set<string>();

const EMPTY_VIEW = new EmptyComponent();

class BlockTextView {
	private readonly cache = new RenderedLineCache();

	constructor(
		private readonly text: string | ((width: number) => string),
		private readonly theme: RenderTheme,
		private readonly shouldRender: () => boolean = () => true,
		private readonly key: () => string = () => "",
		private readonly backgroundRole: string | null = "toolPendingBg",
	) {}

	invalidate() {
		this.cache.clear();
	}

	render(width: number): string[] {
		if (!this.shouldRender()) return [];
		return this.cache.get(width, this.key(), () => {
			const text = typeof this.text === "function" ? this.text(width) : this.text;
			if (!this.backgroundRole) return textComponent(text).render(width);
			const box = new Box(0, 0, paintToolBackground(this.theme, this.backgroundRole));
			box.addChild(textComponent(text));
			return box.render(width);
		});
	}
}

function toolTextLines(text: string): string[] {
	const lines = text.split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

function shortenDisplayPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/");
	return parts.length > 4 ? `.../${parts.slice(-4).join("/")}` : normalized;
}

function invalidArgText(theme: RenderTheme): string {
	return theme.fg("error", "[invalid]");
}

function treeLast(theme: RenderTheme): string {
	return theme.tree?.last ?? "└─";
}

function treeBranch(theme: RenderTheme): string {
	return theme.tree?.branch ?? "├─";
}

function fileIcon(theme: RenderTheme, filePath?: string): string {
	return theme.getLangIcon?.(languageFromPath(filePath)) ?? "≡";
}

function statusIcon(theme: RenderTheme, icon: "success" | "error" | "warning" | "pending"): string {
	return (
		theme.styledSymbol?.(`status.${icon}`, icon === "pending" ? "muted" : icon) ??
		(icon === "success" ? "✓" : icon === "error" ? "✗" : icon === "warning" ? "!" : "∙")
	);
}

function renderStatusHeader(
	label: string,
	theme: RenderTheme,
	rest = "",
	icon: "success" | "error" | "warning" | "pending" = "success",
): string {
	return `${statusIcon(theme, icon)} ${theme.fg("toolTitle", theme.bold(label))}${rest}`;
}

type StreamingRenderContext = {
	state?: Record<string, unknown>;
	isPartial?: boolean;
	expanded?: boolean;
	invalidate?: () => void;
};

function streamingElapsedMs(context: StreamingRenderContext | undefined, running: boolean): number | undefined {
	return runningCellElapsedMs(context?.state, running);
}

function scheduleStreamingInvalidation(context: StreamingRenderContext | undefined, running: boolean): void {
	const state = context?.state;
	if (!state) return;
	const timer = state.elapsedTimer as ReturnType<typeof setTimeout> | undefined;
	if (!shouldAnimateRunningCell(state, running)) {
		if (timer) {
			clearTimeout(timer);
			state.elapsedTimer = undefined;
		}
		return;
	}
	if (timer || !context?.invalidate) return;
	state.elapsedTimer = setTimeout(() => {
		state.elapsedTimer = undefined;
		if (sharedAnimationRenderAllowed()) context.invalidate?.();
	}, EDIT_FRAME_MS);
	state.elapsedTimer.unref?.();
}

function streamingStatusLine(theme: RenderTheme, context: StreamingRenderContext | undefined, label: string): string {
	return `${theme.fg("dim", runningFrame(streamingElapsedMs(context, true), EDIT_FRAME_MS))} ${theme.fg("dim", `(${label})`)}`;
}

function paintToolBackground(theme: RenderTheme, role: string): ((line: string) => string) | undefined {
	const backgroundAnsi = theme.getBgAnsi?.(role);
	if (backgroundAnsi) return (line) => `${backgroundAnsi}${keepBackgroundAcrossResets(line, backgroundAnsi)}\x1b[0m`;
	return theme.bg ? (line) => theme.bg?.(role, line) ?? line : undefined;
}

function cardBackgroundAnsi(theme: RenderTheme, role: CardBackgroundColor): string | undefined {
	return darkerCardBackgroundAnsi(theme, role);
}

function formatReadLineRange(args: { path?: string; offset?: number; limit?: number; ranges?: string[] }): string {
	if (args.ranges?.length) return `:${args.ranges.join(",")}`;
	const selector = typeof args.path === "string" ? splitReadPathSelector(args.path).ranges : [];
	if (selector.length > 0)
		return `:${selector.map((range) => (range.start === range.end ? range.start : `${range.start}-${range.end}`)).join(",")}`;
	if (args.offset === undefined && args.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return `:${startLine}${endLine ? `-${endLine}` : ""}`;
}

function renderNumberedRows(
	rows: readonly string[],
	theme: RenderTheme,
	limit: number,
	highlightedRows: readonly string[] = [],
): string {
	const output: string[] = [];
	const displayed = rows.slice(0, limit);
	for (const [index, row] of displayed.entries()) {
		const match = /^([ *]?)([1-9]\d*):(.*)$/.exec(row);
		if (!match) {
			output.push(theme.fg("toolOutput", row));
			continue;
		}
		const marker = match[1] === "*" ? "*" : " ";
		const lineNumber = match[2]?.padStart(3, " ") ?? "";
		const fallbackBody = theme.fg("toolOutput", match[3] ?? "");
		const body = highlightedRows[index] ?? fallbackBody;
		output.push(`${theme.fg("dim", `${marker}${lineNumber}│`)}${body}`);
	}
	if (rows.length > limit)
		output.push(
			theme.fg("muted", `... (${rows.length - limit} more lines, `) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
		);
	return output.join("\n");
}

type HashlineRenderSection = {
	header: string;
	path: string;
	rows: string[];
};

function parseHashlineSections(text: string): HashlineRenderSection[] {
	const sections: HashlineRenderSection[] = [];
	let current: HashlineRenderSection | undefined;
	for (const line of toolTextLines(text)) {
		const header = /^(\[(.+?)#[0-9A-Fa-f]{4}\])$/.exec(line);
		if (header) {
			current = { header: header[1] ?? line, path: header[2] ?? "", rows: [] };
			sections.push(current);
			continue;
		}
		if (current && line.length > 0 && !line.startsWith("[")) current.rows.push(line);
	}
	return sections;
}

function renderHashlineHeader(header: string, theme: RenderTheme): string {
	const match = /^(\[.+?)(#[0-9A-Fa-f]{4}\])?$/.exec(header);
	if (!match) return theme.fg("accent", header);
	return `${theme.fg("accent", match[1] ?? "")}${match[2] ? theme.fg("toolDiffAdded", match[2]) : ""}`;
}

function readDisplay(params: { path?: string; offset?: number; limit?: number; ranges?: string[] }): string {
	const path = typeof params.path === "string" ? splitReadPathSelector(params.path).path : undefined;
	return path ? `${path.replace(/\\/g, "/")}${formatReadLineRange(params)}` : "[invalid]";
}

function renderReadCall(
	params: { path?: string; offset?: number; limit?: number; ranges?: string[] },
	theme: RenderTheme,
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
): Component {
	return new BlockTextView(() => renderExplorationCall(readAction(readDisplay(params)), theme, context), theme);
}

function renderHashlineReadResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
): Text | EmptyComponent {
	if (options.isPartial) return EMPTY_VIEW;
	const text = firstTextContent(result);
	const sections = parseHashlineSections(text);
	const section = sections[0];
	if (!section) return renderPlainReadResult(text, result, options, theme);
	if (!options.expanded) return EMPTY_VIEW;
	const bodies = section.rows.map((row) => /^([ *]?)([1-9]\d*):(.*)$/.exec(row)?.[3] ?? row);
	const highlightedRows = highlightCodeRowsSync(section.path, bodies);
	return renderText(
		`${renderHashlineHeader(section.header, theme)}\n${renderNumberedRows(section.rows, theme, section.rows.length, highlightedRows)}`,
	);
}

function renderPlainReadResult(
	text: string,
	result: ToolTextResult,
	options: { expanded?: boolean },
	theme: RenderTheme,
): Text | EmptyComponent {
	const lines = toolTextLines(text);
	if (lines.length === 0 || (!options.expanded && result.details?.protected !== true)) return EMPTY_VIEW;
	const role = result.details?.protected === true ? "warning" : "toolOutput";
	return renderText(lines.map((line) => theme.fg(role, line)).join("\n"));
}

function renderReadResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	toolCallId?: string,
): Text | Container | EmptyComponent {
	if (options.isPartial) return EMPTY_VIEW;
	const preview = previewImageDetails(result.details?.previewImage);
	if (!preview) return renderHashlineReadResult(result, options, theme);

	detachToolResultImages(toolCallId, result);
	const container = new Container();
	const text = firstTextContent(result).trim();
	if (text) container.addChild(textComponent(theme.fg("toolOutput", text)));
	container.addChild(
		new KittyVirtualImage(
			preview.data,
			preview.mimeType,
			{ fallbackColor: (fallback) => theme.fg("toolOutput", fallback) },
			{ maxWidthCells: 80, maxHeightCells: 30, sourcePath: preview.sourcePath },
		),
	);
	return container;
}

function renderSearchCall(_params: { pattern?: unknown; path?: unknown }, _theme: RenderTheme): EmptyComponent {
	return EMPTY_VIEW;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightSearchText(text: string, pattern: string, theme: RenderTheme): string {
	if (!pattern) return theme.fg("toolOutput", text);
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "gi");
	} catch {
		regex = new RegExp(escapeRegExp(pattern), "gi");
	}
	return theme
		.fg("toolOutput", text)
		.replace(regex, (match) =>
			match.length === 0 ? match : (theme.inverse?.(match) ?? theme.fg("toolDiffAdded", match)),
		);
}

function renderSearchRow(row: string, pattern: string, theme: RenderTheme, highlightedBody?: string): string {
	const match = /^([ *]?)([1-9]\d*):(.*)$/.exec(row);
	if (!match) return theme.fg("toolOutput", row);
	const marker = match[1] === "*" ? "*" : " ";
	const lineNumber = match[2]?.padStart(3, " ") ?? "";
	const body = highlightedBody ?? highlightSearchText(match[3] ?? "", pattern, theme);
	const gutterRole = marker === "*" ? "toolDiffAdded" : "dim";
	return `${theme.fg(gutterRole, `${marker}${lineNumber}│`)}${body}`;
}
function renderSearchSections(
	sections: readonly HashlineRenderSection[],
	theme: RenderTheme,
	expanded: boolean,
	pattern: string,
): string {
	const lines: string[] = [];
	const maxRows = expanded ? Number.POSITIVE_INFINITY : 12;
	let emittedRows = 0;
	for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
		if (emittedRows >= maxRows) break;
		const section = sections[sectionIndex];
		const bodies = section.rows.map((row) => /^([ *]?)([1-9]\d*):(.*)$/.exec(row)?.[3] ?? row);
		const highlightedRows = highlightCodeRowsSync(section.path, bodies);
		const isLastSection = sectionIndex === sections.length - 1;
		const branch = isLastSection ? treeLast(theme) : treeBranch(theme);
		const continuation = isLastSection ? "   " : `${theme.tree?.vertical ?? "│"}  `;
		lines.push(
			`${theme.fg("dim", `${branch} ${fileIcon(theme, section.path)} `)}${renderHashlineHeader(section.header, theme)}`,
		);
		for (const [rowIndex, row] of section.rows.entries()) {
			if (emittedRows >= maxRows) break;
			const isMatch = row.startsWith("*");
			const highlighted = highlightedRows[rowIndex];
			lines.push(
				`${theme.fg("dim", continuation)}${renderSearchRow(
					row,
					pattern,
					theme,
					isMatch && highlighted ? highlightSearchMatches(highlighted, pattern) : highlighted,
				)}`,
			);
			emittedRows++;
		}
	}
	const totalRows = sections.reduce((count, section) => count + section.rows.length, 0);
	if (totalRows > emittedRows)
		lines.push(
			theme.fg("muted", `... (${totalRows - emittedRows} more lines, `) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
		);
	return lines.join("\n");
}
function renderSearchResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	args?: { pattern?: unknown; path?: unknown },
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
	latestTurnToolCallIds: ReadonlySet<string> = EMPTY_TOOL_CALL_IDS,
	getLatestTurnIndex: () => number | undefined = () => undefined,
): Component {
	const shouldRender = () =>
		shouldRenderLatestToolResult(result, context, latestTurnToolCallIds, getLatestTurnIndex());
	if (!shouldRender()) return EMPTY_VIEW;
	const pattern = typeof args?.pattern === "string" ? args.pattern : "";
	const noMatchPath = typeof args?.path === "string" ? splitReadPathSelector(args.path).path : ".";
	if (options.isPartial) {
		return framedBlock(theme, {
			header: renderStatusHeader("Search", theme, ` ${theme.fg("warning", pattern)}`, "pending"),
			borderColor: "borderMuted",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
			visible: shouldRender,
		});
	}
	const text = firstTextContent(result).trim();
	if (!text.startsWith("[")) {
		return framedBlock(theme, {
			header: renderStatusHeader(
				"Search:",
				theme,
				` ${theme.fg("warning", pattern)} ${theme.fg("dim", `${text} · in ${shortenDisplayPath(noMatchPath)}`)}`,
			),
			borderColor: "borderMuted",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
			visible: shouldRender,
		});
	}
	const sections = parseHashlineSections(text);
	const matchCount = sections.reduce(
		(count, section) => count + section.rows.filter((row) => row.startsWith("*")).length,
		0,
	);
	const fileText = `${sections.length} file${sections.length === 1 ? "" : "s"}`;
	const path = typeof args?.path === "string" ? splitReadPathSelector(args.path).path : sections[0]?.path;
	const header = renderStatusHeader(
		"Search:",
		theme,
		` ${theme.fg("warning", pattern)} ${theme.fg("dim", `${matchCount} match${matchCount === 1 ? "" : "es"} · ${fileText} · in ${shortenDisplayPath(path ?? ".")}`)}`,
	);
	return framedBlock(theme, {
		header,
		sections: [
			{
				component: new BlockTextView(
					renderSearchSections(sections, theme, options.expanded ?? false, pattern),
					theme,
					() => true,
					() => (options.expanded ? "expanded" : ""),
					null,
				),
			},
		],
		borderColor: "borderMuted",
		cacheKey: () => (options.expanded ? "expanded" : "collapsed"),
		backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
		visible: shouldRender,
	});
}

function renderFindCall(
	_params: { paths?: string[]; pattern?: unknown; path?: unknown },
	_theme: RenderTheme,
): EmptyComponent {
	return EMPTY_VIEW;
}

function renderFindResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	args?: { paths?: string[]; pattern?: unknown; path?: unknown },
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
	latestTurnToolCallIds: ReadonlySet<string> = EMPTY_TOOL_CALL_IDS,
	getLatestTurnIndex: () => number | undefined = () => undefined,
): Text | BlockTextView | EmptyComponent {
	if (options.isPartial) return renderText(theme.fg("warning", "Finding files..."));
	const shouldRender = () =>
		shouldRenderLatestToolResult(result, context, latestTurnToolCallIds, getLatestTurnIndex());
	if (!shouldRender()) return EMPTY_VIEW;
	const output = firstTextContent(result).trim();
	if (/not found on PATH|failed|error/i.test(output.split("\n")[0] ?? ""))
		return new DynamicTextView(() => theme.fg("error", output), shouldRender);
	const files = toolTextLines(output).filter((line) => line && !line.startsWith("No files"));
	const target = Array.isArray(args?.paths) ? args.paths.join(", ") : String(args?.pattern ?? "");
	const where = Array.isArray(args?.paths) ? dirname(args.paths[0] ?? ".") : String(args?.path ?? ".");
	const header = renderStatusHeader(
		"Find:",
		theme,
		` ${theme.fg("warning", shortenDisplayPath(target))} ${theme.fg("dim", `${files.length} file${files.length === 1 ? "" : "s"} · in ${shortenDisplayPath(where)}`)}`,
	);
	const shown = files.slice(0, options.expanded ? files.length : 20);
	const body = shown
		.map(
			(file, index) =>
				`${theme.fg("dim", `${index === shown.length - 1 ? treeLast(theme) : treeBranch(theme)} ${fileIcon(theme, file)} `)}${theme.fg("toolOutput", shortenDisplayPath(file))}`,
		)
		.join("\n");
	const more =
		files.length > shown.length
			? `\n${theme.fg("muted", `... (${files.length - shown.length} more files, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
			: "";
	return new BlockTextView(`${header}${body ? `\n${body}${more}` : ""}`, theme, shouldRender, () =>
		options.expanded ? "expanded" : "",
	);
}
function renderWriteCard(
	params: { path?: string; content?: string },
	theme: RenderTheme,
	options: {
		expanded?: boolean;
		state: "pending" | "success" | "error";
		error?: string;
		context?: StreamingRenderContext;
	},
): Component {
	const path = params.path ? shortenDisplayPath(params.path) : invalidArgText(theme);
	const rest = ` ${fileIcon(theme, params.path)} ${theme.fg("accent", path)}`;
	if (typeof params.content !== "string") {
		return framedBlock(theme, {
			header: renderStatusHeader("Write", theme, rest, "error"),
			sections: [{ lines: [theme.fg("error", options.error ?? "[invalid content arg - expected string]")] }],
			borderColor: "error",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolErrorBg"),
		});
	}
	const rawRows = params.content.split("\n");
	const numberedRows = rawRows.map((line, index) => `${index + 1}:${line}`);
	const pending = options.state === "pending";
	const start = pending && !options.expanded ? Math.max(0, rawRows.length - 12) : 0;
	const end = options.expanded ? rawRows.length : pending ? rawRows.length : Math.min(rawRows.length, 12);
	const visibleRows = rawRows.slice(start, end);
	const highlightedRows = highlightCodeRowsSync(params.path, visibleRows);
	const lines = renderNumberedRows(numberedRows.slice(start, end), theme, visibleRows.length, highlightedRows).split(
		"\n",
	);
	if (start > 0) lines.unshift(theme.fg("dim", `… (${start} earlier line${start === 1 ? "" : "s"})`));
	if (!pending && end < rawRows.length) {
		lines.push(
			theme.fg("muted", `... (${rawRows.length - end} more lines, `) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
		);
	}
	if (pending) lines.push(streamingStatusLine(theme, options.context, "streaming"));
	if (options.error) lines.push(theme.fg("error", options.error));
	return framedBlock(theme, {
		header: renderStatusHeader(
			"Write",
			theme,
			`${rest} ${theme.fg("dim", `· ${rawRows.length} lines`)}`,
			options.state === "error" ? "error" : pending ? "pending" : "success",
		),
		sections: [{ lines }],
		borderColor: options.state === "error" ? "error" : "borderMuted",
		backgroundAnsi:
			options.state === "error"
				? cardBackgroundAnsi(theme, "toolErrorBg")
				: cardBackgroundAnsi(theme, "toolPendingBg"),
	});
}

function renderWriteCall(
	params: { path?: string; content?: string },
	theme: RenderTheme,
	context: StreamingRenderContext = {},
): Component {
	const running = context.isPartial === true;
	scheduleStreamingInvalidation(context, running);
	return running
		? renderWriteCard(params, theme, { expanded: context.expanded, state: "pending", context })
		: EMPTY_VIEW;
}

function renderWriteResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	context?: StreamingRenderContext & { args?: { path?: string; content?: string }; isError?: boolean },
): Component {
	if (options.isPartial) return EMPTY_VIEW;
	const text = firstTextContent(result);
	const error = context?.isError || /error/i.test(text) ? text : undefined;
	return renderWriteCard(context?.args ?? {}, theme, {
		expanded: options.expanded,
		state: error ? "error" : "success",
		error,
	});
}

type EditSummary = { target?: string; display?: string; line?: number; suffix: string };

function shortenHashlineHeader(header: string): string {
	const match = /^\[([^#\]]+)(#[0-9A-Fa-f]{4})?\]$/.exec(header);
	if (!match) return shortenDisplayPath(header);
	return `[${shortenDisplayPath(match[1] ?? "")}${match[2] ?? ""}]`;
}

function summarizeEditInput(input: unknown, mode: EditMode): EditSummary {
	if (typeof input !== "string") return { suffix: ` (${mode})` };
	const hashline = input.match(/^(\[([^#\n\]]+)(?:#[0-9A-Fa-f]{4})?\])$/m);
	const range = input.match(/^(?:replace|delete|insert)\s+(?:block\s+|before\s+|after\s+)?([1-9]\d*)/m);
	if (hashline) {
		return {
			target: hashline[2],
			display: shortenHashlineHeader(hashline[1] ?? ""),
			line: range ? Number(range[1]) : undefined,
			suffix: "",
		};
	}
	const file = input.match(/^\*\*\* (?:File|Add File|Update File|Delete File):\s*(.+)$/m);
	if (file) return { target: file[1], suffix: "" };
	return { suffix: ` (${mode})` };
}

function renderEditHeaderDisplay(
	target: string,
	display: string | undefined,
	line: number | undefined,
	theme: RenderTheme,
) {
	const lineSuffix = line ? theme.fg("warning", `:${line}`) : "";
	const renderedTarget = display?.startsWith("[")
		? renderHashlineHeader(display, theme)
		: theme.fg("accent", display ?? shortenDisplayPath(target));
	return `${fileIcon(theme, target)} ${renderedTarget}${lineSuffix}`;
}

function renderEditStreamingRows(lines: readonly string[], summary: EditSummary, theme: RenderTheme): string[] {
	const codeRows = lines.map((line) => (/^[+-](?![+-]{2})/.test(line) ? line.slice(1) : ""));
	const highlighted = highlightCodeRowsSync(summary.target, codeRows);
	return lines.map((line, index) => {
		if (/^\[.+(?:#[0-9A-Fa-f]{0,4})?\]?$/.test(line)) return renderHashlineHeader(line, theme);
		if (/^\*\*\* (?:Begin|End|Add|Update|Delete|Move)/.test(line)) return theme.fg("syntaxKeyword", line);
		if (/^(?:replace|delete|insert|create|update)\b/.test(line)) {
			const [verb = "", ...rest] = line.split(" ");
			return `${theme.fg("syntaxKeyword", verb)}${rest.length ? ` ${theme.fg("toolOutput", rest.join(" "))}` : ""}`;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			return `${theme.fg("toolDiffAdded", "+")}${highlighted[index] ?? theme.fg("toolOutput", line.slice(1))}`;
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			return `${theme.fg("toolDiffRemoved", "-")}${highlighted[index] ?? theme.fg("toolOutput", line.slice(1))}`;
		}
		return theme.fg("toolOutput", line);
	});
}

type StreamingEditPreview = {
	diff: string;
	headers: ReadonlyMap<string, string>;
};

function cachedSource(path: string, sources: Map<string, string>): string {
	let text = sources.get(path);
	if (text === undefined) {
		text = normalizeToLf(stripBom(readFileSync(path, "utf-8")).text);
		sources.set(path, text);
	}
	return text;
}

function buildApplyPatchStreamingPreview(
	input: string,
	mode: "apply_patch" | "patch",
	cwd: string,
): StreamingEditPreview | undefined {
	const patch =
		mode === "patch"
			? patchModeToApplyPatch(parsePatchInput(input))
			: input.includes("*** End Patch")
				? input
				: `${input.trimEnd()}\n*** End Patch\n`;
	const ct = resolveCommand("ct", FILEOPS_TOOL_SEARCH_PATHS);
	if (!ct) return undefined;
	const result = spawnSync(ct, ["apply-patch", "--cwd", cwd, "--dry-run"], {
		cwd,
		encoding: "utf-8",
		input: patch,
		maxBuffer: 16 * 1024 * 1024,
		timeout: 2_000,
	});
	return result.status === 0 && result.stdout ? { diff: result.stdout, headers: new Map() } : undefined;
}

function buildStreamingEditPreview(
	input: unknown,
	config: EditConfig,
	cwd: string,
	sources: Map<string, string>,
): StreamingEditPreview | undefined {
	if (typeof input !== "string") return undefined;
	try {
		if (config.mode === "apply_patch" || config.mode === "patch") {
			return buildApplyPatchStreamingPreview(input, config.mode, cwd);
		}
		if (config.mode === "replace") {
			const normalized = normalizeReplaceInput(parseReplaceInput(input));
			const before = cachedSource(absolutePath(cwd, normalized.path), sources);
			const applied = applyNormalizedReplace(before, normalized, config);
			if (applied.text === before) return undefined;
			const diff = createTwoFilesPatch(normalized.path, normalized.path, before, applied.text, "", "", {
				context: 3,
			});
			return { diff, headers: new Map() };
		}
		const patch = Patch.parse(input, { cwd });
		const headers = new Map<string, string>();
		const diffs: string[] = [];
		for (const section of patch.sections) {
			const before = cachedSource(absolutePath(cwd, section.path), sources);
			const applied = section.applyPartialTo(before, treeSitterBlockResolver);
			if (applied.text === before) continue;
			headers.set(section.path, shortenHashlineHeader(formatHashlineHeader(section.path, section.fileHash)));
			diffs.push(
				createTwoFilesPatch(section.path, section.path, before, applied.text, "", "", {
					context: editPreviewContextLines(before, applied.text, applied.warnings ?? []),
				}),
			);
		}
		return diffs.length > 0 ? { diff: diffs.join(""), headers } : undefined;
	} catch {
		return undefined;
	}
}

type StreamingEditPreviewCache = {
	key: string;
	input: string;
	preview?: StreamingEditPreview;
	sources: Map<string, string>;
};

function cachedStreamingEditPreview(
	input: unknown,
	config: EditConfig,
	cwd: string,
	state: Record<string, unknown> | undefined,
	argsComplete: boolean,
): StreamingEditPreview | undefined {
	const text = typeof input === "string" ? input : "";
	const key = `${config.mode}\0${config.fuzzyMatch}\0${config.fuzzyThreshold}\0${config.allowReplaceAll}\0${cwd}\0${text}`;
	const cached = state?.editPreview as StreamingEditPreviewCache | undefined;
	if (cached?.key === key) return cached.preview;
	if (cached && text.startsWith(cached.input) && !argsComplete && !text.endsWith("\n")) {
		return cached.preview;
	}
	const sources = cached?.sources ?? new Map<string, string>();
	const preview = buildStreamingEditPreview(input, config, cwd, sources);
	const stablePreview = preview ?? (cached && text.startsWith(cached.input) ? cached.preview : undefined);
	if (state) state.editPreview = { key, input: text, preview: stablePreview, sources };
	return stablePreview;
}

function renderEditCall(
	summary: EditSummary,
	input: unknown,
	config: EditConfig,
	theme: RenderTheme,
	context: StreamingRenderContext & { cwd?: string; argsComplete?: boolean } = {},
): Component {
	const running = context.isPartial === true;
	scheduleStreamingInvalidation(context, running);
	if (!running) return EMPTY_VIEW;
	const rest = summary.target
		? ` ${renderEditHeaderDisplay(summary.target, summary.display, summary.line, theme)}${theme.fg("dim", summary.suffix)}`
		: ` ${invalidArgText(theme)}${theme.fg("dim", summary.suffix)}`;
	const backgroundAnsi = cardBackgroundAnsi(theme, "toolPendingBg");
	const preview = cachedStreamingEditPreview(
		input,
		config,
		context.cwd ?? resolve("."),
		context.state,
		context.argsComplete === true,
	);
	if (preview) {
		const renderHeader: DiffSectionHeaderRenderer = (target, line, theme) =>
			renderStatusHeader(
				"Edit:",
				theme,
				` ${renderEditHeaderDisplay(target, preview.headers.get(target), line, theme)}`,
				"pending",
			);
		return framedBlock(theme, {
			header: renderStatusHeader("Edit", theme, rest, "pending"),
			sections: [
				{
					component: new EditDiffView(
						preview.diff,
						undefined,
						context.expanded === true,
						theme,
						backgroundAnsi,
						renderHeader,
					),
				},
				{ lines: [streamingStatusLine(theme, context, "streaming")] },
			],
			borderColor: "borderMuted",
			backgroundAnsi,
		});
	}
	const allLines = typeof input === "string" ? input.replace(/\t/g, "  ").split(/\r?\n/) : [];
	if (allLines.at(-1) === "") allLines.pop();
	const visible = context.expanded ? allLines : allLines.slice(-12);
	const hidden = allLines.length - visible.length;
	const lines = renderEditStreamingRows(visible, summary, theme);
	if (hidden > 0) lines.unshift(theme.fg("dim", `… (${hidden} earlier line${hidden === 1 ? "" : "s"})`));
	lines.push(streamingStatusLine(theme, context, "streaming"));
	return framedBlock(theme, {
		header: renderStatusHeader("Edit", theme, rest, "pending"),
		sections: [{ lines }],
		borderColor: "borderMuted",
		backgroundAnsi,
	});
}
function renderEditResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	context: Partial<ToolRenderContext<Record<string, unknown>, EditInput>> | undefined,
	latestTurnEditToolCallIds: ReadonlySet<string>,
	getLatestTurnIndex: () => number | undefined,
	mode: EditMode,
) {
	if (options.isPartial) return EMPTY_VIEW;
	const text = firstTextContent(result);
	const firstLine = text.split("\n")[0] ?? "";
	const summary = summarizeEditInput(context?.args?.input, mode);
	const rest = summary.target
		? ` ${renderEditHeaderDisplay(summary.target, summary.display, summary.line, theme)}${theme.fg("dim", summary.suffix)}`
		: ` ${theme.fg("dim", summary.suffix)}`;
	const isLatestTurnEdit = () =>
		shouldRenderLatestToolResult(result, context, latestTurnEditToolCallIds, getLatestTurnIndex());
	if (!firstLine.startsWith("[") && /rejected|error/i.test(firstLine)) {
		return framedBlock(theme, {
			header: renderStatusHeader("Edit:", theme, rest, "error"),
			sections: [{ lines: text.split("\n").map((line) => theme.fg("error", line)) }],
			borderColor: "error",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolErrorBg"),
			visible: isLatestTurnEdit,
		});
	}
	const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
	if (!diff) {
		return framedBlock(theme, {
			header: renderStatusHeader("Edit:", theme, rest),
			sections: [
				{ lines: (options.expanded ? text : firstLine).split("\n").map((line) => theme.fg("toolOutput", line)) },
			],
			borderColor: "borderMuted",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
			visible: isLatestTurnEdit,
		});
	}
	const rows = Array.isArray(result.details?.highlightedDiffRows)
		? (result.details.highlightedDiffRows as DiffRenderRow[])
		: undefined;
	const resultHeaders = new Map<string, string>();
	if (Array.isArray(result.details?.results)) {
		for (const section of result.details.results as Array<{ path?: unknown; header?: unknown }>) {
			if (typeof section.path === "string" && typeof section.header === "string") {
				resultHeaders.set(section.path, shortenHashlineHeader(section.header));
			}
		}
	}
	const backgroundAnsi = cardBackgroundAnsi(theme, "toolPendingBg");
	const renderHashlineEditSectionHeader: DiffSectionHeaderRenderer = (target, line, theme) =>
		renderStatusHeader("Edit:", theme, ` ${renderEditHeaderDisplay(target, resultHeaders.get(target), line, theme)}`);
	return framedBlock(theme, {
		header: renderStatusHeader("Edit:", theme, rest),
		sections: [
			{
				component: new EditDiffView(
					diff,
					rows,
					options.expanded === true,
					theme,
					backgroundAnsi,
					renderHashlineEditSectionHeader,
				),
			},
		],
		borderColor: "borderMuted",
		backgroundAnsi,
		cacheKey: () => (options.expanded ? "expanded" : "collapsed"),
		visible: isLatestTurnEdit,
	});
}

function editResultTurnIndex(result: ToolTextResult): number | undefined {
	const value = result.details?.editTurnIndex;
	return typeof value === "number" ? value : undefined;
}

function shouldRenderLatestToolResult(
	result: ToolTextResult,
	context: Partial<ToolRenderContext<Record<string, unknown>, unknown>> | undefined,
	latestTurnToolCallIds: ReadonlySet<string>,
	latestTurnIndex: number | undefined,
): boolean {
	if (context?.executionStarted === false) {
		return typeof context.toolCallId === "string" && latestTurnToolCallIds.has(context.toolCallId);
	}
	if (context === undefined || context.executionStarted === undefined) return true;
	if (typeof context.toolCallId === "string" && latestTurnToolCallIds.has(context.toolCallId)) return true;
	if (latestTurnIndex === undefined) return context.executionStarted === true;
	const turnIndex = editResultTurnIndex(result);
	return turnIndex !== undefined && turnIndex === latestTurnIndex;
}

function splitGlobSearchRoot(cwd: string, pattern: string): { root: string; glob: string } {
	const normalized = pattern.replace(/\\/g, "/");
	const firstGlob = normalized.search(/[*?[{]/);
	if (firstGlob === -1) return { root: cwd, glob: normalized };
	const slashBeforeGlob = normalized.lastIndexOf("/", firstGlob);
	if (slashBeforeGlob === -1) return { root: cwd, glob: normalized };
	const rootText = normalized.slice(0, slashBeforeGlob) || "/";
	const glob = normalized.slice(slashBeforeGlob + 1);
	return { root: absolutePath(cwd, rootText), glob };
}
function stripHashlineDisplayPrefixes(content: string): { text: string; stripped: boolean } {
	const lines = normalizeToLf(content).split("\n");
	const stripped = stripHashlinePrefixes(lines);
	if (stripped === lines || stripped.join("\n") === lines.join("\n")) return { text: content, stripped: false };
	return { text: stripped.join("\n"), stripped: true };
}

function prepareEditArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const raw = input as Record<string, unknown>;
	const path = typeof raw.path === "string" ? raw.path : typeof raw.file_path === "string" ? raw.file_path : undefined;
	let edits = raw.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {}
	}

	const legacyOld = typeof raw.oldText === "string" ? raw.oldText : raw.old_text;
	const legacyNew = typeof raw.newText === "string" ? raw.newText : raw.new_text;
	if ((typeof legacyOld === "string" || typeof legacyNew === "string") && !Array.isArray(edits)) {
		edits = [{ old_text: legacyOld, new_text: legacyNew, all: raw.all }];
	}

	return { ...raw, path, edits };
}

function normalizeReplaceInput(input: EditInput): NormalizedReplaceInput {
	const prepared = prepareEditArguments(input) as EditInput;
	if (!prepared.path) throw new Error("edit replace mode requires path.");
	if (!Array.isArray(prepared.edits) || prepared.edits.length === 0) {
		throw new Error("edit replace mode requires at least one replacement in edits[].");
	}
	return {
		path: prepared.path,
		edits: (prepared.edits as ReplaceEntry[]).map((edit, index) => {
			const oldText = typeof edit.oldText === "string" ? edit.oldText : edit.old_text;
			const newText = typeof edit.newText === "string" ? edit.newText : edit.new_text;
			if (typeof oldText !== "string") throw new Error(`edit edits[${index}].old_text is required.`);
			if (typeof newText !== "string") throw new Error(`edit edits[${index}].new_text is required.`);
			if (oldText.length === 0) throw new Error(`edit edits[${index}].old_text must not be empty.`);
			return { oldText, newText, all: edit.all };
		}),
	};
}

function stripBom(text: string): { bom: string; text: string } {
	return text.charCodeAt(0) === 0xfeff ? { bom: text.slice(0, 1), text: text.slice(1) } : { bom: "", text };
}

function detectLineEnding(text: string): "\r\n" | "\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function firstChangedLine(before: string, after: string): number | undefined {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	const max = Math.max(beforeLines.length, afterLines.length);
	for (let index = 0; index < max; index++) {
		if (beforeLines[index] !== afterLines[index]) return index + 1;
	}
	return undefined;
}

function replaceAllLiteral(text: string, oldText: string, newText: string): { text: string; count: number } {
	const parts = text.split(oldText);
	if (parts.length === 1) return { text, count: 0 };
	return { text: parts.join(newText), count: parts.length - 1 };
}

type FuzzyWindow = { start: number; end: number; actual: string; confidence: number };

function fuzzyComparable(text: string): string {
	return text
		.normalize("NFC")
		.split("\n")
		.map((line) => line.trim().replace(/\s+/g, " "))
		.join("\n")
		.trim();
}

function fuzzySimilarity(left: string, right: string): number {
	const a = fuzzyComparable(left);
	const b = fuzzyComparable(right);
	if (a === b) return 1;
	const total = Math.max(a.length, b.length);
	if (total === 0) return 1;
	let common = 0;
	for (const change of diffChars(a, b)) if (!change.added && !change.removed) common += change.value.length;
	return common / total;
}

function findFuzzyWindow(
	content: string,
	target: string,
	threshold: number,
): {
	match?: FuzzyWindow;
	closest?: FuzzyWindow;
	ambiguous: number;
} {
	const lines = content.split("\n");
	const targetLineCount = Math.max(1, target.split("\n").length);
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	const candidates: FuzzyWindow[] = [];
	for (let index = 0; index + targetLineCount <= lines.length; index++) {
		const actual = lines.slice(index, index + targetLineCount).join("\n");
		const start = starts[index] ?? 0;
		candidates.push({
			start,
			end: start + actual.length,
			actual,
			confidence: fuzzySimilarity(actual, target),
		});
	}
	candidates.sort((left, right) => right.confidence - left.confidence);
	const closest = candidates[0];
	const eligible = candidates.filter((candidate) => candidate.confidence >= threshold);
	return { match: eligible.length === 1 ? eligible[0] : undefined, closest, ambiguous: eligible.length };
}

function adjustReplacementIndent(search: string, actual: string, replacement: string): string {
	const indent = (text: string) =>
		text
			.split("\n")
			.find((line) => line.trim())
			?.match(/^\s*/)?.[0].length ?? 0;
	const delta = indent(actual) - indent(search);
	if (delta === 0) return replacement;
	return replacement
		.split("\n")
		.map((line) => {
			if (!line.trim()) return line;
			return delta > 0
				? `${" ".repeat(delta)}${line}`
				: line.slice(Math.min(-delta, line.match(/^\s*/)?.[0].length ?? 0));
		})
		.join("\n");
}

function replaceFuzzy(
	content: string,
	oldText: string,
	newText: string,
	config: EditConfig,
	path: string,
): { text: string; count: number } {
	const exact = replaceAllLiteral(content, oldText, newText);
	if (exact.count > 0) return exact;
	if (!config.fuzzyMatch) throw new Error(`Could not find old_text in ${path}. Fuzzy matching is disabled.`);
	const outcome = findFuzzyWindow(content, oldText, config.fuzzyThreshold);
	if (outcome.ambiguous > 1) {
		throw new Error(`Found ${outcome.ambiguous} fuzzy matches in ${path}. Add more context.`);
	}
	if (!outcome.match) {
		const similarity = Math.round((outcome.closest?.confidence ?? 0) * 100);
		throw new Error(
			`Could not find a close enough match in ${path}. Closest match was ${similarity}% similar; threshold is ${Math.round(config.fuzzyThreshold * 100)}%.`,
		);
	}
	const replacement = adjustReplacementIndent(oldText, outcome.match.actual, newText);
	return {
		text: `${content.slice(0, outcome.match.start)}${replacement}${content.slice(outcome.match.end)}`,
		count: 1,
	};
}

function applyNormalizedReplace(
	before: string,
	normalized: NormalizedReplaceInput,
	config: EditConfig,
): { text: string; total: number } {
	if (normalized.edits.some((edit) => edit.all) && !config.allowReplaceAll) {
		throw new Error("edit replace mode has all: true disabled by /edit-config.");
	}
	let current = before;
	let total = 0;
	for (const edit of normalized.edits) {
		const oldText = normalizeToLf(edit.oldText);
		const newText = normalizeToLf(edit.newText);
		if (edit.all) {
			const exact = replaceAllLiteral(current, oldText, newText);
			const replaced = exact.count > 0 ? exact : replaceFuzzy(current, oldText, newText, config, normalized.path);
			current = replaced.text;
			total += replaced.count;
			continue;
		}
		const first = current.indexOf(oldText);
		if (first !== -1) {
			if (current.indexOf(oldText, first + oldText.length) !== -1) {
				throw new Error(`Found multiple occurrences in ${normalized.path}. Add more context or set all: true.`);
			}
			current = `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`;
			total += 1;
			continue;
		}
		const fuzzy = replaceFuzzy(current, oldText, newText, config, normalized.path);
		current = fuzzy.text;
		total += fuzzy.count;
	}
	return { text: current, total };
}

async function executeReplace(
	cwd: string,
	input: EditInput,
	config: EditConfig,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: EditToolDetails }> {
	const normalized = normalizeReplaceInput(input);

	const target = absolutePath(cwd, normalized.path);
	return withFileMutationQueue(target, async () => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const raw = await readFile(target, "utf-8");
		const { bom, text } = stripBom(raw);
		const lineEnding = detectLineEnding(text);
		const before = normalizeToLf(text);
		const applied = applyNormalizedReplace(before, normalized, config);
		const current = applied.text;
		const total = applied.total;
		if (current === before) throw new Error(`Edits to ${normalized.path} resulted in no changes being made.`);
		await writeFile(target, bom + restoreLineEndings(current, lineEnding), "utf-8");

		const patch = createTwoFilesPatch(normalized.path, normalized.path, before, current, "", "", { context: 3 });
		const highlightedDiffRows = await buildHighlightedDiffRows(patch);
		return {
			content: [
				{
					type: "text",
					text: `Successfully replaced ${total} occurrence${total === 1 ? "" : "s"} in ${normalized.path}.`,
				},
			],
			details: { diff: patch, patch, highlightedDiffRows, firstChangedLine: firstChangedLine(before, current) },
		};
	});
}

function patchModeToApplyPatch(input: EditInput): string {
	if (!input.path) throw new Error("edit patch mode requires path.");
	if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error("edit patch mode requires edits[].");
	const lines = ["*** Begin Patch"];
	for (const edit of input.edits as PatchEntry[]) {
		if (edit.op === "create") {
			lines.push(`*** Add File: ${input.path}`);
			lines.push(
				...(edit.diff ?? "")
					.replace(/\r\n?/g, "\n")
					.split("\n")
					.map((line) => `+${line}`),
			);
			continue;
		}
		if (edit.op === "delete") {
			lines.push(`*** Delete File: ${input.path}`);
			continue;
		}
		if (edit.op === "update") {
			lines.push(`*** Update File: ${input.path}`);
			if (edit.rename) lines.push(`*** Move to: ${edit.rename}`);
			lines.push((edit.diff ?? "").replace(/\r\n?/g, "\n").trimEnd());
			continue;
		}
		throw new Error(`Unsupported edit patch op: ${(edit as { op?: unknown }).op}`);
	}
	lines.push("*** End Patch");
	return `${lines.filter((line) => line.length > 0).join("\n")}\n`;
}

function parsePatchInput(input: string): EditInput {
	const edits: PatchEntry[] = [];
	let path: string | undefined;
	let current: PatchEntry | undefined;
	const flush = () => {
		if (current) edits.push(current);
		current = undefined;
	};
	const lines = normalizeToLf(input).split("\n");
	if (lines.at(-1) === "") lines.pop();

	for (const line of lines) {
		if (line.trim() === "" && !current) continue;
		if (line.startsWith("*** File: ")) {
			flush();
			path = line.slice("*** File: ".length).trim();
			continue;
		}
		if (line === "*** Create") {
			flush();
			current = { op: "create", diff: "" };
			continue;
		}
		if (line === "*** Update") {
			flush();
			current = { op: "update", diff: "" };
			continue;
		}
		if (line === "*** Delete") {
			flush();
			current = { op: "delete" };
			continue;
		}
		if (line.startsWith("*** Rename to: ")) {
			if (!current || current.op !== "update") {
				flush();
				current = { op: "update", diff: "" };
			}
			current.rename = line.slice("*** Rename to: ".length).trim();
			continue;
		}
		if (!current || current.op === "delete") throw new Error(`patch mode line outside entry: ${line}`);
		if (current.op === "create") {
			if (!line.startsWith("+")) throw new Error(`create lines must start with '+': ${line}`);
			current.diff = `${current.diff ?? ""}${line.slice(1)}\n`;
		} else {
			current.diff = `${current.diff ?? ""}${line}\n`;
		}
	}
	flush();
	if (!path) throw new Error("patch mode requires a *** File: header.");
	return { path, edits };
}

function parseReplaceInput(input: string): EditInput {
	const edits: ReplaceEntry[] = [];
	let path: string | undefined;
	let current: ReplaceEntry | undefined;
	let bucket: "old" | "new" | undefined;
	const flush = () => {
		if (current) edits.push(current);
		current = undefined;
		bucket = undefined;
	};

	for (const line of normalizeToLf(input).split("\n")) {
		if (line.trim() === "") continue;
		if (line.startsWith("*** File: ")) {
			flush();
			path = line.slice("*** File: ".length).trim();
			continue;
		}
		if (line === "*** Old") {
			flush();
			current = { old_text: "", new_text: "" };
			bucket = "old";
			continue;
		}
		if (line === "*** New") {
			if (!current) throw new Error("replace mode has *** New before *** Old.");
			bucket = "new";
			continue;
		}
		if (line === "*** All") {
			if (!current) throw new Error("replace mode has *** All before replacement.");
			current.all = true;
			continue;
		}
		if (!current || !bucket || !line.startsWith("|")) {
			throw new Error(`replace mode payload line must start with '|': ${line}`);
		}
		const key = bucket === "old" ? "old_text" : "new_text";
		current[key] = `${current[key] ?? ""}${line.slice(1)}\n`;
	}
	flush();
	if (!path) throw new Error("replace mode requires a *** File: header.");
	for (const edit of edits) {
		if (edit.old_text?.endsWith("\n")) edit.old_text = edit.old_text.slice(0, -1);
		if (edit.new_text?.endsWith("\n")) edit.new_text = edit.new_text.slice(0, -1);
	}
	return { path, edits };
}

async function runApplyPatch(cwd: string, input: string, signal?: AbortSignal) {
	const result = await runExternalCommand("ct", ["apply-patch", "--cwd", cwd], cwd, { signal, input });
	return {
		content: [{ type: "text", text: result.stdout || result.stderr || "edit applied" }],
		details: { diff: "", patch: "" },
	};
}

class CwdHashlineFilesystem extends Filesystem {
	constructor(private readonly cwd: string) {
		super();
	}

	#absolute(path: string): string {
		return absolutePath(this.cwd, path);
	}

	async readText(path: string): Promise<string> {
		try {
			return await readFile(this.#absolute(path), "utf-8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				throw new NotFoundError(path, error);
			}
			throw error;
		}
	}

	async preflightWrite(path: string): Promise<void> {
		await mkdir(dirname(this.#absolute(path)), { recursive: true });
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		const absolute = this.#absolute(path);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, content, "utf-8");
		return { text: content };
	}

	canonicalPath(path: string): string {
		return this.#absolute(path);
	}
}

async function withHashlineMutationQueues<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
	const unique = [...new Set(paths)].sort();
	const run = (index: number): Promise<T> => {
		const path = unique[index];
		if (path === undefined) return fn();
		return withFileMutationQueue(path, () => run(index + 1));
	};
	return run(0);
}

function noChangeDiagnostic(path: string): string {
	// The patch parsed and applied cleanly but produced no change — the
	// literal body rows matched the file content at the targeted lines
	// byte-for-byte. The model usually misreads this as "wrong anchor, try
	// again with a bigger payload" and starts duplicating content; the
	// message below names the cause directly so the next turn can re-read
	// instead of expanding the patch.
	return (
		`Edits to ${path} parsed and applied cleanly, but produced no change: ` +
		`your body row(s) are byte-identical to the file at the targeted lines. ` +
		`The bug is somewhere else — re-read the file before issuing another edit. ` +
		`Do NOT widen the payload or add lines; verify the anchor first.`
	);
}

function formatBlockResolution(resolution: BlockResolution): string {
	const op =
		resolution.op === "insert_after"
			? "insert after block"
			: resolution.op === "delete"
				? "delete block"
				: "replace block";
	const lines = resolution.end - resolution.start + 1;
	const span =
		resolution.start === resolution.end ? `line ${resolution.start}` : `lines ${resolution.start}-${resolution.end}`;
	return `${op} ${resolution.anchorLine} → resolved ${span} (${lines} line${lines === 1 ? "" : "s"})`;
}

function hasStructuralDelimiterChange(before: string, after: string): boolean {
	if (before === after) return false;
	return /[{}()[\]]/.test(before) || /[{}()[\]]/.test(after);
}

function editPreviewContextLines(before: string, after: string, warnings: readonly string[]): number {
	return warnings.length > 0 || hasStructuralDelimiterChange(before, after) ? 4 : 2;
}

async function executeHashline(cwd: string, input: string, config: EditConfig, snapshots: InMemorySnapshotStore) {
	const patch = Patch.parse(input, { cwd });
	if (patch.sections.length === 0) throw new Error("hashline mode requires at least one [PATH#TAG] section.");
	const fs = new CwdHashlineFilesystem(cwd);
	// The block resolver is synchronous; warm its language cache for every
	// section path before the apply so `replace block N:` edits resolve.
	await preloadBlockLanguages(patch.sections.map((section) => section.path));
	const patcher = new Patcher({
		fs,
		snapshots,
		blockResolver: treeSitterBlockResolver,
		syntaxValidator: treeSitterSyntaxValidator,
		applyOptions: { autoDropPureInsertDuplicates: config.autoDropPureInsertDuplicates },
	});
	const targets = patch.sections.map((section) => fs.canonicalPath(section.path));
	const applied = await withHashlineMutationQueues(targets, () => patcher.apply(patch));

	const sectionTexts: string[] = [];
	const diffs: string[] = [];
	for (const section of applied.sections) {
		if (section.op === "noop") {
			const warningsBlock = section.warnings.length > 0 ? `\n\nWarnings:\n${section.warnings.join("\n")}` : "";
			sectionTexts.push(`${noChangeDiagnostic(section.path)}${warningsBlock}`);
			continue;
		}
		// Model-facing text: the fresh `[path#tag]` re-anchoring handle, block
		// span echoes, and a compact post-edit preview whose line numbers are
		// directly usable by the next edit.
		const numberedDiff = generateNumberedDiff(section.before, section.after, {
			contextLines: editPreviewContextLines(section.before, section.after, section.warnings),
			path: section.path,
		});
		const preview = buildCompactDiffPreview(numberedDiff.diff);
		const blockBlock =
			section.blockResolutions && section.blockResolutions.length > 0
				? `\n${section.blockResolutions.map(formatBlockResolution).join("\n")}`
				: "";
		const previewBlock = preview.preview ? `\n${preview.preview}` : "";
		const warningsBlock = section.warnings.length > 0 ? `\n\nWarnings:\n${section.warnings.join("\n")}` : "";
		sectionTexts.push(`${section.header}${blockBlock}${previewBlock}${warningsBlock}`);
		diffs.push(
			createTwoFilesPatch(section.path, section.path, section.before, section.after, "", "", { context: 3 }),
		);
	}
	const diff = diffs.join("\n");
	const firstLine = applied.sections.find((section) => section.firstChangedLine !== undefined)?.firstChangedLine;
	const highlightedDiffRows = await buildHighlightedDiffRows(diff);
	return {
		content: [{ type: "text", text: sectionTexts.join("\n\n") }],
		details: {
			diff,
			patch: diff,
			highlightedDiffRows,
			results: applied.sections,
			firstChangedLine: firstLine,
		},
	};
}

async function executeByMode(
	cwd: string,
	params: EditInput,
	config: EditConfig,
	snapshots: InMemorySnapshotStore,
	signal?: AbortSignal,
) {
	switch (config.mode) {
		case "apply_patch":
			if (typeof params.input !== "string") throw new Error("edit apply_patch mode requires input.");
			return runApplyPatch(cwd, params.input, signal);
		case "patch":
			return runApplyPatch(
				cwd,
				patchModeToApplyPatch(
					typeof params.input === "string"
						? parsePatchInput(params.input)
						: (prepareEditArguments(params) as EditInput),
				),
				signal,
			);
		case "hashline":
			if (typeof params.input !== "string") throw new Error("edit hashline mode requires input.");
			return executeHashline(cwd, params.input, config, snapshots);
		case "replace":
			return executeReplace(
				cwd,
				typeof params.input === "string" ? parseReplaceInput(params.input) : params,
				config,
				signal,
			);
	}
}

function withEditTurnIndex(result: ToolTextResult, turnIndex: number | undefined): ToolTextResult {
	if (turnIndex === undefined) return result;
	return { ...result, details: { ...(result.details ?? {}), editTurnIndex: turnIndex } };
}

function registerHashlineWorkflowTools(
	pi: ExtensionAPI,
	getConfig: () => EditConfig,
	snapshotsForContext: (ctx: Pick<ExtensionContext, "sessionManager"> | undefined) => InMemorySnapshotStore,
	renderTracking: {
		latestTurnToolCallIds: Set<string>;
		markToolCall: (toolCallId: string) => void;
		getLatestTurnIndex: () => number | undefined;
	},
) {
	const cwd = process.cwd();
	const baseRead = createReadToolDefinition(cwd);
	const baseFind = createFindToolDefinition(cwd);
	const baseWrite = createWriteToolDefinition(cwd);

	pi.registerTool({
		...baseRead,
		name: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). In hashline edit mode, text reads return [PATH#TAG] plus LINE:TEXT rows that can be targeted by hashline edits.",
		parameters: readToolSchema,
		renderShell: "self",
		renderCall(params, theme, context) {
			return renderReadCall(params, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderReadResult(result as ToolTextResult, options, theme, context?.toolCallId);
		},
		async execute(
			toolCallId,
			params: { path: string; offset?: number; limit?: number; ranges?: string[]; raw?: boolean },
			signal,
			onUpdate,
			ctx,
		) {
			const callCwd = ctx?.cwd ?? cwd;
			const selector = splitReadPathSelector(params.path);
			const selectedPath = selector.path;
			const absolute = absolutePath(callCwd, selectedPath);
			const explicitRanges = [
				...selector.ranges,
				...(params.ranges ?? []).flatMap((rangeList) => rangeList.split(",").map(parseLineRange)),
			];
			const imageMimeType = await detectSupportedReadImageMimeType(absolute);
			if (imageMimeType) {
				const result = (await baseRead.execute(
					toolCallId,
					{ path: absolute, offset: params.offset, limit: params.limit },
					signal,
					onUpdate,
					ctx,
				)) as ToolTextResult;
				const previewImage = await readPreviewImageFromPath(absolute);
				return previewImage ? { ...result, details: { ...(result.details ?? {}), previewImage } } : result;
			}
			if (getConfig().mode === "hashline") {
				const summary = await trySummarizeWholeFileRead(
					displayPath(callCwd, absolute),
					absolute,
					params,
					explicitRanges,
					snapshotsForContext(ctx),
				);
				if (summary) return summary;
			}
			const largeReadBlock = await maybeBlockLargeWholeFileRead(
				displayPath(callCwd, absolute),
				absolute,
				params,
				explicitRanges,
			);
			if (largeReadBlock) return largeReadBlock;
			if (getConfig().mode !== "hashline") {
				return baseRead.execute(toolCallId, params, signal, onUpdate, ctx);
			}
			const { text: rawText } = stripBom(await readFile(absolute, "utf-8"));
			const text = normalizeToLf(rawText);
			if (params.raw && explicitRanges.length === 0 && params.limit === undefined)
				return { content: [{ type: "text", text }] };
			const allLines = textToDisplayLines(text);
			await preloadBlockLanguages([absolute]);
			if (explicitRanges.length > 0) {
				const ranges = mergeLineRanges(explicitRanges);
				const entries = selectedLineEntries(allLines, ranges);
				if (params.raw) return { content: [{ type: "text", text: entries.map(([, line]) => line).join("\n") }] };
				const displayEntries = buildLineEntriesWithBlockContext(
					allLines,
					ranges.map((range) => ({ startLine: range.start, endLine: range.end })),
					absolute,
				);
				const observedLines = {
					explicit: entries.map(([lineNumber]) => lineNumber),
					synthetic: displayEntries.flatMap((entry) =>
						entry.kind === "line" && entry.context ? [entry.lineNumber] : [],
					),
				};
				const tag =
					Buffer.byteLength(text, "utf8") <= SNAPSHOT_MAX_BYTES
						? recordHashlineSnapshot(snapshotsForContext(ctx), absolute, text, observedLines)
						: undefined;
				const outputRows = displayEntries.map((entry) =>
					entry.kind === "ellipsis" ? "…" : `${entry.lineNumber}:${entry.text}`,
				);
				const output = [
					...(tag ? [formatHashlineHeader(displayPath(callCwd, absolute), tag)] : []),
					...outputRows,
				].join("\n");
				const visibleEntries = displayEntries.filter((entry) => entry.kind === "line").slice(0, 80);
				const highlightedRows = await highlightCodeRows(
					selectedPath,
					visibleEntries.map((entry) => entry.text),
				);
				return {
					content: [{ type: "text", text: output }],
					details: { hashlineTag: tag, ranges, highlightedRows },
				};
			}
			const startLine = Math.max(1, Math.floor(params.offset ?? 1));
			if (startLine > allLines.length)
				throw new Error(`Offset ${startLine} is beyond end of file (${allLines.length} lines total)`);
			const endExclusive =
				params.limit === undefined
					? allLines.length
					: Math.min(allLines.length, startLine - 1 + Math.max(1, params.limit));
			const selected = allLines.slice(startLine - 1, endExclusive);
			if (params.raw) return { content: [{ type: "text", text: selected.join("\n") }] };
			const wholeFileSelected = params.limit === undefined && startLine === 1 && endExclusive === allLines.length;
			const displayEntries = wholeFileSelected
				? selected.map((line, index) => ({
						kind: "line" as const,
						lineNumber: startLine + index,
						text: line,
						context: false,
					}))
				: buildLineEntriesWithBlockContext(allLines, [{ startLine, endLine: endExclusive }], absolute);
			const observedLines = wholeFileSelected
				? "all"
				: {
						explicit: selected.map((_, index) => startLine + index),
						synthetic: displayEntries.flatMap((entry) =>
							entry.kind === "line" && entry.context ? [entry.lineNumber] : [],
						),
					};
			const tag =
				Buffer.byteLength(text, "utf8") <= SNAPSHOT_MAX_BYTES
					? recordHashlineSnapshot(snapshotsForContext(ctx), absolute, text, observedLines)
					: undefined;
			let output = `${tag ? `${formatHashlineHeader(displayPath(callCwd, absolute), tag)}\n` : ""}${displayEntries
				.map((entry) => (entry.kind === "ellipsis" ? "…" : `${entry.lineNumber}:${entry.text}`))
				.join("\n")}`;
			if (endExclusive < allLines.length) {
				const remaining = allLines.length - endExclusive;
				const lineWord = remaining === 1 ? "line" : "lines";
				output += `\n\n[${remaining} more ${lineWord} in file. Use offset=${endExclusive + 1} or path:${endExclusive + 1}-${allLines.length} to continue.]`;
			}
			const visibleSelected = displayEntries.filter((entry) => entry.kind === "line").slice(0, 80);
			return {
				content: [{ type: "text", text: output }],
				details: {
					hashlineTag: tag,
					highlightedRows: await highlightCodeRows(
						selectedPath,
						visibleSelected.map((entry) => entry.text),
					),
				},
			};
		},
	});

	pi.registerTool({
		name: "search",
		label: "search",
		description:
			"Search file contents. In hashline edit mode, matching lines are grouped under [PATH#TAG] headers with LINE:TEXT rows.",
		promptSnippet: "Search file contents and return hashline-editable matches",
		promptGuidelines: [
			"Use search for file-content searches when it is active; use read when you already know the path.",
		],
		parameters: searchToolSchema,
		renderShell: "self",
		renderCall(params, theme) {
			return renderSearchCall(params, theme);
		},
		renderResult(result, options, theme, context) {
			return renderSearchResult(
				result as ToolTextResult,
				options,
				theme,
				context.args as any,
				context,
				renderTracking.latestTurnToolCallIds,
				renderTracking.getLatestTurnIndex,
			);
		},
		async execute(toolCallId, params: any, signal, _onUpdate, ctx) {
			renderTracking.markToolCall(toolCallId);
			const callCwd = ctx?.cwd ?? cwd;
			const selector = params.path ? splitReadPathSelector(String(params.path)) : { path: undefined, ranges: [] };
			const explicitRanges = [
				...selector.ranges,
				...(params.ranges ?? []).flatMap((rangeList: string) => rangeList.split(",").map(parseLineRange)),
			];
			const searchPath = selector.path;
			const args = ["--line-number", "--color=never", "--hidden", "--no-heading"];
			if (params.ignoreCase) args.push("--ignore-case");
			if (params.literal) args.push("--fixed-strings");
			if (params.glob) args.push("--glob", String(params.glob));
			if (params.context && params.context > 0) args.push("-C", String(Math.max(0, Math.floor(params.context))));
			const resultLimit = Math.max(1, Math.min(1000, Number(params.limit ?? DEFAULT_SEARCH_RESULT_LIMIT)));
			if (explicitRanges.length === 0) {
				const rgMaxCount = params.limit === undefined ? resultLimit + 1 : resultLimit;
				args.push("--max-count", String(rgMaxCount));
			}
			args.push("--", String(params.pattern), searchPath ? String(searchPath) : ".");
			const result = await runExternalCommand("rg", args, callCwd, {
				signal,
				allowNonZero: true,
				extraSearchPaths: FILEOPS_TOOL_SEARCH_PATHS,
			});
			if (result.exitCode === 1 || result.stdout.trim().length === 0) {
				return { content: [{ type: "text", text: "No matches found" }] };
			}
			const byFile = new Map<string, Map<number, { text: string; isMatch: boolean }>>();
			for (const line of result.stdout.replace(/\r\n?/g, "\n").split("\n")) {
				if (!line.trim() || line === "--") continue;
				const match = /^(.*?)([:-])([1-9]\d*)([:-])(.*)$/.exec(line);
				const singleFileMatch = !match && searchPath ? /^([1-9]\d*)([:-])(.*)$/.exec(line) : undefined;
				if (!match && !singleFileMatch) continue;
				const absolute = match ? absolutePath(callCwd, match[1]) : absolutePath(callCwd, String(searchPath));
				const lineNumber = Number(match ? match[3] : singleFileMatch?.[1]);
				if (!lineNumberInRanges(lineNumber, explicitRanges)) continue;
				const isMatch = (match ? match[2] : singleFileMatch?.[2]) === ":";
				const fileLines = byFile.get(absolute) ?? new Map<number, { text: string; isMatch: boolean }>();
				fileLines.set(lineNumber, { text: match ? match[5] : (singleFileMatch?.[3] ?? ""), isMatch });
				byFile.set(absolute, fileLines);
			}
			if (byFile.size === 0) return { content: [{ type: "text", text: "No matches found in selected ranges" }] };
			await preloadBlockLanguages(byFile.keys());
			const sections: string[] = [];
			const highlightedSections: HighlightedSection[] = [];
			let emittedRows = 0;
			let truncatedSearch = false;
			for (const [absolute, fileEntries] of [...byFile.entries()].sort((left, right) =>
				left[0].localeCompare(right[0]),
			)) {
				const ordered = [...fileEntries.entries()].sort((left, right) => left[0] - right[0]);
				const cappedOrdered = ordered.slice(0, Math.max(0, resultLimit - emittedRows));
				emittedRows += cappedOrdered.length;
				if (cappedOrdered.length < ordered.length) truncatedSearch = true;
				if (cappedOrdered.length === 0) continue;
				const display = displayPath(callCwd, absolute);
				const rawFile = normalizeToLf((await readFile(absolute, "utf-8")).replace(/^\uFEFF/, ""));
				const fullLines = textToDisplayLines(rawFile);
				const entryText = new Map(cappedOrdered.map(([lineNumber, entry]) => [lineNumber, entry.text] as const));
				const displayEntries = buildLineEntriesWithBlockContext(
					fullLines,
					cappedOrdered.map(([lineNumber]) => ({ startLine: lineNumber, endLine: lineNumber })),
					absolute,
					{ lineText: (lineNumber, sourceText) => entryText.get(lineNumber) ?? sourceText },
				);
				const tag = await recordHashlineFileSnapshot(snapshotsForContext(ctx), absolute, {
					explicit: cappedOrdered.map(([lineNumber]) => lineNumber),
					synthetic: displayEntries.flatMap((entry) =>
						entry.kind === "line" && entry.context ? [entry.lineNumber] : [],
					),
				});
				const visibleOrdered = displayEntries.filter((entry) => entry.kind === "line").slice(0, 80);
				const highlightedRows = (
					await highlightCodeRows(
						display,
						visibleOrdered.map((entry) => entry.text),
					)
				).map((row, index) => {
					const lineNumber = visibleOrdered[index]?.lineNumber;
					return lineNumber !== undefined && fileEntries.get(lineNumber)?.isMatch
						? highlightSearchMatches(row, String(params.pattern))
						: row;
				});
				highlightedSections.push({ path: display, rows: highlightedRows });
				sections.push(
					[
						...(tag ? [formatHashlineHeader(display, tag)] : []),
						...displayEntries.map((entry) => {
							if (entry.kind === "ellipsis") return "…";
							const isMatch = fileEntries.get(entry.lineNumber)?.isMatch === true;
							return `${isMatch ? "*" : " "}${entry.lineNumber}:${entry.text}`;
						}),
					].join("\n"),
				);
			}
			if (truncatedSearch) {
				sections.push(
					[`[Search results truncated at ${resultLimit} rows.]`, "Use a narrower path, glob, or ranges."].join(
						"\n",
					),
				);
			}
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: { highlightedSections } };
		},
	});

	pi.registerTool({
		...baseFind,
		name: "find",
		description: "Find files by glob/path. Accepts either {pattern,path} or oh-my-pi-style {paths:[...]} inputs.",
		promptGuidelines: ["Use find for file discovery by glob or path when it is active."],
		parameters: findToolSchema,
		renderShell: "self",
		renderCall(params, theme) {
			return renderFindCall(params, theme);
		},
		renderResult(result, options, theme, context) {
			return renderFindResult(
				result as ToolTextResult,
				options,
				theme,
				context.args as any,
				context,
				renderTracking.latestTurnToolCallIds,
				renderTracking.getLatestTurnIndex,
			);
		},
		async execute(toolCallId, params: any, signal, onUpdate, ctx) {
			renderTracking.markToolCall(toolCallId);
			if (!Array.isArray(params.paths)) return baseFind.execute(toolCallId, params, signal, onUpdate, ctx);
			const callCwd = ctx?.cwd ?? cwd;
			const limit = Math.max(1, Math.min(1000, Number(params.limit ?? DEFAULT_FIND_RESULT_LIMIT)));
			const outputs: string[] = [];
			for (const pattern of params.paths) {
				const search = splitGlobSearchRoot(callCwd, String(pattern));
				const rootStat = await stat(search.root).catch(() => undefined);
				if (!rootStat?.isDirectory()) continue;
				const args = ["--files", "--color=never"];
				if (!params.gitignore) args.push("--no-ignore");
				if (params.hidden) args.push("--hidden");
				args.push("--glob", search.glob);
				const result = await runExternalCommand("rg", args, search.root, {
					signal,
					allowNonZero: true,
					extraSearchPaths: FILEOPS_TOOL_SEARCH_PATHS,
				});
				outputs.push(
					...result.stdout
						.split("\n")
						.filter(Boolean)
						.map((file) => displayPath(callCwd, absolutePath(search.root, file))),
				);
			}
			const allUnique = [...new Set(outputs)].sort((left, right) => left.localeCompare(right));
			const unique = allUnique.slice(0, limit);
			const truncatedFind = params.limit === undefined && allUnique.length > limit;
			const text =
				unique.length === 0
					? "No files found matching pattern"
					: [
							...unique,
							...(truncatedFind
								? [`[Find results truncated at ${limit} files. Use a narrower glob or path.]`]
								: []),
						].join("\n");
			return {
				content: [{ type: "text", text }],
			};
		},
	});

	pi.registerTool({
		...baseWrite,
		name: "write",
		description:
			"Write a file. In hashline edit mode, copied [PATH#TAG] and LINE: prefixes are stripped from content before writing.",
		parameters: writeToolSchema,
		renderShell: "self",
		renderCall(params, theme, context) {
			return renderWriteCall(params, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderWriteResult(result as ToolTextResult, options, theme, context);
		},
		async execute(
			toolCallId,
			params: { path: string; content: string; makeExecutable?: boolean },
			signal,
			onUpdate,
			ctx,
		) {
			onUpdate?.({ content: [{ type: "text", text: "Writing..." }], details: {} });
			if (getConfig().mode !== "hashline") return baseWrite.execute(toolCallId, params, signal, onUpdate, ctx);
			const callCwd = ctx?.cwd ?? cwd;
			const stripped = stripHashlineDisplayPrefixes(params.content);
			const absolute = absolutePath(callCwd, params.path);
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, stripped.text, "utf-8");
			if (params.makeExecutable || stripped.text.startsWith("#!")) await chmod(absolute, 0o755);
			snapshotsForContext(ctx).invalidate(absolute);
			const result: ToolTextResult = {
				content: [{ type: "text", text: `Wrote ${params.path}` }],
				details: {},
			};
			if (stripped.stripped) {
				const first = result.content.find(
					(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
				);
				if (first) first.text += "\nNote: auto-stripped hashline display prefixes from content before writing.";
			}
			return result;
		},
	});
}

function formatConfig(config: EditConfig): string {
	return [
		`mode: ${config.mode}`,
		`fuzzyMatch: ${config.fuzzyMatch}`,
		`fuzzyThreshold: ${config.fuzzyThreshold}`,
		`allowReplaceAll: ${config.allowReplaceAll}`,
		`autoDropPureInsertDuplicates: ${config.autoDropPureInsertDuplicates}`,
	].join("\n");
}

function sessionIdFromContext(ctx: Pick<ExtensionContext, "sessionManager"> | undefined): string | undefined {
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

export default function fileopsExtension(pi: ExtensionAPI) {
	// Tells replayed history apart from live calls, so a resumed transcript does not animate.
	pi.on?.("turn_start", () => markLiveTurnStarted());
	registerToolResultImageRestore(pi);
	registerExplorationTool("read", (args) => readAction(readDisplay((args ?? {}) as any)));
	registerExplorationEventHandlers(pi);
	let config = loadConfig();
	const fallbackSnapshots = hashlineSnapshotStoreForSession(FALLBACK_HASHLINE_SNAPSHOT_SESSION_ID);
	const snapshotsForContext = (ctx: Pick<ExtensionContext, "sessionManager"> | undefined): InMemorySnapshotStore => {
		const sessionId = sessionIdFromContext(ctx);
		return sessionId ? hashlineSnapshotStoreForSession(sessionId) : fallbackSnapshots;
	};
	let currentTurnIndex: number | undefined;
	const latestTurnEditToolCallIds = new Set<string>();
	const isFileopsResultTool = (toolName: unknown) =>
		toolName === "edit" || toolName === "search" || toolName === "find";
	const rebuildVisibleFileopsWindow = (ctx: ExtensionContext | undefined) => {
		latestTurnEditToolCallIds.clear();
		const branch = ctx?.sessionManager?.getBranch?.() ?? [];
		const latestCompactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
		const latestCompaction = latestCompactionIndex === -1 ? undefined : branch[latestCompactionIndex];
		const firstKeptEntryId = latestCompaction?.type === "compaction" ? latestCompaction.firstKeptEntryId : undefined;
		const firstVisibleIndex =
			typeof firstKeptEntryId === "string"
				? Math.max(
						0,
						branch.findIndex((entry) => entry.id === firstKeptEntryId),
					)
				: 0;
		for (const entry of branch.slice(firstVisibleIndex)) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (
					block?.type === "toolCall" &&
					isFileopsResultTool(block.name) &&
					typeof block.id === "string" &&
					block.id.length > 0
				) {
					latestTurnEditToolCallIds.add(block.id);
				}
			}
		}
	};
	const markLatestFileopsToolCall = (toolCallId: string) => {
		latestTurnEditToolCallIds.add(toolCallId);
	};
	const resetTurnTracking = () => {
		currentTurnIndex = undefined;
		latestTurnEditToolCallIds.clear();
	};
	const on = (pi as Partial<ExtensionAPI>).on;
	if (typeof on === "function") {
		on.call(pi, "session_start", (_event, ctx) => {
			resetTurnTracking();
			rebuildVisibleFileopsWindow(ctx);
		});
		on.call(pi, "session_tree", (_event, ctx) => {
			resetTurnTracking();
			rebuildVisibleFileopsWindow(ctx);
		});
		on.call(pi, "session_compact", (_event, ctx) => {
			rebuildVisibleFileopsWindow(ctx);
		});
		on.call(pi, "turn_start", (event) => {
			currentTurnIndex = event.turnIndex;
		});
		on.call(pi, "tool_execution_start", (event) => {
			if (isFileopsResultTool(event.toolName)) {
				markLatestFileopsToolCall(event.toolCallId);
			}
		});
	}
	const registerEditTool = () => {
		const current = config;
		pi.registerTool({
			name: "edit",
			label: "edit",
			description: modeDescription(current),
			promptSnippet: "Edit files using the currently configured edit mode.",
			promptGuidelines: [
				"Use edit for manual file edits when it is active; follow the tool description and grammar for the current edit mode.",
			],
			parameters: modeParameters(),
			renderShell: "self",
			prepareArguments: prepareEditArguments,
			renderCall(params, theme, context) {
				const summary = summarizeEditInput((params as { input?: unknown }).input, current.mode);
				return renderEditCall(summary, (params as { input?: unknown }).input, current, theme, context as any);
			},
			renderResult(result, options, theme, context) {
				return renderEditResult(
					result as ToolTextResult,
					options,
					theme,
					context,
					latestTurnEditToolCallIds,
					() => currentTurnIndex,
					current.mode,
				);
			},
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				markLatestFileopsToolCall(toolCallId);
				onUpdate?.({ content: [{ type: "text", text: "Editing..." }], details: {} });
				return withEditTurnIndex(
					await executeByMode(ctx.cwd, params as EditInput, current, snapshotsForContext(ctx), signal),
					currentTurnIndex,
				);
			},
		});
	};

	registerEditTool();
	registerHashlineWorkflowTools(pi, () => config, snapshotsForContext, {
		latestTurnToolCallIds: latestTurnEditToolCallIds,
		markToolCall: markLatestFileopsToolCall,
		getLatestTurnIndex: () => currentTurnIndex,
	});
	registerAstTools(pi, snapshotsForContext);

	pi.registerCommand("edit-config", {
		description: "Configure edit mode: apply_patch, patch, hashline, or replace",
		getArgumentCompletions: (prefix: string) => {
			const normalizedPrefix = prefix.trimStart();
			const items = EDIT_MODES.filter((mode) => mode.startsWith(normalizedPrefix)).map((mode) => ({
				value: mode,
				label: mode,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const requested = normalizeMode(args.trim());
			const mode =
				requested ??
				(await ctx.ui.select(
					`Edit mode\n\n${formatConfig(config)}`,
					EDIT_MODES.map((mode) => (mode === config.mode ? `${mode} (current)` : mode)),
				));
			const normalized = normalizeMode(String(mode).replace(/\s+\(current\)$/, ""));
			if (!normalized) {
				ctx.ui.notify(`Usage: /edit-config ${EDIT_MODES.join("|")}`, "error");
				return;
			}
			config = { ...config, mode: normalized };
			await saveConfig(config);
			registerEditTool();
			ctx.ui.notify(`edit mode set to ${config.mode}\n${CONFIG_PATH}`, "info");
		},
	});
}
