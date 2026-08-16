import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type EditToolDetails, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch, diffChars } from "diff";
import { Type } from "typebox";
import { captureContent } from "../artifact-store/pi/capture.ts";
import { runCommand as runExternalCommand } from "../shared/command-runner.ts";
import type { ExplorationReadSummaryPart, ExplorationReadSummaryRow } from "../shared/exploration-rendering.ts";
import { githubAppSlug, githubAuthorLabel, githubRecordIsPullRequest } from "../shared/github-resources.ts";
import {
	approxTokenCount,
	type BoundedOutput,
	type BoundOutputOptions,
	boundOutput,
	formatTokenCost,
	GREP_MAX_LINE_CHARS,
} from "../shared/output-budget.ts";
import {
	formatResourceUri,
	localResourcePath,
	localResourceRoot,
	parseResourceUri,
	type Resource,
	type ResourceContext,
	ResourceError,
	type ResourceProvider,
	type ResourceRef,
	readResource,
	resolvePathRef,
	resourceOpenUrl,
	resourceProvider,
	type SearchHit,
	writeResource,
} from "../shared/resources.ts";
import { type ApplyPatchChange, type ApplyPatchResult, applyPatchBinaryPath, runApplyPatch } from "./apply-patch.ts";
import { buildLineEntriesWithBlockContext, findBlockContextLines } from "./block-context.ts";
import {
	type DeclarationCounts,
	preloadBlockLanguages,
	summarizeCodeStructure,
	treeSitterBlockResolver,
} from "./block-resolver.ts";
import { embeddedGrammarPaths, fileSyntaxValidator } from "./format-validators.ts";
import {
	type HashlineSessionEntry,
	recordHashlineFileSnapshot,
	recordHashlineSnapshot,
	restoreHashlineSnapshots,
	SNAPSHOT_MAX_BYTES,
} from "./hashline/anchors.js";
import { buildCompactDiffPreview, generateNumberedDiff } from "./hashline/diff-preview.ts";
import { formatHashlineHeader } from "./hashline/format.ts";
import { Filesystem, NotFoundError, type PreflightWriteOptions, type WriteResult } from "./hashline/fs.ts";
import { Patch } from "./hashline/input.ts";
import { HashlineApplyError, hashlineContract, Patcher } from "./hashline/patcher.ts";
import { stripHashlinePrefixes } from "./hashline/prefixes.ts";
import type { InMemorySnapshotStore } from "./hashline/snapshots.ts";
import type { BlockResolution, Clipboard } from "./hashline/types.ts";
import { findConflictRegions, formatConflictIndex } from "./merge-conflicts.ts";

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

export type EditMode = "apply_patch" | "hashline" | "replace";
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
 * Default and hard cap for context lines. The model can request a lower value,
 * but higher context expansion made a high `limit` expensive. Zero would be
 * cheaper still, but a match with no surrounding lines cannot anchor an edit,
 * so the tool would be cheap and useless.
 */
const SEARCH_CONTEXT_LINES = 2;

/**
 * Structural-summary gates.
 *
 * Only two survive, and both are about the summary being pointless rather than
 * about cost. Below `READ_SUMMARY_MIN_LINES` the whole file is cheaper than the
 * outline plus the follow-up read it provokes; above `READ_SUMMARY_MAX_LINES`
 * or `READ_SUMMARY_MAX_BYTES` tree-sitter is doing megabytes of work to answer
 * a question the caller should be asking `search`.
 *
 * The old gates — hashline mode only, unbounded reads only, at least 20 elided
 * lines — are gone. They kept the summary off almost every real file, which is
 * how an unscoped read stayed the most expensive call in the corpus.
 */
const READ_SUMMARY_MIN_LINES = 80;
const READ_SUMMARY_MAX_LINES = 20_000;
const READ_SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
/** Elided spans named in the summary footer before the list itself is the cost. */
const READ_SUMMARY_FOOTER_SPANS = 6;

type PageWindow<T> = { items: T[]; start: number; end: number; total: number };

/** Take one page from an ordered list. `skip` is clamped, never rejected. */
function pageWindow<T>(items: readonly T[], skip: unknown, size: number): PageWindow<T> {
	const total = items.length;
	const requested = Math.floor(Number(skip ?? 0));
	const start = Number.isFinite(requested) ? Math.max(0, Math.min(requested, total)) : 0;
	const page = items.slice(start, start + size);
	return { items: page, start, end: start + page.length, total };
}

function findPageSize(value: unknown): number {
	const requested = Math.floor(Number(value ?? SEARCH_FILE_WINDOW));
	return Number.isFinite(requested) ? Math.max(1, Math.min(SEARCH_FILE_WINDOW, requested)) : SEARCH_FILE_WINDOW;
}

function searchContextLines(value: unknown): number {
	const requested = Math.floor(Number(value ?? SEARCH_CONTEXT_LINES));
	return Number.isFinite(requested) ? Math.max(0, Math.min(SEARCH_CONTEXT_LINES, requested)) : SEARCH_CONTEXT_LINES;
}

function searchMatchLimit(value: unknown, cap: number): number {
	const requested = Math.floor(Number(value ?? cap));
	return Number.isFinite(requested) ? Math.max(1, Math.min(cap, requested)) : cap;
}

/**
 * Name the next call instead of announcing a dead end.
 *
 * A bare "truncated" tells the model something is missing but not how to reach
 * it, so it retries with a wider `limit` it no longer has. The notice carries
 * the exact `skip` for the next page.
 */
function pagingNotice(window: PageWindow<unknown>, label = "files", resourceUri?: string): string | undefined {
	if (window.start === 0 && window.end >= window.total) return undefined;
	const shown = `Showing ${label} ${window.start + 1}-${window.end} of ${window.total}.`;
	if (window.end >= window.total) return shown;
	const next = resourceUri ? `${resourceUri}:${window.end}` : `skip=${window.end}`;
	return `${shown} Use ${next} for the next page, or narrow paths/pattern.`;
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

type EditInput = {
	input?: string;
	path?: string;
	edits?: Array<ReplaceEntry> | string;
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
export type EditPreview = {
	diff: string;
	headers: ReadonlyMap<string, string>;
};

type EditPreviewCache = {
	key: string;
	input: string;
	preview?: EditPreview;
	sources: Map<string, string>;
};

function cachedEditSource(path: string, sources: Map<string, string>): string {
	let text = sources.get(path);
	if (text === undefined) {
		text = normalizeToLf(stripBom(readFileSync(path, "utf-8")).text);
		sources.set(path, text);
	}
	return text;
}

function buildEditPreview(
	input: unknown,
	config: EditConfig,
	cwd: string,
	sources: Map<string, string>,
): EditPreview | undefined {
	if (typeof input !== "string") return undefined;
	try {
		if (config.mode === "replace") {
			const normalized = normalizeReplaceInput(parseReplaceInput(input));
			const before = cachedEditSource(absolutePath(cwd, normalized.path), sources);
			const applied = applyNormalizedReplace(before, normalized, config);
			if (applied.text === before) return undefined;
			const diff = createTwoFilesPatch(normalized.path, normalized.path, before, applied.text, "", "", {
				context: 3,
			});
			return { diff, headers: new Map() };
		}
		if (config.mode === "apply_patch") {
			const result = previewApplyPatch(cwd, input);
			const diff = result?.changes.map(applyPatchChangeDiff).join("\n") ?? "";
			return diff ? { diff, headers: new Map() } : undefined;
		}
		const patch = Patch.parse(input, { cwd });
		const headers = new Map<string, string>();
		const diffs: string[] = [];
		for (const section of patch.sections) {
			const before = cachedEditSource(absolutePath(cwd, section.path), sources);
			const applied = section.applyPartialTo(before, treeSitterBlockResolver);
			if (applied.text === before) continue;
			headers.set(section.path, formatHashlineHeader(section.path, section.fileHash));
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

export function editPreviewForInput(
	input: unknown,
	config: EditConfig,
	cwd: string,
	state: Record<string, unknown> | undefined,
	argsComplete: boolean,
): EditPreview | undefined {
	const text = typeof input === "string" ? input : "";
	const key = `${config.mode}\0${config.fuzzyMatch}\0${config.fuzzyThreshold}\0${config.allowReplaceAll}\0${cwd}\0${text}`;
	const cached = state?.editPreview as EditPreviewCache | undefined;
	if (cached?.key === key) return cached.preview;
	if (cached && text.startsWith(cached.input) && !argsComplete && !text.endsWith("\n")) return cached.preview;
	const sources = cached?.sources ?? new Map<string, string>();
	const preview = buildEditPreview(input, config, cwd, sources);
	const stablePreview = preview ?? (cached && text.startsWith(cached.input) ? cached.preview : undefined);
	if (state) state.editPreview = { key, input: text, preview: stablePreview, sources };
	return stablePreview;
}

function pluralize(label: string, count: number): string {
	if (count === 1) return label;
	return /(?:s|x|ch|sh)$/.test(label) ? `${label}es` : `${label}s`;
}

/**
 * The one line of the footer that survives the budget hiding declarations.
 *
 * Past a few thousand lines the outline can no longer name everything, and the
 * question that provoked the read — how many functions is this, what is in
 * here — stops being answerable by reading it. The tally comes free with the
 * tree-sitter walk, so it answers directly instead.
 */
function describeDeclarationCounts(counts: DeclarationCounts): string | undefined {
	if (counts.byKind.length === 0) return undefined;
	const kinds = counts.byKind.map(({ label, count }) => `${count} ${pluralize(label, count)}`).join(", ");
	// "Top level:" alone read as a statistic about the displayed rows, so a model asked
	// for a function count recounted the summary by regex instead of reading this line.
	return `Top level, exact counts for the whole file: ${kinds}${counts.exported === undefined ? "" : ` (${counts.exported} exported)`}`;
}

/**
 * Outline a whole-file read, or undefined to read the file verbatim.
 *
 * This is the default answer for parseable code with no selector, and the
 * reason the unscoped read stopped being the expensive one. It is also the
 * riskiest path in the extension: the rows it displays are exactly the lines a
 * later hashline edit may anchor to, so `observedLines.explicit` is derived
 * from the emitted rows and nothing else. Marking an elided line observed lets
 * the model edit text it never saw; marking a displayed line unobserved makes
 * every edit after a summary read fail. See `read-summary.test.ts`.
 */
async function trySummarizeWholeFileRead(
	display: string,
	absolute: string,
	text: string,
	options: { numbered: boolean; snapshots?: InMemorySnapshotStore; cwd: string },
): Promise<ToolTextResult | undefined> {
	if (Buffer.byteLength(text, "utf8") > READ_SUMMARY_MAX_BYTES) return undefined;
	const lineCount = textToDisplayLines(text).length;
	if (lineCount < READ_SUMMARY_MIN_LINES || lineCount > READ_SUMMARY_MAX_LINES) return undefined;
	await preloadBlockLanguages([absolute]);
	const summary = summarizeCodeStructure(absolute, text);
	if (!summary) return undefined;

	const explicit = summary.rows.flatMap((row) => (row.kind === "line" ? [row.lineNumber] : []));
	const tag =
		options.snapshots && options.numbered && Buffer.byteLength(text, "utf8") <= SNAPSHOT_MAX_BYTES
			? recordHashlineSnapshot(options.snapshots, absolute, text, { explicit, synthetic: [] })
			: undefined;
	// Non-hashline edit modes match on verbatim text, so numbering their rows
	// would hand the model a prefix it then pastes into an edit. They get the
	// same outline with the line numbers only in the footer.
	const rows = summary.rows.map((row) =>
		row.kind === "ellipsis" ? "…" : options.numbered ? `${row.lineNumber}:${row.text}` : row.text,
	);
	const named = summary.elidedRanges
		.slice(0, READ_SUMMARY_FOOTER_SPANS)
		.map((range) => `${range.startLine}-${range.endLine}`);
	const rest = summary.elidedRanges.length - named.length;
	const inventory = describeDeclarationCounts(summary.counts);
	const footer = [
		`[Structural summary: ${summary.elidedLines} of ${summary.totalLines} lines elided in ${summary.elidedRanges.length} spans.`,
		...(inventory ? [`${inventory}.`] : []),
		`Re-read only what you need, e.g. \`${display}:${named.join(",")}\`${rest > 0 ? ` (+${rest} more spans)` : ""}.`,
		"Never guess the contents of an elided span.]",
	].join(" ");
	const summaryText = await boundedWithCapture(
		[...(tag ? [formatHashlineHeader(display, tag)] : []), ...rows, "", footer].join("\n"),
		{ cwd: options.cwd, label: display },
	);
	return {
		content: [{ type: "text", text: summaryText.text }],
		details: {
			outputTokens: summaryText.tokens,
			outputBounded: summaryText.truncated,
			hashlineTag: tag,
			summary: {
				totalLines: summary.totalLines,
				elidedLines: summary.elidedLines,
				elidedSpans: summary.elidedRanges.length,
				// What reading the file verbatim would have cost. The card pairs it
				// with `outputTokens`, because "we summarised it" means nothing next
				// to the two numbers that say by how much.
				fullTokens: approxTokenCount(text),
			},
		},
	};
}

/**
 * Index the unresolved merge conflicts in a file.
 *
 * Only the marker lines are displayed, so only the marker lines carry edit
 * authority — resolving a conflict means re-reading the side you keep, which
 * the index names.
 */
async function conflictsReadResult(
	display: string,
	absolute: string,
	text: string,
	options: { numbered: boolean; snapshots?: InMemorySnapshotStore; cwd: string },
): Promise<ToolTextResult> {
	const lines = textToDisplayLines(text);
	const regions = findConflictRegions(lines);
	if (regions.length === 0) {
		return { content: [{ type: "text", text: `No unresolved merge conflicts in ${display}.` }], details: {} };
	}
	const markerLines = regions.flatMap((region) => region.markerLines);
	const tag =
		options.snapshots && options.numbered && Buffer.byteLength(text, "utf8") <= SNAPSHOT_MAX_BYTES
			? recordHashlineSnapshot(options.snapshots, absolute, text, { explicit: markerLines, synthetic: [] })
			: undefined;
	const rows = markerLines.map((line) =>
		options.numbered ? `${line}:${lines[line - 1] ?? ""}` : (lines[line - 1] ?? ""),
	);
	const bounded = await boundedWithCapture(
		[
			...(tag ? [formatHashlineHeader(display, tag)] : []),
			`${regions.length} unresolved conflict${regions.length === 1 ? "" : "s"} in ${display}.`,
			...formatConflictIndex(regions),
			"",
			...rows,
		].join("\n"),
		{ cwd: options.cwd, label: display },
	);
	return {
		content: [{ type: "text", text: bounded.text }],
		details: {
			outputTokens: bounded.tokens,
			outputBounded: bounded.truncated,
			hashlineTag: tag,
			conflictCount: regions.length,
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
export function textResult(text: string, details?: Record<string, unknown>): ToolTextResult {
	return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

const EDIT_MODES: EditMode[] = ["apply_patch", "hashline", "replace"];
const DEFAULT_CONFIG: EditConfig = {
	mode: "hashline",
	fuzzyMatch: true,
	fuzzyThreshold: 0.95,
	allowReplaceAll: true,
	autoDropPureInsertDuplicates: false,
};
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");

/**
 * One parameter, because every extra parameter was a way to spell the same
 * request. `offset`+`limit`, `ranges`, and a selector on the path were three
 * encodings of a line range, and the model picked whichever the last example
 * used. A selector on the path is the one that also survives being quoted into
 * a sentence, so it is the one that stays.
 */
const readToolSchema = Type.Object({
	path: Type.String({
		description: [
			"File path or resource URI, optionally with a trailing selector.",
			"Selectors: `:120` one line, `:120-180` a range, `:120+40` 40 lines from 120, `:120-` to end of file,",
			"`:12-40,90-120` several ranges, `:raw` verbatim bytes with no line numbers, `:conflicts` index unresolved merge conflicts.",
			"Combine as `:120-180:raw`.",
		].join(" "),
	}),
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
	context: Type.Optional(Type.Number({ description: "Context lines around each match, capped at 2." })),
	limit: Type.Optional(Type.Number({ description: "Maximum matching lines, capped by the search budget." })),
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

// One spelling declared, three still accepted. `pattern` and `path` are absorbed by the execute below
// (`join(path, pattern)`), not here, because a resource URI must not be joined with a glob. Declaring them
// cost 46 tokens and split the callers: 763 of 963 (79.2%) said `paths`, 576 said `path`, 455 said `pattern`.
const findToolSchema = Type.Object({
	paths: Type.Optional(
		Type.Array(
			Type.String({
				description:
					// No `*/` anywhere in this text: renderDocComment (tool-declarations.ts) rewrites the sequence and
					// would hand the model a glob with a space in it. `src/**` is the recursive form that survives.
					'Glob, path, or resource URI, each entry carrying its own directory: find({paths: ["src/**", "docs/*.md"]}). A bare directory lists everything under it. No separate `path` or `pattern` argument.',
			}),
		),
	),
	skip: Type.Optional(Type.Number({ description: "Number of files to skip, for paging through a wide result" })),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files" })),
	gitignore: Type.Optional(Type.Boolean({ description: "Respect gitignore" })),
	limit: Type.Optional(Type.Number({ description: "Maximum files returned per page, capped at the tool window." })),
});

export const HASHLINE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "hashline", "grammar.lark"), "utf-8");
const HASHLINE_PROMPT = readFileSync(join(EXTENSION_DIR, "hashline", "prompt.md"), "utf-8");
export const REPLACE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "replace.lark"), "utf-8");
export const APPLY_PATCH_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "apply-patch.lark"), "utf-8");

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

const HASHLINE_CLIPBOARDS = new WeakMap<InMemorySnapshotStore, Clipboard>();

function clipboardForSnapshots(snapshots: InMemorySnapshotStore): Clipboard {
	let clipboard = HASHLINE_CLIPBOARDS.get(snapshots);
	if (!clipboard) {
		clipboard = {};
		HASHLINE_CLIPBOARDS.set(snapshots, clipboard);
	}
	return clipboard;
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

export function getEditMode(): EditMode {
	return loadConfig().mode;
}

export async function setEditMode(value: unknown): Promise<EditMode | undefined> {
	const mode = normalizeMode(value);
	if (!mode) return undefined;
	await saveConfig({ ...loadConfig(), mode });
	return mode;
}

function modeParameters() {
	return inputSchema;
}

function modeGrammar(mode: EditMode): string {
	switch (mode) {
		case "apply_patch":
			return APPLY_PATCH_GRAMMAR;
		case "hashline":
			return HASHLINE_GRAMMAR;
		case "replace":
			return REPLACE_GRAMMAR;
	}
}

function modeDescription(config: EditConfig): string {
	switch (config.mode) {
		case "apply_patch":
			return "Edit files with the Codex apply_patch format. Use *** Begin Patch / *** End Patch with Add, Update, or Delete File sections. A *** Move to: path follows its Update File header and still needs a nonempty @@ hunk. Order each file's hunks top-to-bottom. Indentation is literal.";
		case "hashline":
			return HASHLINE_PROMPT;
		case "replace":
			return "Edit files by replacing exact or fuzzy old_text with new_text.";
	}
}

function absolutePath(cwd: string, path: string): string {
	const ref = resolvePathRef(path, cwd);
	if (ref.kind !== "local") throw new Error(`Resource URI requires its provider: ${ref.uri}`);
	return ref.path;
}

function resourceRefForPath(path: string): ResourceRef | undefined {
	const ref = resolvePathRef(path);
	return ref.kind === "resource" ? ref.ref : undefined;
}
function unescapedSlashPath(path: string): string | undefined {
	if (!path.includes("\\/")) return undefined;
	return path.replaceAll("\\/", "/");
}

function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

function textToDisplayLines(text: string): string[] {
	const normalized = normalizeToLf(text);
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

/** `end` is `Infinity` for an open-ended `:120-`; it is clamped once the file is read. */
type LineRange = { start: number; end: number };

/**
 * A comma-separated list of ranges, each `120`, `L120`, `120-180`, `120..180`,
 * `120+40`, or the open-ended `120-`.
 */
const RANGE_LIST_PATTERN =
	/^[Ll]?\d+(?:\s*(?:-|\.\.|\+)\s*[Ll]?\d*)?(?:,\s*[Ll]?\d+(?:\s*(?:-|\.\.|\+)\s*[Ll]?\d*)?)*$/;

function parseLineRange(raw: string): LineRange {
	const cleaned = raw
		.trim()
		.replace(/^:/, "")
		.replace(/[Ll](?=\d)/g, "");
	const match = /^([1-9]\d*)(?:\s*(-|\.\.|\+)\s*(\d*))?$/.exec(cleaned);
	if (!match) throw new Error(`Invalid read line selector: ${raw}`);
	const start = Number(match[1]);
	const operator = match[2];
	const operand = match[3];
	if (operator === undefined) return { start, end: start };
	// An open end means "to the end of the file"; the reader clamps it.
	if (operand === undefined || operand === "") return { start, end: Number.POSITIVE_INFINITY };
	const value = Number(operand);
	if (operator === "+") {
		if (value < 1) throw new Error(`Invalid read line selector ${raw}: line count must be at least 1.`);
		return { start, end: start + value - 1 };
	}
	if (value < start) throw new Error(`Invalid read line selector ${raw}: end is before start.`);
	return { start, end: value };
}

type ReadSelector = { path: string; ranges: LineRange[]; raw: boolean; conflicts: boolean };

/**
 * Peel selectors off the end of a path.
 *
 * Peeling is right-to-left and stops at the first suffix that is not a
 * selector, so `db.sqlite:table` and `pr://luan/agents/23` keep their colons —
 * an unrecognised suffix belongs to the path, never to this grammar.
 */
function splitReadPathSelector(path: string): ReadSelector {
	let remaining = path;
	let ranges: LineRange[] = [];
	let raw = false;
	let conflicts = false;
	for (;;) {
		const colon = remaining.lastIndexOf(":");
		if (colon <= 0) break;
		const suffix = remaining.slice(colon + 1);
		if (suffix === "raw" && !raw) raw = true;
		else if (suffix === "conflicts" && !conflicts) conflicts = true;
		else if (ranges.length === 0 && RANGE_LIST_PATTERN.test(suffix)) ranges = suffix.split(",").map(parseLineRange);
		else break;
		remaining = remaining.slice(0, colon);
	}
	return { path: remaining, ranges, raw, conflicts };
}

function rejectedHashRange(path: string): string | undefined {
	const match = /^(.*)#([1-9]\d*-[1-9]\d*|L[1-9]\d*-L[1-9]\d*|L[1-9]\d*)$/.exec(path);
	if (!match) return undefined;
	return `${match[1]}:${match[2].replaceAll("L", "")}`;
}

/** Replace open-ended `:120-` selectors with the file's real last line. */
function clampLineRanges(ranges: readonly LineRange[], totalLines: number): LineRange[] {
	return ranges.map((range) => ({ start: range.start, end: Math.min(range.end, totalLines) }));
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
	selector: Pick<ReadSelector, "ranges" | "raw">,
	snapshots?: InMemorySnapshotStore,
	cwd?: string,
	numbered = true,
): Promise<ToolTextResult> {
	const text = normalizeToLf(result.content);
	const resourceSummary = summarizeResource(result.resource, result.content);
	const recoveryRef = result.resource.kind === "captured-artifact" ? result.resource.uri : undefined;
	if (selector.raw && selector.ranges.length === 0) {
		return boundedTextResult(
			text,
			{ resource: result.resource, resourceSummary },
			{ cwd, label: result.resource.uri, recoveryRef },
		);
	}
	const lines = textToDisplayLines(text);
	const ranges =
		selector.ranges.length > 0
			? mergeLineRanges(clampLineRanges(selector.ranges, lines.length))
			: [{ start: 1, end: lines.length }];
	const entries = selectedLineEntries(lines, ranges);
	if (selector.raw) {
		return boundedTextResult(
			entries.map(([, line]) => line).join("\n"),
			{ resource: result.resource, resourceSummary, ranges },
			{ cwd, label: result.resource.uri, recoveryRef },
		);
	}
	const observedLines =
		selector.ranges.length > 0 ? { explicit: entries.map(([line]) => line), synthetic: [] } : "all";
	const hashlineTag =
		snapshots && Buffer.byteLength(text, "utf8") <= SNAPSHOT_MAX_BYTES
			? recordHashlineSnapshot(snapshots, result.resource.uri, text, observedLines)
			: undefined;
	const startLine = ranges[0]?.start ?? 1;
	const endLine = Math.min(lines.length, ranges.at(-1)?.end ?? lines.length);
	const output = entries.map(([line, value]) => (numbered ? `${line}:${value}` : value)).join("\n");
	const continuation =
		endLine < lines.length
			? `\n\n[${lines.length - endLine} more lines. Continue with \`${result.resource.uri}:${endLine + 1}-\`.]`
			: "";
	return boundedTextResult(
		`${hashlineTag ? `${formatHashlineHeader(result.resource.uri, hashlineTag)}\n` : ""}${output}${continuation}`,
		{ resource: result.resource, resourceSummary, ranges, offset: startLine, hashlineTag },
		{ cwd, label: result.resource.uri, recoveryRef },
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
 * Paging back through a bounded result costs what the result would have cost. An
 * artifact reference turns "the rest is gone unless you pay for it again" into a
 * read of the part you actually need.
 *
 * Fails open: the artifact store may be unavailable, and a read is not worth
 * failing over a missing capture.
 */
async function captureFullOutput(text: string, label: string): Promise<string | undefined> {
	try {
		const outcome = await captureContent({ label }, text);
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
	options: { cwd?: string; label?: string; recoveryRef?: string } = {},
	boundOptions: BoundOutputOptions = {},
): Promise<BoundedOutput> {
	const probe = boundOutput(text, boundOptions);
	if (!probe.truncated) return probe;
	const fullOutputRef =
		options.recoveryRef ?? (options.cwd ? await captureFullOutput(text, options.label ?? "read") : undefined);
	return fullOutputRef ? boundOutput(text, { ...boundOptions, fullOutputRef }) : probe;
}

async function boundedTextResult(
	text: string,
	details: Record<string, unknown> = {},
	options: { cwd?: string; label?: string; recoveryRef?: string } = {},
): Promise<ToolTextResult> {
	const bounded = await boundedWithCapture(text, options);
	// The cost part is attached here, once, rather than in the renderer: the
	// render path runs on every invalidate, and rebuilding the summary object
	// each pass resets the card and restarts its async avatar loads.
	const summary = details.resourceSummary;
	const withCost =
		summary && typeof summary === "object"
			? { ...details, resourceSummary: { ...summary, costPart: readCostPart(bounded.tokens, bounded.truncated) } }
			: details;
	return {
		content: [{ type: "text", text: bounded.text }],
		details: { ...withCost, outputTokens: approxTokenCount(bounded.text), outputBounded: bounded.truncated },
	};
}

/**
 * What a read cost, for the title row.
 *
 * `read` is the largest token consumer in practice. The title row carries
 * roles rather than raw colour, so `high` shares `warning` with `elevated`
 * here instead of the orange the search and find headers blend.
 */
function tokenCostRole(severity: "normal" | "elevated" | "high" | "severe"): string {
	return severity === "severe" ? "error" : severity === "normal" ? "dim" : "warning";
}
export function readCostPart(tokens: number, wasBounded: boolean): ExplorationReadSummaryPart | undefined {
	if (tokens <= 0) return undefined;
	const cost = formatTokenCost(tokens, "read");
	return { text: `${cost.text}${wasBounded ? " · bounded" : ""}`, role: tokenCostRole(cost.severity) };
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

export const GITHUB_TYPE_ICON = "";

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
	if (!login) return resourceString(author.name);
	// An app is not a username, so it gets no `@`: gh's `app/` login rendered as `@app/`.
	if (githubAppSlug(login) !== undefined) return githubAuthorLabel(login, resourceString(author.name));
	return `@${login}`;
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
	if (login && githubAppSlug(login) !== undefined) return direct;
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
	// `githubUserUrl("app/")` produced https://github.com/app%2F, a 404.
	const userLogin = login && githubAppSlug(login) === undefined ? login : undefined;
	return {
		text,
		role: "muted",
		avatarUrl: resourceAvatarUrl(value),
		url: userLogin ? githubUserUrl(userLogin) : undefined,
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

function mergedAnsi(text: string): string {
	return `${MERGED_ANSI_FG}${text}${ANSI_FG_RESET}`;
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

	if (ref.scheme === "artifact") {
		const bytes = typeof resource.size === "number" ? resource.size : Buffer.byteLength(content, "utf8");
		const openUrl = resourceOpenUrl(resource);
		return {
			scheme: ref.scheme,
			icon: "",
			iconRole: "accent",
			label: "artifact",
			title: resource.title ?? resource.name,
			subtitle: resource.path ? resourcePathDisplay(resource.path) : resource.uri,
			subtitleUrl: openUrl,
			meta: `${bytes.toLocaleString()} bytes`,
			rows: [{ branch: false, text: resource.uri, textUrl: openUrl }],
		};
	}
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
		const pullRequest = githubRecordIsPullRequest(record);
		const status = pullRequest
			? pullRequestStatus(record)
			: draft
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
			...resourceSummaryType(pullRequest ? "pr" : ref.scheme),
			repository,
			repositoryUrl: githubRepositoryUrl(repository),
			identifier: githubIdentifierPart(record, number, resource),
			title,
			subtitle: "GitHub",
			statusSuffix: closed && reason && reason !== "COMPLETED" ? reason.toLowerCase() : undefined,
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

const SEARCH_NEEDS_PATTERN =
	'search requires a non-empty `pattern`, the regex or literal to look for. Aliases `query`, `regex` and `q` are accepted; anything else is dropped, and a dropped pattern would report "No matches found" for a file it never searched.';

// `read` deliberately takes one parameter, with the range as a selector on the path (index.ts:495). A model that guesses
// `offset`/`limit` got the whole file and a successful result, so it learned that read cannot window and reached for
// `sed`/`nl` instead. These are named rather than aliased: `offset` is 0-based in some harnesses and 1-based in others,
// and honouring the wrong base would turn a silent no-op into a silently wrong window.
const READ_RANGE_KEYS = [
	"offset",
	"limit",
	"start_line",
	"end_line",
	"startLine",
	"endLine",
	"line_start",
	"line_end",
	"lineStart",
	"lineEnd",
	"view_range",
	"viewRange",
	"range",
	"lines",
	"ranges",
];

const READ_RANGE_HINT = "read carries the range on `path`: re-read as";

/** Unambiguous synonyms only: each carries exactly the data its canonical key does, so honouring it cannot mean two things. */
function aliasKey(record: Record<string, unknown>, canonical: string, synonyms: readonly string[]): void {
	if (typeof record[canonical] === "string" && record[canonical] !== "") return;
	for (const synonym of synonyms) {
		if (typeof record[synonym] === "string" && record[synonym] !== "") {
			record[canonical] = record[synonym];
			return;
		}
	}
}

function rejectUnexpectedArguments(
	toolName: string,
	record: Record<string, unknown>,
	allowed: readonly string[],
): void {
	const unexpected = Object.keys(record).find((key) => record[key] !== undefined && !allowed.includes(key));
	if (unexpected)
		throw new Error(`${toolName} does not support \`${unexpected}\`; remove it and use documented arguments.`);
}

// Hashline rows use N:TEXT for matches and N-TEXT for context; reject copied output before path selector parsing.
function isSearchResultLine(path: string): boolean {
	return /^\s*(?:\*\s*)?\d+(?::\s+|-\D)/.test(path);
}
function resultLinePathError(toolName: "read" | "search", path: string): Error {
	const received = path.length > 180 ? `${path.slice(0, 177)}...` : path;
	return new Error(
		toolName +
			" received " +
			JSON.stringify(received) +
			" as path. Use a file path such as src/app.ts:120-180; N:TEXT and N-TEXT are result rows, not paths.",
	);
}
function prepareSearchArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const record = { ...(input as Record<string, unknown>) };
	aliasKey(record, "pattern", ["query", "regex", "q"]);
	aliasKey(record, "glob", [".glob"]);
	if (record.limit === undefined && record.max_results !== undefined) record.limit = record.max_results;

	if (typeof record.path === "string" && isSearchResultLine(record.path))
		throw resultLinePathError("search", record.path);
	rejectUnexpectedArguments("search", record, [
		"pattern",
		"query",
		"regex",
		"q",
		"path",
		"glob",
		".glob",
		"context",
		"limit",
		"max_results",
		"ignoreCase",
		"literal",
		"skip",
		"ranges",
	]);
	return record;
}

/** `glob` and `name` both mean "filter by this glob"; without the alias `find({glob: "*.txt"})` listed every file. */
function prepareFindArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const record = { ...(input as Record<string, unknown>) };
	aliasKey(record, "pattern", ["glob", "name"]);
	rejectUnexpectedArguments("find", record, [
		"paths",
		"path",
		"pattern",
		"glob",
		"name",
		"skip",
		"hidden",
		"gitignore",
		"limit",
	]);
	return record;
}

function prepareReadArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const record = { ...(input as Record<string, unknown>) };
	aliasKey(record, "path", ["file_path", "filePath"]);
	if (typeof record.path === "string" && isSearchResultLine(record.path))
		throw resultLinePathError("read", record.path);
	rejectUnexpectedArguments("read", record, ["path", "file_path", "filePath", "raw", ...READ_RANGE_KEYS]);
	return record;
}

export function readRangeKeyReason(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	const used = READ_RANGE_KEYS.filter((key) => record[key] !== undefined);
	if (used.length === 0) return undefined;
	const path = typeof record.path === "string" ? record.path : "file.ts";
	return `${READ_RANGE_HINT} \`${path}:120-180\`. Ignored ${used.map((key) => `\`${key}\``).join(", ")}.`;
}

function prepareEditArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const raw = input as Record<string, unknown>;
	rejectUnexpectedArguments("edit", raw, [
		"input",
		"path",
		"file_path",
		"edits",
		"oldText",
		"newText",
		"old_text",
		"new_text",
		"all",
	]);
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
		throw new Error("edit replace mode has all: true disabled by /agent-settings edit replace.");
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

const PATTERN_ESCAPE_HINT =
	"The pattern is a regex. Escape metacharacters such as ( ) [ ] { } | * + ? \\ (for example `unique\\(by`), or pass `literal: true` to match the text exactly.";

/**
 * rg exits 0 for matches, 1 for none, and 2+ for a real failure. Reading 2 as "nothing found" turned a regex parse
 * error, an unreadable path, and a malformed glob into confident false negatives.
 */
function rgFailure(result: { exitCode: number; stderr: string }, label: string, hint: string): Error | undefined {
	if (result.exitCode === 0 || result.exitCode === 1) return undefined;
	const detail = result.stderr.trim() || `rg exited with code ${result.exitCode}`;
	if (/regex parse error/i.test(detail)) return new Error(`Search pattern is invalid: ${detail}\n${hint}`);
	if (/IO error|permission denied|no such file or directory/i.test(detail))
		return new Error(`Search root could not be read: ${detail}`);
	return new Error(`${label}: ${detail}`);
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
			const hitFailure = rgFailure(result, "search could not run", PATTERN_ESCAPE_HINT);
			if (hitFailure) throw hitFailure;
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

	async preflightWrite(path: string, options?: PreflightWriteOptions): Promise<void> {
		const resource = this.#resource(path);
		if (resource) {
			if (options?.fileOp) {
				throw new ResourceError(
					"read_only",
					`Resource file operations are not supported: ${formatResourceUri(resource)}`,
				);
			}
			if (!resourceProvider(resource.scheme)?.write)
				throw new ResourceError("read_only", `Resource is read-only: ${formatResourceUri(resource)}`);
			return;
		}
		await mkdir(dirname(this.#absolute(path)), { recursive: true });
		if (options?.fileOp?.kind === "move") {
			if (this.#resource(options.fileOp.dest)) throw new Error("MV does not support resource destinations.");
			await mkdir(dirname(this.#absolute(options.fileOp.dest)), { recursive: true });
		}
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

	override async delete(path: string): Promise<void> {
		if (this.#resource(path)) throw new Error("REM does not support resource URIs.");
		await rm(this.#absolute(path));
	}

	override async move(from: string, to: string, content?: string): Promise<void> {
		if (this.#resource(from) || this.#resource(to)) throw new Error("MV does not support resource URIs.");
		if (content !== undefined) await writeFile(this.#absolute(to), content, "utf-8");
		else await writeFile(this.#absolute(to), await readFile(this.#absolute(from)));
		await rm(this.#absolute(from));
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
			? `PUT >${resolution.anchorLine}*:`
			: resolution.op === "cut"
				? `CUT ${resolution.anchorLine}*`
				: resolution.op === "paste_after"
					? `PUT >${resolution.anchorLine}*`
					: `PUT ${resolution.anchorLine}*:`;
	const lines = resolution.end - resolution.start + 1;
	const span =
		resolution.start === resolution.end ? `line ${resolution.start}` : `lines ${resolution.start}-${resolution.end}`;
	return `${op} resolved ${span} (${lines} line${lines === 1 ? "" : "s"})`;
}

function hasStructuralDelimiterChange(before: string, after: string): boolean {
	if (before === after) return false;
	return /[{}()[\]]/.test(before) || /[{}()[\]]/.test(after);
}

function editPreviewContextLines(before: string, after: string, warnings: readonly string[]): number {
	return warnings.length > 0 || hasStructuralDelimiterChange(before, after) ? 4 : 2;
}

const APPLY_PATCH_PATH_HEADER = /^\*\*\* (?:(Add|Update|Delete) File:|(Move to):)\s*(.+)$/gim;

function canonicalApplyPatchHeader(operation: string | undefined, move: string | undefined): string {
	if (move) return "*** Move to:";
	const normalized = `${operation?.slice(0, 1).toUpperCase()}${operation?.slice(1).toLowerCase()}`;
	return `*** ${normalized} File:`;
}

export function normalizeApplyPatchInput(cwd: string, input: string): string {
	return input.replace(
		APPLY_PATCH_PATH_HEADER,
		(_line, operation: string | undefined, move: string | undefined, rawPath: string) => {
			const path = rawPath.trim();
			const ref = resolvePathRef(path, cwd);
			if (ref.kind !== "local") {
				throw new Error(`Resource URI cannot be sent to native apply_patch: ${ref.uri}`);
			}
			return `${canonicalApplyPatchHeader(operation, move)} ${/^file:/i.test(path) ? ref.path : path}`;
		},
	);
}

function applyPatchTouchedPaths(cwd: string, input: string): string[] {
	const normalized = normalizeApplyPatchInput(cwd, input);
	const paths = [...normalized.matchAll(APPLY_PATCH_PATH_HEADER)]
		.map((match) => match[3]?.trim())
		.filter((path): path is string => Boolean(path))
		.map((path) => absolutePath(cwd, path));
	return [...new Set(paths)].sort();
}

function previewApplyPatch(cwd: string, input: string): ApplyPatchResult | undefined {
	if (!/^\*\*\* End Patch\s*$/im.test(input)) return undefined;
	const normalized = normalizeApplyPatchInput(cwd, input);
	const root = mkdtempSync(join(tmpdir(), "pi-apply-patch-preview-"));
	const workspace = join(root, "workspace");
	const inputPath = join(root, "input.patch");
	const outputPath = join(root, "output.json");
	mkdirSync(workspace);
	try {
		const rewritten = normalized.replace(
			APPLY_PATCH_PATH_HEADER,
			(_line, operation: string | undefined, move: string | undefined, rawPath: string) => {
				const absolute = absolutePath(cwd, rawPath.trim());
				const local = relative(cwd, absolute);
				if (!local || local.startsWith("..") || isAbsolute(local)) {
					throw new Error(`apply_patch preview path escapes cwd: ${rawPath.trim()}`);
				}
				const source = join(cwd, local);
				const target = join(workspace, local);
				if (existsSync(source)) {
					mkdirSync(dirname(target), { recursive: true });
					copyFileSync(source, target);
				}
				return `${canonicalApplyPatchHeader(operation, move)} ${local}`;
			},
		);
		writeFileSync(inputPath, rewritten, "utf8");
		spawnSync(applyPatchBinaryPath(), [], {
			cwd: workspace,
			encoding: "utf8",
			env: {
				...process.env,
				PI_APPLY_PATCH_INPUT_FILE: inputPath,
				PI_APPLY_PATCH_JSON: "1",
				PI_APPLY_PATCH_JSON_FILE: outputPath,
			},
			maxBuffer: 10 * 1024 * 1024,
		});
		if (!existsSync(outputPath)) return undefined;
		const result = JSON.parse(readFileSync(outputPath, "utf8")) as ApplyPatchResult;
		return Array.isArray(result.changes) ? result : undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

function applyPatchChangeDiff(change: ApplyPatchChange): string {
	switch (change.kind) {
		case "add":
			return createTwoFilesPatch(change.path, change.path, change.overwrittenContent ?? "", change.content, "", "", {
				context: 3,
			});
		case "delete":
			return createTwoFilesPatch(change.path, change.path, change.content, "", "", "", { context: 3 });
		case "update":
			if (change.movePath) {
				return [
					createTwoFilesPatch(change.path, change.path, change.oldContent, "", "", "", { context: 3 }),
					createTwoFilesPatch(
						change.movePath,
						change.movePath,
						change.overwrittenMoveContent ?? "",
						change.newContent,
						"",
						"",
						{ context: 3 },
					),
				].join("");
			}
			return createTwoFilesPatch(change.path, change.path, change.oldContent, change.newContent, "", "", {
				context: 3,
			});
	}
}

async function applyPatchSnapshotResults(
	cwd: string,
	result: ApplyPatchResult,
	snapshots: InMemorySnapshotStore,
): Promise<Array<{ path: string; header: string; validation: "unchecked" }>> {
	const paths = result.changes.flatMap((change) => {
		if (change.kind === "delete") return [];
		if (change.kind === "update") return [change.movePath ?? change.path];
		return [change.path];
	});
	const entries = await Promise.all(
		[...new Set(paths)].map(async (path) => {
			const tag = await recordHashlineFileSnapshot(snapshots, absolutePath(cwd, path));
			return tag ? { path, header: formatHashlineHeader(path, tag), validation: "unchecked" as const } : undefined;
		}),
	);
	return entries.filter(
		(entry): entry is { path: string; header: string; validation: "unchecked" } => entry !== undefined,
	);
}
type ApplyPatchSnapshotResult = { path: string; header: string; validation: "unchecked" };

function applyPatchCommittedMessages(
	result: ApplyPatchResult,
	snapshots: readonly ApplyPatchSnapshotResult[],
): string[] {
	const headers = new Map(snapshots.map(({ path, header }) => [path, header]));
	return result.changes.flatMap((change) => {
		if (change.kind === "delete") return [`Removed ${change.path}.`];
		const path = change.kind === "update" ? (change.movePath ?? change.path) : change.path;
		const header = headers.get(path);
		return header ? [header] : [];
	});
}

function applyPatchResultText(result: ApplyPatchResult, committed: readonly string[]): string {
	const base =
		result.status === "failure"
			? [`Error: ${result.error ?? "apply_patch failed."}`, ...committed]
			: committed.length > 0
				? [...committed]
				: [
						`Applied patch to ${result.result.changedFiles.length} file${result.result.changedFiles.length === 1 ? "" : "s"}.`,
					];
	if (!result.exact) {
		base.push(
			"Warning: apply_patch reported unknown filesystem state. Re-read every touched path before editing again.",
		);
	}
	return base.join("\n");
}

async function executeApplyPatch(
	cwd: string,
	input: string,
	snapshots: InMemorySnapshotStore,
	signal?: AbortSignal,
): Promise<ToolTextResult> {
	const normalizedInput = normalizeApplyPatchInput(cwd, input);
	const result = await withHashlineMutationQueues(applyPatchTouchedPaths(cwd, normalizedInput), () =>
		runApplyPatch(cwd, normalizedInput, signal),
	);
	const results = await applyPatchSnapshotResults(cwd, result, snapshots);
	const diff = result.changes.map(applyPatchChangeDiff).join("\n");
	const committed = applyPatchCommittedMessages(result, results);
	const text = applyPatchResultText(result, committed);
	return {
		content: [{ type: "text", text }],
		details: { ...result, diff, patch: diff, results },
	};
}

async function executeHashline(
	cwd: string,
	input: string,
	config: EditConfig,
	snapshots: InMemorySnapshotStore,
	resourceContext?: ResourceContext,
	sessionEntries: readonly HashlineSessionEntry[] = [],
): Promise<ToolTextResult> {
	const patch = Patch.parse(input, { cwd });
	if (patch.sections.length === 0) throw new Error("hashline mode requires at least one [PATH#TAG] section.");
	const fs = new CwdHashlineFilesystem(cwd, resourceContext);
	const requestedSnapshots = new Set<string>();
	for (const section of patch.sections) {
		if (!section.fileHash) continue;
		requestedSnapshots.add(`${fs.canonicalPath(section.path)}#${section.fileHash}`);
	}
	if (requestedSnapshots.size > 0) {
		await restoreHashlineSnapshots(snapshots, cwd, sessionEntries, requestedSnapshots);
	}
	// The block resolver is synchronous; warm its language cache for every
	// section path before the apply so `PUT N*:` and `CUT N*` edits resolve.
	await preloadBlockLanguages(
		patch.sections.flatMap((section) => [section.path, ...embeddedGrammarPaths(section.path)]),
	);
	const patcher = new Patcher({
		fs,
		snapshots,
		blockResolver: treeSitterBlockResolver,
		syntaxValidator: fileSyntaxValidator,
		applyOptions: { autoDropPureInsertDuplicates: config.autoDropPureInsertDuplicates },
		clipboard: clipboardForSnapshots(snapshots),
	});
	const targets = patch.sections.flatMap((section) => {
		const fileOp = section.parse().fileOp;
		return [fs.canonicalPath(section.path), ...(fileOp?.kind === "move" ? [fs.canonicalPath(fileOp.dest)] : [])];
	});
	let applied: Awaited<ReturnType<Patcher["apply"]>>;
	try {
		applied = await withHashlineMutationQueues(targets, () => patcher.apply(patch));
	} catch (error) {
		if (!(error instanceof HashlineApplyError)) throw error;
		return {
			content: [{ type: "text", text: error.message }],
			details: { ...error.contract, diff: "", patch: "" },
		};
	}

	const sectionTexts: string[] = [];
	const diffs: string[] = [];
	for (const section of applied.sections) {
		if (section.op === "noop") {
			const warningsBlock = section.warnings.length > 0 ? `\n\nWarnings:\n${section.warnings.join("\n")}` : "";
			sectionTexts.push(`${noChangeDiagnostic(section.path)}${warningsBlock}`);
			continue;
		}
		if (section.op === "delete") {
			const warningsBlock = section.warnings.length > 0 ? `\n\nWarnings:\n${section.warnings.join("\n")}` : "";
			sectionTexts.push(`Removed ${section.path}.${warningsBlock}`);
			diffs.push(createTwoFilesPatch(section.path, section.path, section.before, "", "", "", { context: 3 }));
			continue;
		}
		// Model-facing text: the fresh `[path#tag]` re-anchoring handle, block
		// span echoes, and a compact post-edit preview whose line numbers are
		// directly usable by the next edit.
		const numberedDiff = generateNumberedDiff(section.before, section.after, {
			contextLines: editPreviewContextLines(section.before, section.after, section.warnings),
			path: section.path,
			blockContext: findBlockContextLines,
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
			...hashlineContract("success", null, applied.sections),
			patch: diff,
			// `validation` rides `details`, never `sectionTexts`: a `.txt` or extensionless edit is
			// legitimately unchecked, so a model-facing line would fire on almost every call. In
			// `details` it is countable across the transcript, which is what was missing when the
			// whole `.md`/`.json`/`.toml` corpus turned out to be unguarded.
			results: applied.sections.map(({ path, header, validation }) => ({ path, header, validation })),
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
	sessionEntries: readonly HashlineSessionEntry[] = [],
): Promise<ToolTextResult> {
	switch (config.mode) {
		case "apply_patch":
			rejectUnexpectedArguments("edit", params as Record<string, unknown>, ["input"]);
			if (typeof params.input !== "string") throw new Error("edit apply_patch mode requires input.");
			return executeApplyPatch(cwd, params.input, snapshots, signal);
		case "hashline": {
			rejectUnexpectedArguments("edit", params as Record<string, unknown>, ["input"]);
			if (typeof params.input !== "string") throw new Error("edit hashline mode requires input.");
			return executeHashline(cwd, params.input, config, snapshots, resourceContext, sessionEntries);
		}
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

export type {
	EditConfig,
	EditInput,
	LineRange,
	NormalizedReplaceInput,
	ReadSelector,
	ResourceReadSummary,
	ToolTextResult,
};
export {
	absolutePath,
	aliasKey,
	applyNormalizedReplace,
	applyPatchChangeDiff,
	applyPatchCommittedMessages,
	applyPatchResultText,
	applyPatchSnapshotResults,
	applyPatchTouchedPaths,
	boundedTextResult,
	boundedWithCapture,
	buildCompactDiffPreview,
	buildLineEntriesWithBlockContext,
	clampLineRanges,
	conflictsReadResult,
	DEFAULT_CONFIG,
	DEFAULT_SEARCH_RESULT_LIMIT,
	detectLineEnding,
	detectSupportedReadImageMimeType,
	displayPath,
	EDIT_MODES,
	editPreviewContextLines,
	executeApplyPatch,
	executeByMode,
	executeHashline,
	executeReplace,
	FILEOPS_TOOL_SEARCH_PATHS,
	findPageSize,
	findToolSchema,
	firstChangedLine,
	formatHashlineHeader,
	GREP_MAX_LINE_CHARS,
	HASHLINE_PROMPT,
	INTERNAL_FETCH_LIMIT,
	interleaveByFile,
	loadConfig,
	localFiles,
	localResource,
	localResourceProvider,
	localResourceUri,
	mergeLineRanges,
	modeDescription,
	modeParameters,
	noChangeDiagnostic,
	normalizeMode,
	normalizeReplaceInput,
	normalizeToLf,
	pageWindow,
	pagingNotice,
	parseLineRange,
	parseReplaceInput,
	prepareEditArguments,
	prepareFindArguments,
	prepareReadArguments,
	prepareSearchArguments,
	READ_RANGE_HINT,
	READ_RANGE_KEYS,
	READ_SUMMARY_FOOTER_SPANS,
	READ_SUMMARY_MAX_BYTES,
	READ_SUMMARY_MAX_LINES,
	readToolSchema,
	rejectedHashRange,
	replaceFuzzy,
	resourceContextText,
	resourceReadResult,
	resourceRecord,
	resourceSummaryList,
	resourceViewRows,
	restoreLineEndings,
	rgFailure,
	SEARCH_CONTEXT_LINES,
	SEARCH_FILE_WINDOW,
	SEARCH_NEEDS_PATTERN,
	SINGLE_FILE_ROW_BUDGET,
	searchContextLines,
	searchMatchLimit,
	searchToolSchema,
	selectedLineEntries,
	splitGlobSearchRoot,
	splitReadPathSelector,
	stripBom,
	stripHashlineDisplayPrefixes,
	TREE_MATCHES_PER_FILE,
	textToDisplayLines,
	trySummarizeWholeFileRead,
	unescapedSlashPath,
	withEditTurnIndex,
	withHashlineMutationQueues,
	writeToolSchema,
};
