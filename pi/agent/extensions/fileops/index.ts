import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createFindToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	keyHint,
	type ToolRenderContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Markdown,
	type Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createTwoFilesPatch, diffChars } from "diff";
import { Type } from "typebox";
import { captureContent } from "../context-guard/pi/capture.ts";
import { getCurrentContextGuardSessionId } from "../context-guard/pi/current-session.ts";
import { resolveCommand, runCommand as runExternalCommand } from "../shared/command-runner.ts";
import { renderCompactSummaryLine } from "../shared/compact-summary.ts";
import {
	type ExplorationReadSummaryPart,
	type ExplorationReadSummaryRow,
	getExplorationReadSummary,
	isExplorationHidden,
	readAction,
	registerExplorationEventHandlers,
	registerExplorationTool,
	renderExplorationCall,
	renderExplorationSummaryPart,
	renderExplorationSummaryTitle,
	updateExplorationRead,
} from "../shared/exploration-rendering.ts";
import { githubResourceProvider } from "../shared/github-resources.ts";
import { historyResourceProvider } from "../shared/history-resources.ts";
import { createCircularPreviewImageFromBase64, readPreviewImageFromPath } from "../shared/image-preview.ts";
import { KittyVirtualImage, transmitKittyInlineImageRow } from "../shared/kitty-virtual-image.ts";
import {
	approxTokenCount,
	type BoundedOutput,
	type BoundOutputOptions,
	boundOutput,
	formatTokenCost,
	GREP_MAX_LINE_CHARS,
} from "../shared/output-budget.ts";
import {
	findResources,
	formatResourceUri,
	isResourceUri,
	localResourcePath,
	localResourceRoot,
	parseResourceUri,
	type Resource,
	type ResourceContext,
	ResourceError,
	type ResourceProvider,
	type ResourceRef,
	readResource,
	registerResourceProvider,
	resourceOpenUrl,
	resourceProvider,
	type SearchHit,
	searchResources,
	writeResource,
} from "../shared/resources.ts";
import { detachToolResultImages, registerToolResultImageRestore } from "../shared/tool-result-images.ts";
import {
	EmptyComponent,
	keepBackgroundAcrossResets,
	markLiveTurnStarted,
	paintAnsiBackgroundRow,
	RenderedLineCache,
	runningCellElapsedMs,
	runningFrame,
	sharedAnimationRenderAllowed,
	shouldAnimateRunningCell,
	textComponent,
} from "../shared/tui";
import { type CardBackgroundColor, darkerCardBackgroundAnsi, framedBlock } from "../shared/tui/card.ts";
import { vaultResourceProvider } from "../shared/vault-resources.ts";
import { registerAstTools } from "./ast-tools.ts";
import { buildLineEntriesWithBlockContext } from "./block-context.ts";
import {
	preloadBlockLanguages,
	summarizeCodeStructure,
	treeSitterBlockResolver,
	treeSitterSyntaxValidator,
} from "./block-resolver.ts";
import {
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
	restoreHashlineSnapshots,
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
/** Fallback hit cap for the local resource provider's own search. */
const DEFAULT_SEARCH_RESULT_LIMIT = 200;

/**
 * Search and find cost policy.
 *
 * The model does not set these: `limit` and `context` are accepted and ignored
 * so older prompts degrade to the defaults instead of erroring. Cost is a
 * property of the tool, not of the caller's optimism.
 *
 * The caps are scope-aware because the two scopes fail differently: a tree
 * search must show many files shallowly, while a single-file search is a
 * strided read of that file and must be capped on rows, not on files.
 */
/** Files returned per page, for both search and find. `skip` moves the window. */
const SEARCH_FILE_WINDOW = 20;
/** Matches shown per file when the search spans more than one file. */
const TREE_MATCHES_PER_FILE = 20;
/** Rows shown when every match lives in one file. */
const SINGLE_FILE_ROW_BUDGET = 200;
/**
 * How many raw matches ripgrep is asked for. Deliberately far above what is
 * returned: fetching wide keeps the round-robin selection fair, and the excess
 * never reaches the model.
 */
const INTERNAL_FETCH_LIMIT = 2000;
/**
 * Lines shown around each match. Policy, not a parameter: the model cannot set
 * it, because context expansion is what made a high `limit` expensive. Zero
 * would be cheaper still, but a match with no surrounding lines cannot anchor
 * an edit, so the tool would be cheap and useless.
 */
const SEARCH_CONTEXT_LINES = 2;
/**
 * A `limit`/`ranges` request wider than this is not a bounded read; it is a
 * whole-file read wearing a bound, so the context guard still applies.
 */
const BOUNDED_READ_MAX_LINES = 2000;

const READ_SUMMARY_MIN_LINES = 200;
const READ_SUMMARY_MAX_BYTES = 2 * 1024 * 1024;

type PageWindow<T> = { items: T[]; start: number; end: number; total: number };

/** Take one page from an ordered list. `skip` is clamped, never rejected. */
function pageWindow<T>(items: readonly T[], skip: unknown, size: number): PageWindow<T> {
	const total = items.length;
	const requested = Math.floor(Number(skip ?? 0));
	const start = Number.isFinite(requested) ? Math.max(0, Math.min(requested, total)) : 0;
	const page = items.slice(start, start + size);
	return { items: page, start, end: start + page.length, total };
}

/**
 * Name the next call instead of announcing a dead end.
 *
 * A bare "truncated" tells the model something is missing but not how to reach
 * it, so it retries with a wider `limit` it no longer has. The notice carries
 * the exact `skip` for the next page.
 */
function pagingNotice(window: PageWindow<unknown>, label = "files"): string | undefined {
	if (window.start === 0 && window.end >= window.total) return undefined;
	const shown = `Showing ${label} ${window.start + 1}-${window.end} of ${window.total}.`;
	return window.end < window.total
		? `${shown} Use skip=${window.end} for the next page, or narrow paths/pattern.`
		: shown;
}

/**
 * Interleave per-file lists round-robin so the budget is spread across files
 * rather than spent on whichever file sorts first.
 */
function interleaveByFile<T>(lists: readonly (readonly T[])[], perListCap: number): T[] {
	const selected: T[] = [];
	const depth = Math.min(
		perListCap,
		lists.reduce((max, list) => Math.max(max, list.length), 0),
	);
	for (let index = 0; index < depth; index++) {
		for (const list of lists) {
			const item = list[index];
			if (item !== undefined) selected.push(item);
		}
	}
	return selected;
}
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

/**
 * Lines a read request asks for, or Infinity when it asks for the whole file.
 *
 * The count matters, not the presence of the argument: `limit: 999999` is a
 * whole-file read spelled differently.
 */
function requestedReadLineCount(params: { limit?: number; ranges?: string[] }, ranges: readonly LineRange[]): number {
	if (ranges.length > 0) {
		let total = 0;
		for (const range of ranges) {
			if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return Number.POSITIVE_INFINITY;
			total += Math.max(0, range.end - range.start + 1);
		}
		return total;
	}
	if (params.limit !== undefined) {
		const limit = Math.floor(Number(params.limit));
		return Number.isFinite(limit) ? Math.max(1, limit) : Number.POSITIVE_INFINITY;
	}
	return Number.POSITIVE_INFINITY;
}

function hasBoundedReadRequest(params: { limit?: number; ranges?: string[] }, ranges: readonly LineRange[]): boolean {
	return requestedReadLineCount(params, ranges) <= BOUNDED_READ_MAX_LINES;
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
	// The structure summary is itself unbounded — a large file yields a large
	// outline — so it goes through the same budget as every other read exit.
	const summaryText = boundOutput(
		[...(tag ? [formatHashlineHeader(display, tag)] : []), ...rows, "", footer].join("\n"),
	);
	return {
		content: [{ type: "text", text: summaryText.text }],
		details: {
			outputTokens: summaryText.tokens,
			outputBounded: summaryText.truncated,
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
			"File path or scheme-specific resource URI. Ambient resources omit `current`; explicit authorities select named scopes. Supports file:LINE or file:START-END selectors in hashline mode.",
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
				"Directory, file, or resource URI to search. Resource URI searches use the provider for that scheme.",
		}),
	),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of regex" })),
	skip: Type.Optional(
		Type.Number({ description: "Number of matching files to skip, for paging through a wide result" }),
	),
	ranges: Type.Optional(Type.Array(Type.String({ description: "Single-file line range such as 10 or 10-20" }))),
});

const writeToolSchema = Type.Object({
	path: Type.String({ description: "File path or writable resource URI" }),
	content: Type.String({ description: "Full file content" }),
	makeExecutable: Type.Optional(Type.Boolean({ description: "Mark written file executable" })),
});

const findToolSchema = Type.Object({
	paths: Type.Optional(Type.Array(Type.String({ description: "Glob, path, or resource URI" }))),
	pattern: Type.Optional(Type.String({ description: "Legacy glob pattern or resource URI" })),
	path: Type.Optional(Type.String({ description: "Legacy directory, file, or resource URI" })),
	skip: Type.Optional(Type.Number({ description: "Number of files to skip, for paging through a wide result" })),
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
function resourceRefForPath(path: string): ResourceRef | undefined {
	if (!isResourceUri(path)) return undefined;
	const ref = parseResourceUri(path);
	if (!ref) throw new Error(`Invalid resource URI: ${path}`);
	return ref;
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

async function resourceReadResult(
	result: Awaited<ReturnType<typeof readResource>>,
	params: { offset?: number; limit?: number; raw?: boolean },
	explicitRanges: readonly LineRange[],
	snapshots?: InMemorySnapshotStore,
	cwd?: string,
): Promise<ToolTextResult> {
	const text = normalizeToLf(result.content);
	const resourceSummary = summarizeResource(result.resource, result.content);
	if (params.raw && explicitRanges.length === 0 && params.limit === undefined && params.offset === undefined) {
		return boundedTextResult(
			text,
			{ resource: result.resource, resourceSummary },
			{ cwd, label: result.resource.uri },
		);
	}
	const lines = textToDisplayLines(text);
	const ranges =
		explicitRanges.length > 0
			? mergeLineRanges(explicitRanges)
			: [
					{
						start: Math.max(1, Math.floor(params.offset ?? 1)),
						end:
							params.limit === undefined
								? lines.length
								: Math.max(1, Math.floor(params.offset ?? 1)) - 1 + Math.max(1, Math.floor(params.limit)),
					},
				];
	const entries = selectedLineEntries(lines, ranges);
	if (params.raw) {
		return boundedTextResult(
			entries.map(([, line]) => line).join("\n"),
			{ resource: result.resource, resourceSummary, ranges },
			{ cwd, label: result.resource.uri },
		);
	}
	const observedLines =
		explicitRanges.length > 0 || params.offset !== undefined || params.limit !== undefined
			? { explicit: entries.map(([line]) => line), synthetic: [] }
			: "all";
	const hashlineTag =
		snapshots && Buffer.byteLength(text, "utf8") <= SNAPSHOT_MAX_BYTES
			? recordHashlineSnapshot(snapshots, result.resource.uri, text, observedLines)
			: undefined;
	const startLine = ranges[0]?.start ?? 1;
	const endLine = Math.min(lines.length, ranges.at(-1)?.end ?? lines.length);
	const output = entries.map(([line, value]) => `${line}:${value}`).join("\n");
	const continuation =
		endLine < lines.length
			? `\n\n[${lines.length - endLine} more lines in resource. Use offset=${endLine + 1} to continue.]`
			: "";
	return boundedTextResult(
		`${hashlineTag ? `${formatHashlineHeader(result.resource.uri, hashlineTag)}\n` : ""}${output}${continuation}`,
		{ resource: result.resource, resourceSummary, ranges, offset: startLine, hashlineTag },
		{ cwd, label: result.resource.uri },
	);
}

/**
 * Return text through the shared output budget.
 *
 * Applied at the point the text is produced, so every exit from a read path is
 * capped: the resource paths return before the whole-file guard runs, and used
 * to reach the model uncapped.
 */
/**
 * Store output that exceeded the budget, and name where it went.
 *
 * Paging back through a bounded result costs what the result would have cost.
 * The capture store is full-text indexed, so an artifact reference turns "the
 * rest is gone unless you pay for it again" into a search over the whole thing
 * at the cost of the part you actually need.
 *
 * Fails open: context-guard may be disabled or its core unavailable, and a
 * read is not worth failing over a missing capture.
 */
async function captureFullOutput(text: string, label: string, cwd: string): Promise<string | undefined> {
	try {
		const outcome = await captureContent(
			{ projectDir: cwd, sessionId: getCurrentContextGuardSessionId(), label },
			text,
		);
		return outcome.capture ? `artifact://${outcome.capture.artifactId}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Bound output, capturing the whole of it first when the budget will bite.
 *
 * The capture only runs when text is actually about to be dropped, so the
 * common small result pays nothing for it.
 */
async function boundedWithCapture(
	text: string,
	options: { cwd?: string; label?: string } = {},
	boundOptions: BoundOutputOptions = {},
): Promise<BoundedOutput> {
	const probe = boundOutput(text, boundOptions);
	if (!probe.truncated || !options.cwd) return probe;
	const fullOutputRef = await captureFullOutput(text, options.label ?? "read", options.cwd);
	return fullOutputRef ? boundOutput(text, { ...boundOptions, fullOutputRef }) : probe;
}

async function boundedTextResult(
	text: string,
	details: Record<string, unknown> = {},
	options: { cwd?: string; label?: string } = {},
): Promise<ToolTextResult> {
	const bounded = await boundedWithCapture(text, options);
	// A bounded resource read names how to get the rest. A silently cut payload
	// is worse than an expensive one: the model cannot tell what it is missing,
	// so it either acts on a partial answer or re-fetches the whole thing.
	const continuation = bounded.truncated
		? resourceContinuationRef(bounded.text.split("\n").length, details)
		: undefined;
	const deliveredText = continuation ? `${bounded.text}\n[continue with ${continuation}]` : bounded.text;
	// The cost part is attached here, once, rather than in the renderer: the
	// render path runs on every invalidate, and rebuilding the summary object
	// each pass resets the card and restarts its async avatar loads.
	const summary = details.resourceSummary;
	const withCost =
		summary && typeof summary === "object"
			? { ...details, resourceSummary: { ...summary, costPart: readCostPart(bounded.tokens, bounded.truncated) } }
			: details;
	return {
		content: [{ type: "text", text: deliveredText }],
		details: { ...withCost, outputTokens: approxTokenCount(deliveredText), outputBounded: bounded.truncated },
	};
}

/**
 * Where the rest of a bounded resource read lives.
 *
 * Resource views already accept `?offset=`/`?limit=`, so the continuation is a
 * real call the model can make rather than advice to try something narrower.
 */
function resourceContinuationRef(deliveredLines: number, details: Record<string, unknown>): string | undefined {
	const resource = details.resource;
	if (!resource || typeof resource !== "object") return undefined;
	const uri = (resource as { uri?: unknown }).uri;
	if (typeof uri !== "string" || !uri) return undefined;
	return `${uri}${uri.includes("?") ? "&" : "?"}offset=${deliveredLines}`;
}

/**
 * What a read cost, for the title row.
 *
 * `read` is the largest token consumer in practice. The title row carries
 * roles rather than raw colour, so `high` shares `warning` with `elevated`
 * here instead of the orange the search and find headers use.
 */
function readCostPart(tokens: number, wasBounded: boolean): ExplorationReadSummaryPart | undefined {
	if (tokens <= 0) return undefined;
	const cost = formatTokenCost(tokens, "read");
	const role = cost.severity === "severe" ? "error" : cost.severity === "normal" ? "dim" : "warning";
	return { text: `${cost.text}${wasBounded ? " · bounded" : ""}`, role };
}

type ResourceReadSummary = {
	scheme: ResourceRef["scheme"];
	icon: string;
	iconRole: string;
	label: string;
	title: string;
	subtitle: string;
	titleRole?: string;
	titleItalic?: boolean;
	identifier?: ExplorationReadSummaryPart;
	subtitleUrl?: string;
	meta?: string;
	subtitleStatus?: ResourceStatus;
	metaParts?: ExplorationReadSummaryPart[];
	costPart?: ExplorationReadSummaryPart;
	uri?: ExplorationReadSummaryPart;
	statusLabel?: string;
	statusRole?: string;
	statusSuffix?: string;
	typeIcon?: string;
	hideIcon?: boolean;
	repository?: string;
	repositoryUrl?: string;
	markdown?: string;
	author?: ExplorationReadSummaryPart;
	listDetails?: ExplorationReadSummaryPart[];
	rows?: ExplorationReadSummaryRow[];
	sideRows?: ExplorationReadSummaryRow[];
};

const GITHUB_TYPE_ICON = "";

function resourceSummaryType(scheme: ResourceRef["scheme"]): Pick<ResourceReadSummary, "typeIcon" | "label"> {
	if (scheme === "pr" || scheme === "issue") {
		return {
			typeIcon: GITHUB_TYPE_ICON,
			label: scheme === "pr" ? "PR" : "issue",
		};
	}
	return { label: scheme };
}

function resourceRecord(content: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(content);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}
function resourceData(resource: Resource, content: string): Record<string, unknown> {
	const record = resourceRecord(content);
	return { ...(resource.metadata ?? {}), ...record, ...(!record && content ? { text: content } : {}) };
}

function resourceItemRecords(record: Record<string, unknown>): Record<string, unknown>[] {
	const values = Array.isArray(record.items) ? record.items : Array.isArray(record.nodes) ? record.nodes : [];
	return values.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function resourceString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resourceCount(value: unknown): string | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
	return Number.isFinite(number) ? number.toLocaleString() : undefined;
}
function resourceIdentifier(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function resourceAuthor(value: unknown): string | undefined {
	// Projected payloads carry `author` as a bare login string; raw GitHub
	// payloads carry a user object. Both render.
	if (typeof value === "string") return value.trim() ? `@${value.trim()}` : undefined;
	if (!value || typeof value !== "object") return undefined;
	const author = value as Record<string, unknown>;
	const login = resourceString(author.login);
	return login ? `@${login}` : resourceString(author.name);
}
function githubUserUrl(login: string): string {
	return `https://github.com/${encodeURIComponent(login)}`;
}

function githubRepositoryUrl(repository: string | undefined): string | undefined {
	return repository ? `https://github.com/${repository}` : undefined;
}

function resourceAvatarUrlForLogin(login: string): string {
	return `${githubUserUrl(login)}.png?size=64`;
}

function resourceAvatarUrl(value: unknown): string | undefined {
	// Projected payloads carry the author as a bare login, the same as
	// `resourceAuthor` accepts, so the avatar follows the same two shapes.
	if (typeof value === "string") return value.trim() ? resourceAvatarUrlForLogin(value.trim()) : undefined;
	if (!value || typeof value !== "object") return undefined;
	const author = value as Record<string, unknown>;
	const direct = resourceString(author.avatarUrl) ?? resourceString(author.avatar_url);
	const login = resourceString(author.login);
	return direct ?? (login ? resourceAvatarUrlForLogin(login) : undefined);
}

function resourceAuthorPart(value: unknown): ExplorationReadSummaryPart | undefined {
	const text = resourceAuthor(value);
	if (!text) return undefined;
	const login =
		typeof value === "string"
			? resourceString(value.trim())
			: value && typeof value === "object"
				? resourceString((value as Record<string, unknown>).login)
				: undefined;
	return {
		text,
		role: "muted",
		avatarUrl: resourceAvatarUrl(value),
		url: login ? githubUserUrl(login) : undefined,
	};
}

function resourceStatsParts(record: Record<string, unknown>): ExplorationReadSummaryPart[] {
	const additions = resourceCount(record.additions);
	const deletions = resourceCount(record.deletions);
	const changedFiles = resourceCount(record.changedFiles);
	return [
		additions ? { text: `+${additions}`, role: "toolDiffAdded" } : undefined,
		deletions ? { text: `-${deletions}`, role: "toolDiffRemoved" } : undefined,
		changedFiles ? { text: `${changedFiles} files`, role: "dim" } : undefined,
	].filter((part): part is ExplorationReadSummaryPart => Boolean(part));
}

function resourceTaskRows(record: Record<string, unknown>): ExplorationReadSummaryRow[] {
	const body = resourceString(record.body);
	if (!body) return [];
	const tasks = [...body.matchAll(/^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/gm)].map((match) => ({
		checked: match[1]?.toLowerCase() === "x",
		text: match[2] ?? "",
	}));
	if (tasks.length === 0) return [];
	const completed = tasks.filter((task) => task.checked).length;
	return [
		{
			branch: false,
			icon: "",
			iconRole: "accent",
			text: `tasks ${completed}/${tasks.length}`,
			textRole: "toolTitle",
		},
		...tasks
			.filter((task) => !task.checked)
			.slice(0, 5)
			.map((task) => ({
				branch: false,
				leading: "  ",
				icon: "☐",
				iconRole: "muted",
				text: task.text,
				textRole: "muted",
			})),
	];
}

function resourceTokenCount(content: string): string {
	// Estimated, not tokenized: an exact count pulls in the o200k_base vocabulary, which costs
	// 150ms on an idle machine and near a second on a loaded one, to render one card label.
	return `${approxTokenCount(content).toLocaleString()} tokens`;
}

function resourcePathDisplay(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	const home = homedir().replaceAll("\\", "/").replace(/\/+$/, "");
	if (normalized === home) return "~";
	return normalized.startsWith(`${home}/`) ? `~/${normalized.slice(home.length + 1)}` : normalized;
}

function resourceBodyPreview(value: unknown): string | undefined {
	const body = resourceString(value)?.replace(/\s+/g, " ").trim();
	if (!body) return undefined;
	return body.length > 240 ? `${body.slice(0, 237)}…` : body;
}
function resourceViewLabel(kind: string | undefined): string | undefined {
	const view = kind?.replace(/^pull-request-/, "").replace(/^github-/, "");
	return view && view !== "pr" && view !== "issue" ? view : undefined;
}

/**
 * The URI the card was read from, as a link.
 *
 * Every card is the result of reading one URI, and once the card replaced the
 * loading line that URI was nowhere on screen — so there was no way to tell a
 * `/checks` card from a `/commits` one except by its contents, and no way to
 * copy the address that produced it.
 */
function resourceUriPart(resource: Resource): ExplorationReadSummaryPart {
	return { text: resource.uri, role: "dim", italic: true, url: resourceOpenUrl(resource) };
}

function githubIdentifierPart(
	record: Record<string, unknown>,
	number: string,
	resource?: Resource,
): ExplorationReadSummaryPart {
	return {
		text: `#${number}`,
		role: "mdLink",
		italic: true,
		url: (resource ? resourceOpenUrl(resource) : undefined) ?? resourceString(record.url),
	};
}

// ANSI 256-color slot 165 matches the selected terminal purple.
const MERGED_ANSI_FG = "\x1b[38;5;165m";
const ANSI_FG_RESET = "\x1b[39m";

// ANSI 256-color slot 208 is the orange step between the theme's warning and error roles.
const ORANGE_ANSI_FG = "\x1b[38;5;208m";

function mergedAnsi(text: string): string {
	return `${MERGED_ANSI_FG}${text}${ANSI_FG_RESET}`;
}

/**
 * Render what a tool result cost, coloured by how unusual that cost is.
 *
 * `normal` keeps the subdued card colour so the common case stays quiet; the
 * escalation only appears when the number is worth reading.
 */
function tokenCostLabel(theme: RenderTheme, text: string, toolName: string): string {
	const cost = formatTokenCost(approxTokenCount(text), toolName);
	switch (cost.severity) {
		case "elevated":
			return theme.fg("warning", cost.text);
		case "high":
			return `${ORANGE_ANSI_FG}${cost.text}${ANSI_FG_RESET}`;
		case "severe":
			return theme.fg("error", cost.text);
		default:
			return theme.fg("dim", cost.text);
	}
}
function italicAnsi(text: string): string {
	return `\x1b[3m${text}\x1b[23m`;
}

function purpleStatus(icon: string, label: string): ResourceStatus {
	return { icon: mergedAnsi(icon), iconRole: "text", label: mergedAnsi(label) };
}

function mergedStatus(icon: string): ResourceStatus {
	return purpleStatus(icon, "merged");
}
type ResourceStatus = {
	icon: string;
	iconRole: string;
	label: string;
};

type PullRequestCheckState = "passed" | "skipped" | "failed" | "running";

type PullRequestCheck = {
	name: string;
	state: PullRequestCheckState;
	icon: string;
	iconRole: string;
	finished: boolean;
	rerunning: boolean;
	url?: string;
};

function pullRequestCheck(value: Record<string, unknown>): PullRequestCheck {
	const status = resourceString(value.status)?.toUpperCase();
	const conclusion = resourceString(value.conclusion)?.toUpperCase();
	const state = resourceString(value.state)?.toUpperCase();
	const effectiveState = conclusion ?? state;
	const name = resourceString(value.name) ?? resourceString(value.context) ?? "check";
	const workflow = resourceString(value.workflowName);
	const label = workflow ? `${workflow} / ${name}` : name;
	// A check is the one thing on these cards you always want to open.
	const url =
		resourceString(value.url) ??
		resourceString(value.detailsUrl) ??
		resourceString(value.details_url) ??
		resourceString(value.targetUrl) ??
		resourceString(value.target_url);
	const rerunning =
		value.rerunning === true ||
		Boolean(
			status &&
				["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(status) &&
				conclusion &&
				conclusion !== "SUCCESS",
		);
	const finished =
		status === "COMPLETED" ||
		Boolean(effectiveState && !["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(effectiveState));
	if (effectiveState === "SUCCESS")
		return { name: label, state: "passed", icon: "", iconRole: "success", finished, rerunning, url };
	if (effectiveState === "SKIPPED" || effectiveState === "NEUTRAL")
		return { name: label, state: "skipped", icon: "󱃓", iconRole: "muted", finished, rerunning, url };
	if (effectiveState && ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"].includes(effectiveState)) {
		return { name: label, state: "failed", icon: "", iconRole: "error", finished, rerunning, url };
	}
	if (status === "COMPLETED")
		return { name: label, state: "failed", icon: "", iconRole: "error", finished: true, rerunning, url };
	if (rerunning) return { name: label, state: "running", icon: "", iconRole: "warning", finished, rerunning, url };
	return { name: label, state: "running", icon: "", iconRole: "warning", finished, rerunning, url };
}

function pullRequestChecks(record: Record<string, unknown>): PullRequestCheck[] {
	if (!Array.isArray(record.statusCheckRollup)) return [];
	return record.statusCheckRollup
		.filter((check): check is Record<string, unknown> => !!check && typeof check === "object")
		.map(pullRequestCheck);
}

function pullRequestCheckRows(record: Record<string, unknown>): ExplorationReadSummaryRow[] {
	const checks = pullRequestChecks(record);
	if (checks.length === 0) return [];
	const total = checks.length;
	const passed = checks.filter((check) => check.state === "passed").length;
	const skipped = checks.filter((check) => check.state === "skipped").length;
	const failed = checks.filter((check) => check.state === "failed").length;
	const running = checks.filter((check) => check.state === "running").length;
	const finished = checks.filter((check) => check.finished).length;
	const failedNames = new Set(checks.filter((check) => check.state === "failed").map((check) => check.name));
	const rerunning = checks.some(
		(check) => check.state === "running" && (check.rerunning || failedNames.has(check.name)),
	);
	const suffix = skipped > 0 ? ` (${skipped} skipped)` : "";
	const mergeable =
		resourceString(record.mergeable)?.toUpperCase() === "MERGEABLE" &&
		resourceString(record.mergeStateStatus)?.toUpperCase() === "CLEAN";
	const header =
		running > 0
			? failed > 0
				? {
						icon: rerunning ? "󰲼" : "󱄊",
						iconRole: rerunning ? "warning" : "error",
						text: `Checks running ${running}/${total}${suffix}`,
						textRole: rerunning ? "warning" : "error",
					}
				: finished === 0
					? {
							icon: "",
							iconRole: "muted",
							text: `Checks running ${running}/${total}${suffix}`,
							textRole: "muted",
						}
					: {
							icon: "󰦕",
							iconRole: "warning",
							text: `Checks running ${running}/${total}${suffix}`,
							textRole: "warning",
						}
			: failed > 0
				? { icon: "󰅙", iconRole: "error", text: `Checks failed ${failed}/${total}${suffix}`, textRole: "error" }
				: {
						icon: mergeable ? "" : "",
						iconRole: "success",
						text: `Checks passed ${passed}/${total}${suffix}`,
						textRole: "success",
					};
	const rows: ExplorationReadSummaryRow[] = [{ branch: false, ...header }];
	rows.push(
		...checks
			.filter((check) => check.state === "running" || check.state === "failed")
			.map((check) => ({
				branch: false,
				icon: check.icon,
				iconRole: check.iconRole,
				text: check.name,
				textUrl: check.url,
				textRole: check.iconRole,
			})),
	);
	const visibleCompleted = checks.filter((check) => check.state === "passed" || check.state === "skipped");
	rows.push(
		...visibleCompleted.slice(0, 3).map((check) => ({
			branch: false,
			icon: check.icon,
			iconRole: check.iconRole,
			text: check.name,
			textUrl: check.url,
			textRole: check.iconRole,
		})),
	);
	const remaining = visibleCompleted.length - Math.min(3, visibleCompleted.length);
	if (remaining > 0)
		rows.push({
			branch: false,
			text: `(${remaining} more passing/skipped checks)`,
			textRole: "muted",
			italic: true,
		});
	return rows;
}

function pullRequestStatus(record: Record<string, unknown>): ResourceStatus {
	if (resourceString(record.mergedAt) || resourceString(record.state)?.toUpperCase() === "MERGED")
		return mergedStatus("");
	if (record.isDraft === true) return { icon: "", iconRole: "muted", label: "draft" };
	if (resourceString(record.state)?.toUpperCase() === "CLOSED")
		return { icon: "", iconRole: "error", label: "closed" };
	return { icon: "󰓂", iconRole: "success", label: "open" };
}

/**
 * Why a pull request cannot merge, in the terms the reader is asking about.
 *
 * "not ready" collapsed conflicts, failing checks, missing approval and a stale
 * base into one word, and it was wrong about an approved pull request whose
 * checks were failing. Each blocker names itself, and the check rollup answers
 * first because it is the one that changes while you watch.
 */
function pullRequestMergeability(record: Record<string, unknown>): ResourceStatus {
	if (resourceString(record.mergedAt) || resourceString(record.state)?.toUpperCase() === "MERGED")
		return mergedStatus("");
	if (record.isDraft === true) return { icon: "", iconRole: "muted", label: "draft" };
	const decision = resourceString(record.reviewDecision)?.toUpperCase();
	if (decision === "CHANGES_REQUESTED") return { icon: "", iconRole: "error", label: "changes requested" };
	const mergeState = resourceString(record.mergeStateStatus)?.toUpperCase();
	const conflicting = resourceString(record.mergeable)?.toUpperCase() === "CONFLICTING" || mergeState === "DIRTY";
	if (conflicting) return { icon: "", iconRole: "error", label: "conflicts" };
	const checks = pullRequestChecks(record);
	if (checks.some((check) => check.state === "failed"))
		return { icon: "", iconRole: "error", label: "checks failing" };
	if (checks.some((check) => check.state === "running"))
		return { icon: "", iconRole: "warning", label: "checks running" };
	if (mergeState === "UNSTABLE") return { icon: "", iconRole: "error", label: "checks failing" };
	if (mergeState === "BEHIND") return { icon: "", iconRole: "warning", label: "behind base" };
	if (decision === "REVIEW_REQUIRED") return { icon: "", iconRole: "warning", label: "awaiting approval" };
	if (mergeState === "BLOCKED") return { icon: "", iconRole: "warning", label: "blocked" };
	if (resourceString(record.mergeable)?.toUpperCase() !== "MERGEABLE" || mergeState !== "CLEAN")
		return { icon: "", iconRole: "muted", label: "not ready" };
	return { icon: "", iconRole: "success", label: "ready to merge" };
}

/**
 * Collection views, so an empty one can say so.
 *
 * A `/threads` read that found nothing rendered as an empty card, which reads
 * as a broken renderer rather than as an answer.
 */
const RESOURCE_COLLECTION_KINDS = new Set([
	"pull-request-files",
	"pull-request-threads",
	"pull-request-checks",
	"github-comments",
]);

function resourceEmptyRow(kind: string): ExplorationReadSummaryRow[] {
	const noun = kind.replace(/^(?:pull-request|github)-/, "").replace(/-/g, " ");
	return [{ branch: false, text: `No ${noun}.`, textRole: "muted", italic: true }];
}

/** A review thread carries its comments; a single line of each identifies it. */
function threadComments(record: Record<string, unknown>): Record<string, unknown>[] {
	const comments = record.comments;
	if (!comments || typeof comments !== "object") return [];
	const nodes = (comments as Record<string, unknown>).nodes;
	return Array.isArray(nodes)
		? nodes.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
		: [];
}

/**
 * The body of a single item, as markdown.
 *
 * These cards used to print the raw body one row per line, so a comment full of
 * Graphite's stack markup rendered as a wall of anchor tags. The card already
 * owns a markdown renderer; an item body is exactly what it is for.
 */
function resourceViewMarkdown(record: Record<string, unknown>, kind: string | undefined): string | undefined {
	if (kind === "github-comment") return resourceString(record.body);
	if (kind === "pull-request-thread") {
		const comments = threadComments(record);
		if (comments.length === 0) return resourceString(record.body);
		return comments
			.map((comment) => {
				const author = resourceAuthor(comment.author);
				const body = resourceString(comment.bodyText) ?? resourceString(comment.body) ?? "";
				return author ? `**${author}**\n\n${body}` : body;
			})
			.join("\n\n---\n\n");
	}
	return undefined;
}

function resourceViewRows(record: Record<string, unknown>, kind: string | undefined): ExplorationReadSummaryRow[] {
	if (!kind) return [];
	const items = resourceItemRecords(record);
	if (RESOURCE_COLLECTION_KINDS.has(kind) && items.length === 0) return resourceEmptyRow(kind);
	if (kind === "pull-request-files") {
		return items
			.slice(0, 12)
			.map((file) => {
				const path = resourceString(file.filename) ?? resourceString(file.path) ?? resourceString(file.name);
				if (!path) return undefined;
				const additions = resourceCount(file.additions);
				const deletions = resourceCount(file.deletions);
				return {
					branch: false,
					text: path,
					textUrl: resourceString(file.url),
					textRole: "text",
					details: [
						additions ? { text: `+${additions}`, role: "toolDiffAdded" } : undefined,
						deletions ? { text: `-${deletions}`, role: "toolDiffRemoved" } : undefined,
					].filter((part): part is ExplorationReadSummaryPart => Boolean(part)),
				};
			})
			.filter((row): row is ExplorationReadSummaryRow => Boolean(row));
	}
	if (kind === "pull-request-checks") {
		// The rollup renderer already groups, counts and hides the quiet ones;
		// a checks view is that same list read on purpose.
		return pullRequestCheckRows({ ...record, statusCheckRollup: items });
	}
	if (kind === "pull-request-threads") {
		return items.slice(0, 10).map((thread) => {
			const location = resourceString(thread.path);
			const line = thread.line === undefined || thread.line === null ? undefined : String(thread.line);
			const resolved = thread.isResolved === true;
			const count = resourceCount(thread.comments);
			return {
				branch: false,
				text: location ? `${location}${line ? `:${line}` : ""}` : "thread",
				textUrl: resourceString(thread.url),
				textRole: "text",
				details: [
					{ text: resolved ? "resolved" : "unresolved", role: resolved ? "muted" : "warning" },
					...(count ? [{ text: `${count} comments`, role: "dim" }] : []),
				],
				markdown: resourceString(thread.preview),
			};
		});
	}
	if (kind === "github-comments") {
		return items
			.slice(0, 8)
			.map((comment) => {
				const authorRecord = comment.user ?? comment.author;
				const author = resourceAuthor(authorRecord);
				const body = resourceString(comment.body ?? comment.bodyText);
				const location = resourceString(comment.path);
				const date = resourceString(comment.date ?? comment.created_at)?.slice(0, 10);
				if (!author && !body) return undefined;
				return {
					branch: false,
					avatarUrl: resourceAvatarUrl(authorRecord),
					text: author ?? "comment",
					textUrl: resourceString(comment.url) ?? (author ? githubUserUrl(author.replace(/^@/, "")) : undefined),
					textRole: "muted",
					details: [
						...(location
							? [
									{
										text: `${location}${comment.line === undefined ? "" : `:${String(comment.line)}`}`,
										role: "dim",
									},
								]
							: []),
						...(date ? [{ text: date, role: "dim" }] : []),
					],
					markdown: body,
				};
			})
			.filter((row): row is ExplorationReadSummaryRow => Boolean(row));
	}
	if (kind === "pull-request-thread") {
		const comments = threadComments(record);
		const first = comments[0];
		const location = resourceString(record.path) ?? resourceString(first?.path);
		const line = record.line ?? first?.line;
		const resolved = record.isResolved === true;
		if (!location) return [];
		return [
			{
				branch: false,
				text: `${location}${line === undefined || line === null ? "" : `:${String(line)}`}`,
				textRole: "text",
				details: [
					{ text: resolved ? "resolved" : "unresolved", role: resolved ? "muted" : "warning" },
					{ text: `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`, role: "dim" },
				],
			},
		];
	}
	if (kind === "pull-request-file") {
		const patch = resourceString(record.patch);
		if (!patch) return [];
		return patch
			.split(/\r?\n/)
			.slice(0, 12)
			.map((line) => ({
				branch: false,
				text: line,
				textRole: line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "muted",
			}));
	}
	return [];
}

function historySummary(resource: Resource, ref: ResourceRef, content: string): ResourceReadSummary {
	const messages = content.split(/\n\n(?=\[)/).filter(Boolean);
	const first = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(messages[0] ?? "");
	const preview = resourceBodyPreview(first?.[2] ?? resource.metadata?.text);
	const count = messages.length;
	const role = first?.[1] ?? resourceString(resource.metadata?.role) ?? resource.title;
	return {
		scheme: ref.scheme,
		icon: "",
		iconRole: "accent",
		label: "history",
		title: resource.name,
		subtitle: preview ?? (count === 0 ? "empty message" : `${count} messages`),
		meta: [role, count > 1 ? `${count} messages` : undefined].filter(Boolean).join(" "),
	};
}

function resourceSummaryList(
	resources: readonly Resource[],
	operation: "find" | "search",
	subtitle: string,
	snippets: readonly (string | undefined)[] = [],
): ResourceReadSummary | undefined {
	const summaries = resources.map((resource) => summarizeResource(resource, ""));
	const first = summaries.find((summary): summary is ResourceReadSummary => Boolean(summary));
	if (!first) return undefined;
	const rows: ExplorationReadSummaryRow[] = [];
	for (let index = 0; index < Math.min(resources.length, 24); index++) {
		const resource = resources[index]!;
		const summary = summaries[index];
		const snippet = resourceBodyPreview(snippets[index]);
		const detail = snippet && snippet !== resource.title ? snippet : undefined;
		const title = summary?.title ?? resource.title ?? resource.name;
		const status = summary?.statusLabel;
		const openUrl = resourceOpenUrl(resource);
		const history = summary?.scheme === "history";
		rows.push({
			branch: false,
			icon: summary?.icon ?? "•",
			iconRole: summary?.iconRole ?? "muted",
			prefix: summary?.identifier,
			text: history ? summary.subtitle : (status ?? title),
			textRole: history ? "text" : status ? (summary?.statusRole ?? summary?.iconRole ?? "muted") : "text",
			textUrl: history || !status ? openUrl : undefined,
			details: (history
				? [summary.meta ? { text: summary.meta, role: "muted" } : undefined, { text: title, role: "dim" }]
				: [
						status ? { text: title, role: "text", url: openUrl } : undefined,
						...(summary?.listDetails ?? [summary?.author, detail ? { text: detail, role: "muted" } : undefined]),
					]
			).filter((part): part is ExplorationReadSummaryPart => Boolean(part)),
		});
	}
	if (resources.length > rows.length)
		rows.push({
			branch: false,
			text: `(${resources.length - rows.length} more)`,
			textRole: "muted",
			italic: true,
		});
	const plural =
		first.scheme === "pr"
			? "PRs"
			: first.scheme === "issue"
				? "issues"
				: first.scheme === "history"
					? "messages"
					: "resources";
	const singular =
		first.scheme === "pr"
			? "PR"
			: first.scheme === "issue"
				? "issue"
				: first.scheme === "history"
					? "message"
					: "resource";
	return {
		scheme: first.scheme,
		icon: first.icon,
		iconRole: first.iconRole,
		typeIcon: first.typeIcon ?? first.icon,
		hideIcon: true,
		repository: first.repository,
		repositoryUrl: first.repositoryUrl,
		label: operation,
		title: `${resources.length} ${resources.length === 1 ? singular : plural}`,
		subtitle,
		rows,
	};
}

export function summarizeResource(resource: Resource, content: string): ResourceReadSummary | undefined {
	let ref: ResourceRef | undefined;
	try {
		ref = parseResourceUri(resource.uri);
	} catch {
		return undefined;
	}
	if (!ref) return undefined;
	if (ref.scheme === "history") return historySummary(resource, ref, content);

	const record = resourceData(resource, content);
	const repository = resourceString(record.repository);
	const number = resourceIdentifier(record.number) ?? resourceIdentifier(record.databaseId) ?? resource.name;
	const title = resourceString(record.title) ?? resource.title ?? resource.name;
	if (ref.scheme === "pr") {
		const status = pullRequestStatus(record);
		const view = resourceViewLabel(resource.kind);
		// The view name is not repeated here: the URI at the end of this row
		// already names it, and names the item it belongs to.
		const branch =
			resourceString(record.headRefName) && resourceString(record.baseRefName)
				? `${resourceString(record.baseRefName)}  ${resourceString(record.headRefName)}`
				: "GitHub";
		const mergeability = pullRequestMergeability(record);
		const checkRows = view === "checks" ? [] : pullRequestCheckRows(record);
		const showBody = !view;
		const viewMarkdown = resourceViewMarkdown(record, resource.kind);
		return {
			scheme: ref.scheme,
			icon: status.icon,
			iconRole: status.iconRole,
			statusLabel: status.label,
			statusRole: status.iconRole,
			...resourceSummaryType(ref.scheme),
			repository,
			repositoryUrl: githubRepositoryUrl(repository),
			identifier: githubIdentifierPart(record, number, resource),
			title,
			subtitle: branch,
			subtitleStatus: mergeability,
			author: resourceAuthorPart(record.author),
			markdown: viewMarkdown ?? (showBody ? resourceString(record.text ?? record.body) : undefined),
			metaParts: resourceStatsParts(record),
			uri: resourceUriPart(resource),
			rows: [...resourceViewRows(record, resource.kind), ...(showBody ? [] : resourceTaskRows(record))].filter(
				(row): row is ExplorationReadSummaryRow => Boolean(row),
			),
			sideRows: checkRows,
		};
	}
	if (ref.scheme === "issue") {
		const state = resourceString(record.state)?.toUpperCase();
		const reason = resourceString(record.stateReason)?.toUpperCase();
		const draft = record.isDraft === true;
		const done = reason === "COMPLETED" || state === "DONE";
		const closed = state === "CLOSED";
		const status = draft
			? { icon: "", iconRole: "muted", label: "draft" }
			: done
				? purpleStatus("", "completed")
				: closed
					? { icon: "", iconRole: "error", label: "closed" }
					: { icon: "", iconRole: "success", label: "open" };
		const view = resourceViewLabel(resource.kind);
		const showBody = !view;
		return {
			scheme: ref.scheme,
			icon: status.icon,
			iconRole: status.iconRole,
			statusLabel: status.label,
			statusRole: status.iconRole,
			...resourceSummaryType(ref.scheme),
			repository,
			repositoryUrl: githubRepositoryUrl(repository),
			identifier: githubIdentifierPart(record, number, resource),
			title,
			subtitle: "GitHub",
			statusSuffix: closed && reason && reason !== "COMPLETED" ? italicAnsi(reason.toLowerCase()) : undefined,
			author: resourceAuthorPart(record.author),
			markdown:
				resourceViewMarkdown(record, resource.kind) ??
				(showBody ? resourceString(record.text ?? record.body) : undefined),
			uri: resourceUriPart(resource),
			rows: [...resourceViewRows(record, resource.kind), ...(showBody ? [] : resourceTaskRows(record))].filter(
				(row): row is ExplorationReadSummaryRow => Boolean(row),
			),
		};
	}
	if (ref.scheme === "vault") {
		return {
			scheme: ref.scheme,
			icon: "󱔗",
			iconRole: "accent",
			label: "vault",
			title,
			subtitle: resourcePathDisplay(resource.path ?? ref.path),
			subtitleUrl: resourceOpenUrl(resource),
			meta: resourceTokenCount(content),
		};
	}
	if (ref.scheme === "local") {
		const path = resource.path ?? ref.path;
		return {
			scheme: ref.scheme,
			icon: "",
			iconRole: "accent",
			label: "local",
			title,
			subtitle: resourcePathDisplay(path),
			subtitleUrl: resourceOpenUrl(resource),
			meta: resourceTokenCount(content),
		};
	}
	if (ref.scheme === "skill") {
		const skillName = resourceString(resource.metadata?.skillName) ?? ref.authority;
		const sourcePath = resourceString(resource.metadata?.sourcePath) ?? resource.path;
		const subtitle = sourcePath
			? resourcePathDisplay(sourcePath)
			: ref.path
				? resourcePathDisplay(ref.path)
				: resource.uri;
		const tokens = resourceCount(resource.metadata?.tokens);
		return {
			scheme: ref.scheme,
			icon: "",
			iconRole: "accent",
			label: "skill",
			title: skillName,
			titleRole: "success",
			titleItalic: true,
			subtitle,
			subtitleUrl: resourceOpenUrl(resource),
			meta: tokens ? `${tokens} tokens` : resourceTokenCount(content),
		};
	}
	return undefined;
}

function resourceContextText(resource: Resource, snippet?: string): string {
	const summary = summarizeResource(resource, "");
	return [
		resource.uri,
		resource.title ? `title: ${resource.title}` : undefined,
		summary?.author ? `author: ${summary.author.text}` : undefined,
		summary?.statusLabel ? `status: ${summary.statusLabel}` : undefined,
		snippet && snippet !== resource.title ? `match: ${snippet}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function halfBackground(line: string, glyph: "▄" | "▀", width: number): string {
	const background = line.match(/\x1b\[48(?:;[0-9]+)*m/)?.[0];
	return background ? `${background.replace("[48", "[38")}${glyph.repeat(width)}\x1b[39m` : line;
}
type AvatarImageData = { base64Data: string; mimeType: string; sourcePath?: string };
const avatarImageCache = new Map<string, Promise<AvatarImageData | undefined>>();

function cachedAvatarImage(url: string): Promise<AvatarImageData | undefined> {
	const cached = avatarImageCache.get(url);
	if (cached) return cached;
	const pending = fetch(url, { signal: AbortSignal.timeout(5_000) })
		.then(async (response) => {
			if (!response.ok) return undefined;
			const mimeType = (response.headers.get("content-type") ?? "image/png").split(";", 1)[0] ?? "image/png";
			if (!mimeType.startsWith("image/")) return undefined;
			const base64Data = Buffer.from(await response.arrayBuffer()).toString("base64");
			const preview = await createCircularPreviewImageFromBase64(base64Data, mimeType);
			if (preview) return { base64Data: preview.data, mimeType: preview.mimeType, sourcePath: preview.sourcePath };
			return mimeType === "image/png" ? { base64Data, mimeType } : undefined;
		})
		.catch(() => undefined);
	avatarImageCache.set(url, pending);
	return pending;
}

class InlineAvatar {
	private base64Data?: string;
	private sourcePath?: string;
	private placeholder?: string;

	constructor(
		url: string,
		private readonly onInvalidate: () => void,
	) {
		void cachedAvatarImage(url).then((data) => {
			if (!data) return;
			this.base64Data = data.base64Data;
			this.sourcePath = data.sourcePath;
			this.placeholder = undefined;
			this.onInvalidate();
		});
	}

	render(): string {
		if (getCapabilities().images !== "kitty" || !this.base64Data) return "";
		if (this.placeholder) return this.placeholder;
		this.placeholder = transmitKittyInlineImageRow(this.base64Data, 2, this.sourcePath);
		return this.placeholder;
	}
}

class ResourceSummaryCard implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		private readonly box: Box,
		private readonly theme: RenderTheme,
		private readonly visible: () => boolean,
	) {}

	render(width: number): string[] {
		if (!this.visible()) return [];
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		const background =
			darkerCardBackgroundAnsi(this.theme, "toolPendingBg") ?? this.theme.bg?.("toolPendingBg", " ").split(" ")[0];
		const lines = this.box.render(width).map((line) => paintAnsiBackgroundRow(line, width, background));
		if (lines.length >= 2) {
			lines[0] = halfBackground(lines[0]!, "▄", width);
			lines[lines.length - 1] = halfBackground(lines.at(-1)!, "▀", width);
		}
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.box.invalidate();
	}
}

function renderResourceSummaryPart(
	part: ExplorationReadSummaryPart,
	theme: RenderTheme,
	avatarFor: (url: string | undefined) => string,
): string {
	const avatar = avatarFor(part.avatarUrl);
	return `${avatar ? `${avatar} ` : ""}${renderExplorationSummaryPart(part, theme)}`;
}

function renderResourceSummaryMeta(
	summary: ResourceReadSummary,
	theme: RenderTheme,
	avatarFor: (url: string | undefined) => string,
): string {
	const parts = [
		...(summary.metaParts ?? (summary.meta ? [{ text: summary.meta }] : [])),
		...(summary.uri ? [summary.uri] : []),
	];
	if (parts.length === 0) return "";
	const separator = theme.fg("dim", " · ");
	return ` ${theme.fg("dim", "·")} ${parts.map((part) => renderResourceSummaryPart(part, theme, avatarFor)).join(separator)}`;
}

function renderResourceSummaryRow(
	row: ExplorationReadSummaryRow,
	index: number,
	total: number,
	theme: RenderTheme,
	avatarFor: (url: string | undefined) => string,
	width?: number,
): string {
	const branch = row.branch === false ? "" : theme.fg("dim", `${index === total - 1 ? "└─" : "├─"} `);
	const leading = row.leading
		? row.leading.trim()
			? theme.fg(row.leadingRole ?? "muted", row.leading)
			: row.leading
		: "";
	const avatar = avatarFor(row.avatarUrl);
	const icon = row.icon ? `${theme.fg(row.iconRole ?? "muted", row.icon)} ` : "";
	const rowPrefix = row.prefix ? `${renderResourceSummaryPart(row.prefix, theme, avatarFor)} ` : "";
	const rowText = row.italic ? `\x1b[3m${row.text}\x1b[23m` : row.text;
	const styledRowText = row.bold ? theme.bold(rowText) : rowText;
	const body = row.textUrl
		? renderExplorationSummaryPart({ text: styledRowText, role: row.textRole, url: row.textUrl }, theme)
		: theme.fg(row.textRole ?? "muted", styledRowText);
	const details = row.details
		?.map((part) => renderResourceSummaryPart(part, theme, avatarFor))
		.join(theme.fg("dim", " · "));
	const prefix = `${branch}${leading}${avatar ? `${avatar} ` : ""}${icon}${rowPrefix}${body}${details ? `${theme.fg("dim", " · ")}${details}` : ""}`;
	const status = row.status ? renderResourceSummaryPart(row.status, theme, avatarFor) : "";
	if (!status) return prefix;
	if (width === undefined) return `${prefix} ${status}`;
	const bodyWidth = Math.max(1, width - visibleWidth(status) - 1);
	const clippedPrefix = truncateToWidth(prefix, bodyWidth);
	return `${clippedPrefix}${" ".repeat(Math.max(1, width - visibleWidth(clippedPrefix) - visibleWidth(status)))}${status}`;
}
function resourceSummaryHeaderLines(
	summary: ResourceReadSummary,
	theme: RenderTheme,
	avatarFor: (url: string | undefined) => string,
	width: number,
): string[] {
	const subtitle = `${renderExplorationSummaryPart(
		{ text: summary.subtitle, role: "mdLink", url: summary.subtitleUrl },
		theme,
	)}${renderResourceSummaryMeta(summary, theme, avatarFor)}`;
	const subtitleStatus = summary.subtitleStatus
		? `${theme.fg(summary.subtitleStatus.iconRole, summary.subtitleStatus.icon)} ${theme.fg(
				summary.subtitleStatus.iconRole,
				summary.subtitleStatus.label,
			)}`
		: "";
	const subtitleLine = subtitleStatus
		? (mergeResourceColumns([subtitle], [` ${subtitleStatus}`], width)?.[0] ?? subtitle)
		: subtitle;
	if (summary.typeIcon) {
		const summaryLine = renderExplorationSummaryTitle(summary, theme, true);
		const author = summary.author ? renderResourceSummaryPart(summary.author, theme, avatarFor) : "";
		if (!author) return [summaryLine, subtitleLine];
		const authorLine = mergeResourceColumns([summaryLine], [` ${author}`], width)?.[0];
		if (authorLine) return [authorLine, subtitleLine];
		const right = truncateToWidth(author, Math.max(1, width - 2));
		const left = truncateToWidth(summaryLine, Math.max(1, width - visibleWidth(right) - 1));
		return [
			`${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${right}`,
			subtitleLine,
		];
	}
	if (summary.scheme === "history") {
		return [
			renderCompactSummaryLine(theme, {
				icon: summary.icon,
				label: summary.label,
				name: summary.title,
			}),
			subtitleLine,
		];
	}
	return [
		renderCompactSummaryLine(theme, {
			icon: summary.icon,
			label: summary.label,
			name: summary.title,
			path: summary.subtitle,
			meta: summary.meta,
			pathUrl: summary.subtitleUrl,
		}),
	];
}

function padResourceLine(line: string, width: number): string {
	const fitted = truncateToWidth(line, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function resourceRightColumnWidth(width: number): number {
	return Math.min(42, Math.max(24, Math.floor(width * 0.32)));
}

function mergeResourceColumns(left: string[], right: string[], width: number): string[] | undefined {
	const rightWidth = resourceRightColumnWidth(width);
	const leftWidth = width - rightWidth - 3;
	if (leftWidth < 36) return undefined;
	const lines: string[] = [];
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const leftLine = padResourceLine(left[index] ?? "", leftWidth);
		const rightLine = right[index] ?? "";
		lines.push(truncateToWidth(`${leftLine}  ${rightLine}`, width));
	}
	return lines;
}

/**
 * The body of a bare read gets at least this many lines before it is cut.
 *
 * The card is as tall as its tallest column, so a body cut at ten lines beside
 * a twenty-row check column left ten lines of empty card and lost text for
 * nothing. Ten is the floor, the side column raises it.
 */
const RESOURCE_BODY_MIN_LINES = 10;

/** A listing row's body: enough to read the point, not the whole comment. */
const RESOURCE_ROW_BODY_MAX_LINES = 6;

class ResourceSummaryText implements Component {
	private readonly avatars = new Map<string, InlineAvatar>();
	private readonly markdown?: Markdown;
	// Keyed by row identity so a re-render reuses the same instance.
	private readonly rowMarkdown = new Map<ExplorationReadSummaryRow, Markdown>();

	constructor(
		private readonly summary: ResourceReadSummary,
		private readonly theme: RenderTheme,
		onInvalidate: () => void,
	) {
		const markdownFor = (text: string) =>
			new Markdown(text, 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("text", value) });
		this.markdown = summary.markdown ? markdownFor(summary.markdown) : undefined;
		for (const row of summary.rows ?? []) if (row.markdown) this.rowMarkdown.set(row, markdownFor(row.markdown));
		if (getCapabilities().images !== "kitty") return;
		const addAvatar = (url: string | undefined) => {
			if (url && !this.avatars.has(url)) this.avatars.set(url, new InlineAvatar(url, onInvalidate));
		};
		for (const part of summary.metaParts ?? []) addAvatar(part.avatarUrl);
		addAvatar(summary.author?.avatarUrl);
		for (const row of [...(summary.rows ?? []), ...(summary.sideRows ?? [])]) {
			addAvatar(row.avatarUrl);
			for (const detail of row.details ?? []) addAvatar(detail.avatarUrl);
			addAvatar(row.status?.avatarUrl);
		}
	}

	render(width: number): string[] {
		const avatarFor = (url: string | undefined) => (url ? (this.avatars.get(url)?.render() ?? "") : "");
		const header = resourceSummaryHeaderLines(this.summary, this.theme, avatarFor, width).map((line) => ` ${line}`);
		const rows = this.summary.rows ?? [];
		const footer = rows.filter((row) => row.footer);
		const visibleRows = rows.filter((row) => !row.footer);
		const rightWidth = resourceRightColumnWidth(width);
		const right = (this.summary.sideRows ?? []).map(
			(row, index, sideRows) =>
				` ${renderResourceSummaryRow(row, index, sideRows.length, this.theme, avatarFor, Math.max(1, rightWidth - 1))}`,
		);
		const leftWidth = width - rightWidth - 3;
		const markdownWidth = right.length > 0 && leftWidth >= 36 ? leftWidth - 1 : width - 2;
		const left = visibleRows.flatMap((row, index) => {
			const line = ` ${renderResourceSummaryRow(row, index, visibleRows.length, this.theme, avatarFor)}`;
			const body = this.rowMarkdown.get(row);
			if (!body) return [line];
			const rendered = body
				.render(Math.max(1, markdownWidth - 3))
				.slice(0, RESOURCE_ROW_BODY_MAX_LINES)
				.map((bodyLine) => `   ${bodyLine}`);
			return [line, ...rendered];
		});
		const renderedMarkdown = this.markdown?.render(Math.max(1, markdownWidth)) ?? [];
		const bodyBudget = Math.max(RESOURCE_BODY_MIN_LINES, right.length - left.length);
		const markdown = renderedMarkdown.slice(0, bodyBudget).map((line) => ` ${line}`);
		if (renderedMarkdown.length > markdown.length) markdown.push(` ${this.theme.fg("muted", "… body truncated")}`);
		const leftColumn = [...markdown, ...left];
		const body =
			right.length === 0
				? leftColumn
				: (mergeResourceColumns(leftColumn, right, width) ?? [...right, ...leftColumn]);
		const footerLines = footer.map(
			(row, index) => ` ${renderResourceSummaryRow(row, index, footer.length, this.theme, avatarFor)}`,
		);
		return [...header, ...body, ...footerLines];
	}

	invalidate(): void {
		this.markdown?.invalidate();
		for (const markdown of this.rowMarkdown.values()) markdown.invalidate();
	}
}

function renderResourceSummaryCard(
	summary: ResourceReadSummary,
	theme: RenderTheme,
	invalidate: () => void = () => {},
	visible: () => boolean = () => true,
): Component {
	const box = new Box(1, 1, (text) => text);
	box.addChild(
		new ResourceSummaryText(summary, theme, () => {
			box.invalidate();
			invalidate();
		}),
	);
	return new ResourceSummaryCard(box, theme, visible);
}
function resourceLoadingIcon(scheme: ResourceRef["scheme"]): string {
	if (scheme === "pr" || scheme === "issue") return GITHUB_TYPE_ICON;
	if (scheme === "history") return "";
	if (scheme === "vault") return "󱔗";
	if (scheme === "skill") return "";
	return "≡";
}

function renderResourceLoading(
	operation: "read" | "search" | "find",
	path: string,
	theme: RenderTheme,
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
): Component | undefined {
	let ref: ResourceRef | undefined;
	try {
		ref = parseResourceUri(path);
	} catch {
		return undefined;
	}
	if (!ref) return undefined;
	const identity = `resource:${operation}:${formatResourceUri(ref)}`;
	if (context?.lastComponent instanceof BlockTextView && context.lastComponent.matches(identity))
		return context.lastComponent;
	const label = operation === "read" ? "reading" : operation === "search" ? "searching" : "finding";
	const frame = () => runningFrame(streamingElapsedMs(context, true), EDIT_FRAME_MS);
	return new BlockTextView(
		() => {
			scheduleStreamingInvalidation(context, true);
			const uri = formatResourceUri(ref);
			const renderedUri = renderExplorationSummaryPart(
				{ text: uri, role: "mdLink", italic: true, url: resourceOpenUrl(uri, { cwd: context?.cwd }) },
				theme,
			);
			return `${theme.fg("text", resourceLoadingIcon(ref.scheme))}  ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("warning", frame())} ${renderedUri}`;
		},
		theme,
		() => context?.isPartial === true,
		frame,
		null,
		identity,
	);
}

class ResourceReadCardView implements Component {
	private card?: Component;
	private cardSummary?: ResourceReadSummary;
	private resolvedSummary?: ResourceReadSummary;
	private cardInitialized = false;

	constructor(
		private readonly displayPath: string,
		private readonly loading: Component,
		private readonly theme: RenderTheme,
		private readonly context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
	) {}
	matches(displayPath: string): boolean {
		return this.displayPath === displayPath;
	}
	setSummary(summary: ResourceReadSummary): void {
		this.resolvedSummary = summary;
		this.cardInitialized = false;
		this.invalidate();
	}

	render(width: number): string[] {
		renderExplorationCall(readAction(this.displayPath, this.context?.cwd), this.theme, this.context);
		if (isExplorationHidden(this.context?.toolCallId)) return [];
		const summary = this.resolvedSummary ?? getExplorationReadSummary(this.context?.toolCallId);
		if (!summary) return this.loading.render(width);
		if (!this.cardInitialized || this.cardSummary !== summary) {
			this.cardSummary = summary;
			this.card = renderResourceSummaryCard(summary, this.theme, this.context?.invalidate ?? (() => {}));
			this.cardInitialized = true;
		}
		return this.card?.render(width) ?? [];
	}

	invalidate(): void {
		this.loading.invalidate();
		this.card?.invalidate();
	}
}

function renderResourceReadResult(
	result: ToolTextResult,
	options: { expanded?: boolean },
	theme: RenderTheme,
	toolCallId?: string,
	invalidate: () => void = () => {},
	lastComponent?: Component,
): Component | undefined {
	const summary = result.details?.resourceSummary;
	if (!summary || typeof summary !== "object") return undefined;
	const typedSummary = summary as ResourceReadSummary;
	const readCard = lastComponent instanceof ResourceReadCardView ? lastComponent : undefined;
	readCard?.setSummary(typedSummary);
	const inExploration = updateExplorationRead(toolCallId, typedSummary);
	if (!options.expanded && inExploration) return EMPTY_VIEW;
	const card = readCard ?? renderResourceSummaryCard(typedSummary, theme, invalidate);
	const expanded = options.expanded
		? renderPlainReadResult(firstTextContent(result), result, { expanded: true }, theme)
		: EMPTY_VIEW;
	if (expanded === EMPTY_VIEW) return card;
	const container = new Container();
	container.addChild(card);
	container.addChild(expanded);
	return container;
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
		private readonly identity?: string,
	) {}

	matches(identity: string): boolean {
		return this.identity === identity;
	}

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

export function shortenDisplayPath(path: string, cwd = process.cwd()): string {
	const normalized = path.replace(/\\/g, "/");
	if (isResourceUri(normalized)) return normalized;

	const expanded =
		normalized === "~" ? homedir() : normalized.startsWith("~/") ? join(homedir(), normalized.slice(2)) : normalized;
	const root = resolve(cwd);
	const absolute = resolve(root, expanded);
	const projectRelative = relative(root, absolute).replace(/\\/g, "/");
	if (
		projectRelative === "" ||
		(!projectRelative.startsWith("../") && projectRelative !== ".." && !isAbsolute(projectRelative))
	) {
		return projectRelative || ".";
	}

	const home = resolve(homedir());
	const homeRelative = relative(home, absolute).replace(/\\/g, "/");
	if (absolute === home) return "~";
	if (!homeRelative.startsWith("../") && homeRelative !== ".." && !isAbsolute(homeRelative))
		return `~/${homeRelative}`;
	return absolute;
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
	diagnostics: string[];
};

function parseHashlineSections(text: string): HashlineRenderSection[] {
	const sections: HashlineRenderSection[] = [];
	let current: HashlineRenderSection | undefined;
	for (const line of toolTextLines(text)) {
		const header = /^(\[(.+?)#[0-9A-Fa-f]{4}\])$/.exec(line);
		if (header) {
			current = { header: header[1] ?? line, path: header[2] ?? "", rows: [], diagnostics: [] };
			sections.push(current);
			continue;
		}
		if (!current || line.length === 0) continue;
		if (
			line.startsWith("Use a narrower path") ||
			/^\[(?:Search results truncated|Find results truncated|\d+ more lines in (?:file|resource))/.test(line)
		) {
			current.diagnostics.push(line);
		} else if (!line.startsWith("[")) {
			current.rows.push(line);
		}
	}
	return sections;
}

function renderHashlineHeader(header: string, theme: RenderTheme): string {
	const match = /^(\[.+?)(#[0-9A-Fa-f]{4}\])?$/.exec(header);
	if (!match) return theme.fg("accent", header);
	return `${theme.fg("accent", match[1] ?? "")}${match[2] ? theme.fg("toolDiffAdded", match[2]) : ""}`;
}

function readDisplay(
	params: { path?: string; offset?: number; limit?: number; ranges?: string[] },
	cwd = process.cwd(),
): string {
	const path = typeof params.path === "string" ? splitReadPathSelector(params.path).path : undefined;
	return path ? `${shortenDisplayPath(path.replace(/\\/g, "/"), cwd)}${formatReadLineRange(params)}` : "[invalid]";
}

function renderReadCall(
	params: { path?: string; offset?: number; limit?: number; ranges?: string[] },
	theme: RenderTheme,
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
): Component {
	const rawPath = typeof params.path === "string" ? splitReadPathSelector(params.path).path : undefined;
	const displayPath = readDisplay(params, context?.cwd ?? process.cwd());
	if (rawPath && isResourceUri(rawPath)) {
		if (context?.isError === true) return EMPTY_VIEW;
		if (context?.lastComponent instanceof ResourceReadCardView && context.lastComponent.matches(displayPath))
			return context.lastComponent;
		const loading = renderResourceLoading("read", rawPath, theme, context);
		return loading ? new ResourceReadCardView(displayPath, loading, theme, context) : EMPTY_VIEW;
	}
	return new BlockTextView(() => renderExplorationCall(readAction(displayPath, context?.cwd), theme, context), theme);
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
	options: { expanded?: boolean; isPartial?: boolean; isError?: boolean },
	theme: RenderTheme,
	toolCallId?: string,
	invalidate: () => void = () => {},
	lastComponent?: Component,
): Component {
	if (options.isPartial) return EMPTY_VIEW;
	if (options.isError) return renderText(theme.fg("error", firstTextContent(result).trim() || "Read failed."));
	const resource = renderResourceReadResult(result, options, theme, toolCallId, invalidate, lastComponent);
	if (resource) return resource;
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

function resourceDetailsList(result: ToolTextResult, key: string): Resource[] {
	const value = result.details?.[key];
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is Resource =>
			Boolean(item) && typeof item === "object" && typeof (item as Resource).uri === "string",
	);
}

function renderResourceListCard(
	resources: readonly Resource[],
	operation: "find" | "search",
	subtitle: string,
	theme: RenderTheme,
	visible: () => boolean,
	snippets: readonly (string | undefined)[] = [],
): Component | undefined {
	const summary = resourceSummaryList(resources, operation, subtitle, snippets);
	return summary ? renderResourceSummaryCard(summary, theme, () => {}, visible) : undefined;
}

function renderSearchCall(
	params: { pattern?: unknown; path?: unknown },
	theme: RenderTheme,
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
): Component {
	if (context?.isPartial !== true || typeof params.path !== "string" || !isResourceUri(params.path)) return EMPTY_VIEW;
	return renderResourceLoading("search", params.path, theme, context) ?? EMPTY_VIEW;
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
	cwd: string,
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
		const linkedPath = renderExplorationSummaryPart(
			{ text: section.path, role: "mdLink", url: pathToFileURL(resolve(cwd, section.path)).href },
			theme,
		);
		lines.push(`${theme.fg("dim", `${branch} ${fileIcon(theme, section.path)} `)}${linkedPath}`);
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
		for (const diagnostic of section.diagnostics)
			lines.push(`${theme.fg("dim", continuation)}${theme.fg("muted", diagnostic)}`);
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
	const resources = resourceDetailsList(result, "resources");
	if (resources.length > 0) {
		const resourceCard = renderResourceListCard(
			resources,
			"search",
			`query: ${pattern} · scope: ${shortenDisplayPath(noMatchPath)}`,
			theme,
			shouldRender,
			resources.map((resource) => (resource as SearchHit).snippet),
		);
		if (resourceCard) return resourceCard;
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
		` ${theme.fg("warning", pattern)} ${theme.fg("dim", `${matchCount} match${matchCount === 1 ? "" : "es"} · ${fileText} · in ${shortenDisplayPath(path ?? ".")} · `)}${tokenCostLabel(theme, text, "search")}`,
	);
	return framedBlock(theme, {
		header,
		sections: [
			{
				component: new BlockTextView(
					renderSearchSections(sections, theme, options.expanded ?? false, pattern, context?.cwd ?? process.cwd()),
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

function findRequestTarget(args: { paths?: string[]; pattern?: unknown; path?: unknown }): string {
	if (Array.isArray(args.paths) && args.paths.length > 0) return args.paths.join(", ");
	if (typeof args.pattern === "string") return args.pattern;
	if (typeof args.path === "string") return args.path;
	return ".";
}

function findRequestWhere(args: { paths?: string[]; path?: unknown }): string {
	const first = args.paths?.[0];
	if (first) return isResourceUri(first) ? first : dirname(first);
	return typeof args.path === "string" ? args.path : ".";
}

function renderFindCall(
	params: { paths?: string[]; pattern?: unknown; path?: unknown },
	theme: RenderTheme,
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
): Component {
	if (context?.isPartial !== true) return EMPTY_VIEW;
	const target = findRequestTarget(params);
	if (isResourceUri(target)) return renderResourceLoading("find", target, theme, context) ?? EMPTY_VIEW;
	return framedBlock(theme, {
		header: renderStatusHeader(
			"Find:",
			theme,
			` ${theme.fg("warning", shortenDisplayPath(target))} ${theme.fg("dim", `in ${shortenDisplayPath(findRequestWhere(params))}`)}`,
			"pending",
		),
		sections: [{ lines: [theme.fg("muted", "Finding files...")] }],
		borderColor: "borderMuted",
		backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
		visible: () => context?.isPartial === true,
	});
}

function renderFindResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	args?: { paths?: string[]; pattern?: unknown; path?: unknown },
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
	latestTurnToolCallIds: ReadonlySet<string> = EMPTY_TOOL_CALL_IDS,
	getLatestTurnIndex: () => number | undefined = () => undefined,
): Component {
	const request = args ?? {};
	if (options.isPartial) return renderFindCall(request, theme, context);
	const shouldRender = () =>
		shouldRenderLatestToolResult(result, context, latestTurnToolCallIds, getLatestTurnIndex());
	if (!shouldRender()) return EMPTY_VIEW;
	const resources = resourceDetailsList(result, "resources");
	if (resources.length > 0) {
		const resourceCard = renderResourceListCard(
			resources,
			"find",
			`scope: ${shortenDisplayPath(findRequestWhere(request))}`,
			theme,
			shouldRender,
		);
		if (resourceCard) return resourceCard;
	}
	const output = firstTextContent(result).trim();
	if (/not found on PATH|failed|error/i.test(output.split("\n")[0] ?? "")) {
		return framedBlock(theme, {
			header: renderStatusHeader("Find:", theme, "", "error"),
			sections: [{ lines: [theme.fg("error", output)] }],
			borderColor: "error",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolErrorBg"),
			visible: shouldRender,
		});
	}
	const outputLines = toolTextLines(output).filter(Boolean);
	const noResults = /^No (?:files|resources) found\b/i.test(output);
	const diagnostics = outputLines.filter((line) => /^(?:Showing \w+ \d|\[output bounded\b)/.test(line));
	const files = noResults ? [] : outputLines.filter((line) => !diagnostics.includes(line));
	const target = findRequestTarget(request);
	const where = findRequestWhere(request);
	const header = renderStatusHeader(
		"Find:",
		theme,
		` ${theme.fg("warning", shortenDisplayPath(target))} ${theme.fg("dim", `${files.length} file${files.length === 1 ? "" : "s"} · in ${shortenDisplayPath(where)} · `)}${tokenCostLabel(theme, output, "find")}`,
	);
	const shown = files.slice(0, options.expanded ? files.length : 20);
	const lines =
		shown.length > 0
			? shown.map((file, index) => {
					const linkedPath = renderExplorationSummaryPart(
						{
							text: shortenDisplayPath(file),
							role: "mdLink",
							url: pathToFileURL(resolve(context?.cwd ?? process.cwd(), file)).href,
						},
						theme,
					);
					return `${theme.fg("dim", `${index === shown.length - 1 ? treeLast(theme) : treeBranch(theme)} ${fileIcon(theme, file)} `)}${linkedPath}`;
				})
			: [theme.fg("muted", output || "No files found")];
	if (files.length > shown.length) {
		lines.push(
			`${theme.fg("muted", `... (${files.length - shown.length} more files, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
		);
	}
	for (const diagnostic of diagnostics) lines.push(theme.fg("muted", diagnostic));
	return framedBlock(theme, {
		header,
		sections: [{ lines }],
		borderColor: "borderMuted",
		backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
		visible: shouldRender,
		cacheKey: () => (options.expanded ? "expanded" : "collapsed"),
	});
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
	resourceContext?: ResourceContext,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: EditToolDetails }> {
	const normalized = normalizeReplaceInput(input);
	const resource = resourceRefForPath(normalized.path);
	const target = resource ? formatResourceUri(resource) : absolutePath(cwd, normalized.path);
	return withFileMutationQueue(target, async () => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const raw = resource ? (await readResource(resource, resourceContext)).content : await readFile(target, "utf-8");
		const { bom, text } = stripBom(raw);
		const lineEnding = detectLineEnding(text);
		const before = normalizeToLf(text);
		const applied = applyNormalizedReplace(before, normalized, config);
		const current = applied.text;
		const total = applied.total;
		if (current === before) throw new Error(`Edits to ${normalized.path} resulted in no changes being made.`);
		const persisted = bom + restoreLineEndings(current, lineEnding);
		if (resource) {
			await writeResource(resource, { content: persisted, expectedContent: raw, context: resourceContext });
		} else {
			await writeFile(target, persisted, "utf-8");
		}

		const patch = createTwoFilesPatch(normalized.path, normalized.path, before, current, "", "", { context: 3 });
		return {
			content: [
				{
					type: "text",
					text: `Successfully replaced ${total} occurrence${total === 1 ? "" : "s"} in ${normalized.path}.`,
				},
			],
			details: { diff: patch, patch, firstChangedLine: firstChangedLine(before, current) },
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

function localResourceUri(path: string, context: Pick<ResourceContext, "sessionId">): string {
	const root = resolve(localResourceRoot(context));
	const relativePath = relative(root, resolve(path)).replaceAll("\\", "/");
	return formatResourceUri({
		scheme: "local",
		authority: "current",
		path: relativePath ? `/${relativePath}` : "",
		query: {},
	});
}

function localResource(uri: string, path: string, metadata: Awaited<ReturnType<typeof stat>>): Resource {
	return {
		uri,
		name: path.split("/").at(-1) || path,
		kind: metadata.isDirectory() ? "directory" : "file",
		mediaType: metadata.isDirectory() ? "inode/directory" : "text/plain",
		size: metadata.isFile() ? metadata.size : undefined,
		path,
		modifiedAt: metadata.mtime.toISOString(),
	};
}

async function localFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await localFiles(path)));
		else files.push(path);
	}
	return files;
}

function localResourceProvider(baseCwd: string): ResourceProvider {
	return {
		async read(ref, context) {
			const path = localResourcePath(ref, context ?? {});
			if (!ref.path) await mkdir(path, { recursive: true });
			const metadata = await stat(path);
			if (metadata.isDirectory()) {
				const files = await localFiles(path);
				const content =
					files.length === 0
						? "(empty)\n"
						: `${files.map((file) => localResourceUri(file, context ?? {})).join("\n")}\n`;
				return { resource: localResource(formatResourceUri(ref), path, metadata), content };
			}
			return {
				resource: localResource(formatResourceUri(ref), path, metadata),
				content: await readFile(path, "utf-8"),
			};
		},
		async search(request): Promise<SearchHit[]> {
			if (!request.scope || request.scope.scheme !== "local") return [];
			const root = localResourcePath(request.scope, request.context ?? {});
			const rootMetadata = await stat(root);
			const args = ["--line-number", "--color=never", "--hidden", "--no-heading", "--max-count", "1"];
			if (request.ignoreCase) args.push("--ignore-case");
			if (request.literal) args.push("--fixed-strings");
			args.push("--", request.query, root);
			const result = await runExternalCommand("rg", args, request.context?.cwd ?? baseCwd, {
				signal: request.context?.signal,
				allowNonZero: true,
				extraSearchPaths: FILEOPS_TOOL_SEARCH_PATHS,
			});
			const hits: SearchHit[] = [];
			for (const line of result.stdout.replace(/\r\n?/g, "\n").split("\n")) {
				const singleFileMatch = rootMetadata.isFile() ? /^([1-9]\d*):(.*)$/.exec(line) : undefined;
				const match = /^(.*?):([1-9]\d*):(.*)$/.exec(line);
				if (!singleFileMatch && !match) continue;
				const path = rootMetadata.isFile() ? root : resolve(match![1]!);
				const snippet = singleFileMatch
					? `${singleFileMatch[1]}:${singleFileMatch[2]}`
					: `${match![2]}:${match![3]}`;
				const metadata = rootMetadata.isFile() ? rootMetadata : await stat(path).catch(() => undefined);
				if (!metadata) continue;
				hits.push({
					...localResource(localResourceUri(path, request.context ?? {}), path, metadata),
					snippet,
					score: 1,
				});
				if (hits.length >= (request.limit ?? DEFAULT_SEARCH_RESULT_LIMIT)) break;
			}
			return hits;
		},
		async find(ref, context) {
			const root = localResourcePath(ref, context ?? {});
			if (!ref.path) await mkdir(root, { recursive: true });
			const metadata = await stat(root);
			const paths = metadata.isDirectory() ? await localFiles(root) : [root];
			return Promise.all(
				paths.map(async (path) => {
					const fileMetadata = await stat(path);
					return localResource(localResourceUri(path, context ?? {}), path, fileMetadata);
				}),
			);
		},
		async write(ref, request) {
			const path = localResourcePath(ref, request.context ?? {});
			if (request.expectedContent !== undefined) {
				const current = await readFile(path, "utf-8");
				if (current !== request.expectedContent)
					throw new Error(`Local resource changed: ${formatResourceUri(ref)}`);
			}
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, request.content, "utf-8");
			if (request.makeExecutable || request.content.startsWith("#!")) await chmod(path, 0o755);
			const metadata = await stat(path);
			return {
				resource: localResource(formatResourceUri(ref), path, metadata),
				bytes: Buffer.byteLength(request.content, "utf-8"),
			};
		},
	};
}

class CwdHashlineFilesystem extends Filesystem {
	#originalContent = new Map<string, string>();

	constructor(
		private readonly cwd: string,
		private readonly resourceContext?: ResourceContext,
	) {
		super();
	}

	#absolute(path: string): string {
		return absolutePath(this.cwd, path);
	}

	#resource(path: string): ResourceRef | undefined {
		return resourceRefForPath(path);
	}

	#canonical(path: string): string {
		const resource = this.#resource(path);
		return resource ? formatResourceUri(resource) : this.#absolute(path);
	}

	async readText(path: string): Promise<string> {
		const resource = this.#resource(path);
		try {
			const content = resource
				? (await readResource(resource, this.resourceContext)).content
				: await readFile(this.#absolute(path), "utf-8");
			this.#originalContent.set(this.#canonical(path), content);
			return content;
		} catch (error) {
			if (!resource && error instanceof Error && "code" in error && error.code === "ENOENT") {
				throw new NotFoundError(path, error);
			}
			throw error;
		}
	}

	async preflightWrite(path: string): Promise<void> {
		const resource = this.#resource(path);
		if (resource) {
			if (!resourceProvider(resource.scheme)?.write)
				throw new ResourceError("read_only", `Resource is read-only: ${formatResourceUri(resource)}`);
			return;
		}
		await mkdir(dirname(this.#absolute(path)), { recursive: true });
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		const resource = this.#resource(path);
		if (resource) {
			await writeResource(resource, {
				content,
				expectedContent: this.#originalContent.get(this.#canonical(path)),
				context: this.resourceContext,
			});
			return { text: content };
		}
		const absolute = this.#absolute(path);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, content, "utf-8");
		return { text: content };
	}

	canonicalPath(path: string): string {
		return this.#canonical(path);
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

async function executeHashline(
	cwd: string,
	input: string,
	config: EditConfig,
	snapshots: InMemorySnapshotStore,
	resourceContext?: ResourceContext,
) {
	const patch = Patch.parse(input, { cwd });
	if (patch.sections.length === 0) throw new Error("hashline mode requires at least one [PATH#TAG] section.");
	const fs = new CwdHashlineFilesystem(cwd, resourceContext);
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
	return {
		content: [{ type: "text", text: sectionTexts.join("\n\n") }],
		details: {
			diff,
			patch: diff,
			results: applied.sections.map(({ path, header }) => ({ path, header })),
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
	resourceContext?: ResourceContext,
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
			return executeHashline(cwd, params.input, config, snapshots, resourceContext);
		case "replace":
			return executeReplace(
				cwd,
				typeof params.input === "string" ? parseReplaceInput(params.input) : params,
				config,
				resourceContext,
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
	registerResourceProvider("local", localResourceProvider(cwd));
	registerResourceProvider("vault", vaultResourceProvider(cwd));
	registerResourceProvider("history", historyResourceProvider());
	registerResourceProvider("pr", githubResourceProvider(cwd));
	registerResourceProvider("issue", githubResourceProvider(cwd));

	pi.registerTool({
		...baseRead,
		name: "read",
		description:
			"Read a file or resource URI. Supports text files and images (jpg, png, gif, webp). Hashline mode returns [PATH#TAG] plus LINE:TEXT rows for local files.",
		parameters: readToolSchema,
		renderShell: "self",
		renderCall(params, theme, context) {
			return renderReadCall(params, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderReadResult(
				result as ToolTextResult,
				{ ...options, isError: context?.isError === true },
				theme,
				context?.toolCallId,
				context?.invalidate,
				context?.lastComponent,
			);
		},
		async execute(
			toolCallId,
			params: { path: string; offset?: number; limit?: number; ranges?: string[]; raw?: boolean },
			signal,
			onUpdate,
			ctx,
		) {
			const callCwd = ctx?.cwd ?? cwd;
			const selector = isResourceUri(params.path)
				? { path: params.path, ranges: [] }
				: splitReadPathSelector(params.path);
			const selectedPath = selector.path;
			const explicitRanges = [
				...selector.ranges,
				...(params.ranges ?? []).flatMap((rangeList) => rangeList.split(",").map(parseLineRange)),
			];
			if (isResourceUri(selectedPath)) {
				const resource = parseResourceUri(selectedPath);
				if (!resource) throw new Error(`Invalid resource URI: ${selectedPath}`);
				const result = await readResource(resource, resourceContextFromContext(ctx, callCwd, signal));
				return await resourceReadResult(
					result,
					params,
					explicitRanges,
					getConfig().mode === "hashline" ? snapshotsForContext(ctx) : undefined,
					callCwd,
				);
			}
			const absolute = absolutePath(callCwd, selectedPath);
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
				const lastShown = Math.min(allLines.length, ranges.at(-1)?.end ?? allLines.length);
				const output = [
					...(tag ? [formatHashlineHeader(displayPath(callCwd, absolute), tag)] : []),
					...outputRows,
					...(lastShown < allLines.length
						? [
								"",
								`[${allLines.length - lastShown} more lines in file. Use offset=${lastShown + 1} or path:${lastShown + 1}-${allLines.length} to continue.]`,
							]
						: []),
				].join("\n");
				const visibleEntries = displayEntries.filter((entry) => entry.kind === "line").slice(0, 80);
				const highlightedRows = await highlightCodeRows(
					selectedPath,
					visibleEntries.map((entry) => entry.text),
				);
				return await boundedTextResult(
					output,
					{ hashlineTag: tag, ranges, highlightedRows },
					{ cwd: callCwd, label: selectedPath },
				);
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
			return await boundedTextResult(
				output,
				{
					hashlineTag: tag,
					highlightedRows: await highlightCodeRows(
						selectedPath,
						visibleSelected.map((entry) => entry.text),
					),
				},
				{ cwd: callCwd, label: selectedPath },
			);
		},
	});

	pi.registerTool({
		name: "search",
		label: "search",
		description: [
			"Search file contents or a resource URI. Hashline mode groups local matches under [PATH#TAG] headers.",
			`Output is truncated to ${SEARCH_FILE_WINDOW} files with ${TREE_MATCHES_PER_FILE} matches each (${SINGLE_FILE_ROW_BUDGET} rows when the search is scoped to one file), 50KB, or 2000 lines, whichever is hit first.`,
			"Enclosing-block context counts against that budget. Use skip=N to page through files; narrow the pattern, path, or glob to see fewer, better matches.",
		].join(" "),
		promptSnippet: "Search file contents and return hashline-editable matches",
		promptGuidelines: [
			"Use search for file-content searches when it is active; use read when you already know the path.",
			`search returns at most ${SEARCH_FILE_WINDOW} files per call; page with skip instead of asking for a wider result.`,
		],
		parameters: searchToolSchema,
		renderShell: "self",
		renderCall(params, theme, context) {
			return renderSearchCall(params, theme, context);
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
			const selector = params.path
				? isResourceUri(String(params.path))
					? { path: String(params.path), ranges: [] }
					: splitReadPathSelector(String(params.path))
				: { path: undefined, ranges: [] };
			const explicitRanges = [
				...selector.ranges,
				...(params.ranges ?? []).flatMap((rangeList: string) => rangeList.split(",").map(parseLineRange)),
			];
			const searchPath = selector.path;
			if (searchPath && isResourceUri(String(searchPath))) {
				const resource = parseResourceUri(String(searchPath));
				if (!resource) throw new Error(`Invalid resource URI: ${searchPath}`);
				const hits = await searchResources({
					query: String(params.pattern),
					scope: resource,
					literal: Boolean(params.literal),
					ignoreCase: Boolean(params.ignoreCase),
					limit: INTERNAL_FETCH_LIMIT,
					context: resourceContextFromContext(ctx, callCwd, signal),
				});
				if (hits.length === 0) return { content: [{ type: "text", text: "No matches found" }] };
				const window = pageWindow(hits, params.skip, SEARCH_FILE_WINDOW);
				const notice = pagingNotice(window, "results");
				const bounded = await boundedWithCapture(
					[
						window.items.map((hit) => resourceContextText(hit, hit.snippet)).join("\n\n"),
						...(notice ? [notice] : []),
					].join("\n\n"),
					{ cwd: callCwd, label: `search ${params.pattern}` },
				);
				return {
					content: [{ type: "text", text: bounded.text }],
					details: { resources: window.items, outputTokens: bounded.tokens, outputBounded: bounded.truncated },
				};
			}
			const args = ["--line-number", "--color=never", "--hidden", "--no-heading"];
			if (params.ignoreCase) args.push("--ignore-case");
			if (params.literal) args.push("--fixed-strings");
			if (params.glob) args.push("--glob", String(params.glob));
			// `--max-count` is per file, never global, so it can only serve as the
			// internal fetch cap. What reaches the model is decided after selection.
			if (explicitRanges.length === 0) args.push("--max-count", String(INTERNAL_FETCH_LIMIT));
			args.push("--context", String(SEARCH_CONTEXT_LINES));
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
			const orderedFiles = [...byFile.entries()]
				.map(([absolute, entries]) => ({
					absolute,
					ordered: [...entries.entries()].sort((left, right) => left[0] - right[0]),
				}))
				.sort((left, right) => left.absolute.localeCompare(right.absolute));
			const fileWindow = pageWindow(orderedFiles, params.skip, SEARCH_FILE_WINDOW);
			// One matching file means the search is a strided read of that file, so
			// the budget is spent on rows there instead of on breadth.
			const singleFileScope = orderedFiles.length === 1;
			const perFileCap = singleFileScope ? SINGLE_FILE_ROW_BUDGET : TREE_MATCHES_PER_FILE;
			const rowBudget = singleFileScope ? SINGLE_FILE_ROW_BUDGET : SEARCH_FILE_WINDOW * TREE_MATCHES_PER_FILE;
			// Rotate first, cap second. Capping during the rotation would hand the
			// budget to whichever files sort first — the bias the rotation removes.
			const rotated = interleaveByFile(
				fileWindow.items.map((file) => file.ordered.map((match) => ({ absolute: file.absolute, match }))),
				perFileCap,
			);
			const availableMatches = fileWindow.items.reduce((total, file) => total + file.ordered.length, 0);
			const selected = rotated.slice(0, rowBudget);
			let truncatedSearch = selected.length < availableMatches;
			const selectedByFile = new Map<string, [number, { text: string; isMatch: boolean }][]>();
			for (const { absolute, match } of selected) {
				const list = selectedByFile.get(absolute) ?? [];
				list.push(match);
				selectedByFile.set(absolute, list);
			}
			const sections: string[] = [];
			const highlightedSections: HighlightedSection[] = [];
			let emittedRows = 0;
			for (const { absolute } of fileWindow.items) {
				const fileEntries = byFile.get(absolute) ?? new Map<number, { text: string; isMatch: boolean }>();
				const cappedOrdered = (selectedByFile.get(absolute) ?? []).sort((left, right) => left[0] - right[0]);
				if (cappedOrdered.length === 0) continue;
				if (emittedRows >= rowBudget) {
					truncatedSearch = true;
					break;
				}
				const display = displayPath(callCwd, absolute);
				const rawFile = normalizeToLf((await readFile(absolute, "utf-8")).replace(/^\uFEFF/, ""));
				const fullLines = textToDisplayLines(rawFile);
				const entryText = new Map(cappedOrdered.map(([lineNumber, entry]) => [lineNumber, entry.text] as const));
				const expanded = buildLineEntriesWithBlockContext(
					fullLines,
					cappedOrdered.map(([lineNumber]) => ({ startLine: lineNumber, endLine: lineNumber })),
					absolute,
					{ lineText: (lineNumber, sourceText) => entryText.get(lineNumber) ?? sourceText },
				);
				// Enclosing-block lines are added after the match cap, so they are the
				// part of the cost the cap never saw. Charge them to the same budget.
				const displayEntries: typeof expanded = [];
				let fileRows = 0;
				for (const entry of expanded) {
					if (entry.kind === "line") {
						if (emittedRows + fileRows >= rowBudget) {
							truncatedSearch = true;
							break;
						}
						fileRows += 1;
					}
					displayEntries.push(entry);
				}
				emittedRows += fileRows;
				if (fileRows === 0) continue;
				const tag = await recordHashlineFileSnapshot(snapshotsForContext(ctx), absolute, {
					explicit: displayEntries.flatMap((entry) =>
						entry.kind === "line" && !entry.context ? [entry.lineNumber] : [],
					),
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
			const notices: string[] = [];
			const paging = pagingNotice(fileWindow);
			if (paging) notices.push(paging);
			if (truncatedSearch)
				notices.push(
					`Match budget reached: at most ${perFileCap} matches per file and ${rowBudget} rows total, enclosing-block context included. Narrow the pattern, path, or glob to see the rest.`,
				);
			if (notices.length > 0) sections.push(notices.join(" "));
			// Search is one-match-per-line, so a single minified line is noise here
			// and capping it is safe. Document reads deliberately do not do this.
			const bounded = await boundedWithCapture(
				sections.join("\n\n"),
				{ cwd: callCwd, label: `search ${params.pattern}` },
				{ maxLineChars: GREP_MAX_LINE_CHARS },
			);
			return {
				content: [{ type: "text", text: bounded.text }],
				details: { highlightedSections, outputTokens: bounded.tokens, outputBounded: bounded.truncated },
			};
		},
	});

	pi.registerTool({
		...baseFind,
		name: "find",
		description: [
			"Find files or resources by glob/path. Accepts {pattern,path} and {paths:[...]} inputs.",
			`Output is truncated to ${SEARCH_FILE_WINDOW} files or 50KB, whichever is hit first.`,
			"Use skip=N to page through the rest, or narrow the glob.",
		].join(" "),
		promptGuidelines: [
			"Use find for file discovery by glob or path when it is active.",
			`find returns at most ${SEARCH_FILE_WINDOW} files per call; page with skip instead of asking for a wider result.`,
		],
		parameters: findToolSchema,
		renderShell: "self",
		renderCall(params, theme, context) {
			return renderFindCall(params, theme, context);
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
			const requestedPaths = Array.isArray(params.paths)
				? params.paths.map(String)
				: [params.path ?? params.pattern].filter((value): value is string => typeof value === "string");
			const resourcePaths = requestedPaths.filter(isResourceUri);
			if (resourcePaths.length > 0) {
				if (resourcePaths.length !== requestedPaths.length) {
					throw new Error("find cannot mix resource URIs with local paths.");
				}
				const callCwd = ctx?.cwd ?? cwd;
				const found = (
					await Promise.all(
						resourcePaths.map((path) => {
							const resource = parseResourceUri(path);
							if (!resource) throw new Error(`Invalid resource URI: ${path}`);
							return findResources(resource, resourceContextFromContext(ctx, callCwd, signal));
						}),
					)
				).flat();
				const window = pageWindow(found, params.skip, SEARCH_FILE_WINDOW);
				const notice = pagingNotice(window, "resources");
				const bounded = await boundedWithCapture(
					window.items.length === 0
						? "No resources found"
						: [
								window.items.map((item) => resourceContextText(item)).join("\n\n"),
								...(notice ? [notice] : []),
							].join("\n\n"),
					{ cwd: callCwd, label: "find" },
				);
				return {
					content: [{ type: "text", text: bounded.text }],
					details: { resources: window.items, outputTokens: bounded.tokens, outputBounded: bounded.truncated },
				};
			}
			const callCwd = ctx?.cwd ?? cwd;
			// The legacy `{pattern, path}` shape is the one a model reaches for most
			// naturally, and delegating it to the base tool skipped the window, the
			// paging notice and the byte budget entirely. Normalise it instead so
			// there is exactly one bounded path through this tool.
			const globPaths = Array.isArray(params.paths)
				? params.paths
				: typeof params.pattern === "string" && params.pattern.length > 0
					? [join(typeof params.path === "string" && params.path ? params.path : ".", params.pattern)]
					: undefined;
			if (!globPaths) return baseFind.execute(toolCallId, params, signal, onUpdate, ctx);
			const perPattern: string[][] = [];
			for (const pattern of globPaths) {
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
				perPattern.push(
					result.stdout
						.split("\n")
						.filter(Boolean)
						.map((file) => displayPath(callCwd, absolutePath(search.root, file)))
						.sort((left, right) => left.localeCompare(right)),
				);
			}
			// Rotate across the requested patterns so one broad glob cannot spend the
			// whole page and hide the narrow pattern the caller also asked for.
			const seen = new Set<string>();
			const allUnique = interleaveByFile(perPattern, INTERNAL_FETCH_LIMIT).filter((file) => {
				if (seen.has(file)) return false;
				seen.add(file);
				return true;
			});
			const window = pageWindow(allUnique, params.skip, SEARCH_FILE_WINDOW);
			const notice = pagingNotice(window);
			const bounded = await boundedWithCapture(
				window.items.length === 0
					? "No files found matching pattern"
					: [
							...[...window.items].sort((left, right) => left.localeCompare(right)),
							...(notice ? [notice] : []),
						].join("\n"),
				{ cwd: callCwd, label: "find" },
			);
			return {
				content: [{ type: "text", text: bounded.text }],
				details: { outputTokens: bounded.tokens, outputBounded: bounded.truncated },
			};
		},
	});

	pi.registerTool({
		...baseWrite,
		name: "write",
		description:
			"Write a file or writable resource URI. In hashline mode, copied [PATH#TAG] and LINE: prefixes are stripped from content before writing.",
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
			if (isResourceUri(params.path)) {
				const resource = parseResourceUri(params.path);
				if (!resource) throw new Error(`Invalid resource URI: ${params.path}`);
				const stripped =
					getConfig().mode === "hashline"
						? stripHashlineDisplayPrefixes(params.content)
						: { text: params.content, stripped: false };
				const result = await writeResource(resource, {
					content: stripped.text,
					makeExecutable: params.makeExecutable,
					context: resourceContextFromContext(ctx, ctx?.cwd ?? cwd, signal),
				});
				return {
					content: [{ type: "text", text: `Wrote ${result.resource.uri}` }],
					details: { resource: result.resource, bytes: result.bytes },
				};
			}
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

function resourceContextFromContext(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager"> | undefined,
	cwd: string,
	signal?: AbortSignal,
): ResourceContext {
	return {
		cwd,
		signal,
		sessionId: ctx?.sessionManager?.getSessionId?.(),
		sessionFile: ctx?.sessionManager?.getSessionFile?.(),
	};
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
		on.call(pi, "session_start", async (_event, ctx) => {
			resetTurnTracking();
			rebuildVisibleFileopsWindow(ctx);
			const sessionId = sessionIdFromContext(ctx);
			if (sessionId) {
				await restoreHashlineSnapshots(
					hashlineSnapshotStoreForSession(sessionId),
					ctx.cwd,
					ctx.sessionManager?.getBranch?.() ?? [],
				);
			}
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
					await executeByMode(
						ctx.cwd,
						params as EditInput,
						current,
						snapshotsForContext(ctx),
						signal,
						resourceContextFromContext(ctx, ctx.cwd, signal),
					),
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
