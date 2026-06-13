/**
 * Numbered-diff producer + compact preview for hashline edit results.
 *
 * {@link generateNumberedDiff} emits `+<lineNum>|content` / `-<lineNum>|content`
 * / ` <lineNum>|content` rows (`+` rows numbered post-edit, `-` and context
 * rows pre-edit) with limited context around changes.
 *
 * {@link buildCompactDiffPreview} re-numbers that shape into a compact
 * current-file preview. Removed lines are counted for stats and post-edit
 * offset tracking, but omitted from the preview. Added and context lines are
 * anchored to their post-edit positions so a follow-up edit can reuse visible
 * concrete lines directly. Long contiguous added runs are summarized with a
 * `…` marker instead of echoing every inserted line.
 */
import { diffLines } from "diff";
import { findBlockContextLines } from "../block-context.ts";
import type { CompactDiffOptions, CompactDiffPreview } from "./types";

const DIFF_CONTEXT_LINES = 2;

function formatNumberedDiffLine(prefix: "+" | "-" | " ", lineNum: number, content: string): string {
	return `${prefix}${lineNum}|${content}`;
}

/** Result of {@link generateNumberedDiff}. */
export interface NumberedDiffOptions {
	/** Context lines around changed regions (default 2). */
	contextLines?: number;
	/** Path used for tree-sitter block-boundary context. */
	path?: string;
}

function normalizeContextLines(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DIFF_CONTEXT_LINES;
	return Math.max(0, Math.trunc(value));
}

export interface NumberedDiff {
	diff: string;
	/** First changed line number in the post-edit file, or `undefined` when equal. */
	firstChangedLine?: number;
}

const DIFF_GAP_ROW = "...";

function insertContextRows(rows: string[], contextLines: ReadonlyMap<number, string>): void {
	const context = [...contextLines].sort(([left], [right]) => left - right);
	const seen = new Set(rows);
	for (const [lineNumber, text] of context) {
		const row = formatNumberedDiffLine(" ", lineNumber, text);
		if (seen.has(row)) continue;
		let insertIndex = rows.length;
		let previousSourceLine: number | undefined;
		let nextSourceLine: number | undefined;
		for (let i = 0; i < rows.length; i++) {
			const parsed = parseNumberedDiffLine(rows[i]);
			if (!parsed || parsed.kind === "+") continue;
			if (parsed.lineNumber < lineNumber) {
				previousSourceLine = parsed.lineNumber;
				continue;
			}
			nextSourceLine = parsed.lineNumber;
			insertIndex = i;
			break;
		}
		const chunk: string[] = [];
		if (previousSourceLine !== undefined && lineNumber > previousSourceLine + 1) chunk.push(DIFF_GAP_ROW);
		chunk.push(row);
		if (nextSourceLine !== undefined && nextSourceLine > lineNumber + 1) chunk.push(DIFF_GAP_ROW);
		rows.splice(insertIndex, 0, ...chunk);
		seen.add(row);
	}
}

function addBlockContextRows(
	rows: string[],
	oldLines: readonly string[],
	newLines: readonly string[],
	path?: string,
): void {
	if (!path) return;
	const oldVisible: number[] = [];
	const newVisible: number[] = [];
	const changes: { newPos: number; delta: 1 | -1 }[] = [];
	let offset = 0;
	for (const row of rows) {
		const parsed = parseNumberedDiffLine(row);
		if (!parsed) continue;
		switch (parsed.kind) {
			case "-":
				oldVisible.push(parsed.lineNumber);
				changes.push({ newPos: parsed.lineNumber + offset, delta: -1 });
				offset--;
				break;
			case "+":
				newVisible.push(parsed.lineNumber);
				changes.push({ newPos: parsed.lineNumber, delta: 1 });
				offset++;
				break;
			default:
				oldVisible.push(parsed.lineNumber);
				newVisible.push(parsed.lineNumber + offset);
				break;
		}
	}
	const toOldLineNumber = (newLineNumber: number): number => {
		let shift = 0;
		for (const change of changes) if (change.newPos <= newLineNumber) shift += change.delta;
		return newLineNumber - shift;
	};
	const contextRows = findBlockContextLines(oldLines, oldVisible, path);
	for (const [lineNumber, text] of findBlockContextLines(newLines, newVisible, path)) {
		const oldLineNumber = toOldLineNumber(lineNumber);
		if (!contextRows.has(oldLineNumber)) contextRows.set(oldLineNumber, text);
	}
	insertContextRows(rows, contextRows);
}

/**
 * Generate a numbered diff in the `<sign><lineNum>|content` shape with
 * {@link DIFF_CONTEXT_LINES} context lines around each change. Long unchanged
 * runs are elided without placeholders — the jump in emitted line numbers
 * conveys the gap.
 */
export function generateNumberedDiff(
	oldContent: string,
	newContent: string,
	options: NumberedDiffOptions = {},
): NumberedDiff {
	const parts = diffLines(oldContent, newContent);
	const contextLines = normalizeContextLines(options.contextLines);
	const output: string[] = [];

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of raw) {
				if (part.added) {
					output.push(formatNumberedDiffLine("+", newLineNum, line));
					newLineNum++;
				} else {
					output.push(formatNumberedDiffLine("-", oldLineNum, line));
					oldLineNum++;
				}
			}
			lastWasChange = true;
			continue;
		}

		// Context lines — only show a few before/after changes.
		const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
		if (lastWasChange || nextPartIsChange) {
			let leadingSkip = 0;
			let middleSkip = 0;
			let trailingSkip = 0;
			let linesToShow: string[];

			if (lastWasChange && nextPartIsChange) {
				if (raw.length > contextLines * 2) {
					const leadingContext = raw.slice(0, contextLines);
					const trailingContext = raw.slice(raw.length - contextLines);
					middleSkip = raw.length - leadingContext.length - trailingContext.length;
					linesToShow = [...leadingContext, ...trailingContext];
				} else {
					linesToShow = raw;
				}
			} else if (nextPartIsChange) {
				leadingSkip = Math.max(0, raw.length - contextLines);
				linesToShow = raw.slice(leadingSkip);
			} else {
				trailingSkip = Math.max(0, raw.length - contextLines);
				linesToShow = raw.slice(0, contextLines);
			}

			// Skip placeholders are omitted: the jump between emitted line
			// numbers conveys the gap.
			if (leadingSkip > 0) {
				oldLineNum += leadingSkip;
				newLineNum += leadingSkip;
			}

			const firstChunkLength = middleSkip > 0 ? contextLines : linesToShow.length;
			for (const line of linesToShow.slice(0, firstChunkLength)) {
				output.push(formatNumberedDiffLine(" ", oldLineNum, line));
				oldLineNum++;
				newLineNum++;
			}

			if (middleSkip > 0) {
				oldLineNum += middleSkip;
				newLineNum += middleSkip;
				for (const line of linesToShow.slice(firstChunkLength)) {
					output.push(formatNumberedDiffLine(" ", oldLineNum, line));
					oldLineNum++;
					newLineNum++;
				}
			}

			if (trailingSkip > 0) {
				oldLineNum += trailingSkip;
				newLineNum += trailingSkip;
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}

		lastWasChange = false;
	}
	addBlockContextRows(output, oldContent.split("\n"), newContent.split("\n"), options.path);
	return { diff: output.join("\n"), firstChangedLine };
}

const DEFAULT_ADDED_RUN_CONTEXT_LINES = 2;

const PREVIEW_ELISION_MARKER = "…";
const RAW_ELISION_MARKERS = new Set(["...", PREVIEW_ELISION_MARKER, `+${PREVIEW_ELISION_MARKER}`]);

function appendPreviewLine(output: string[], line: string): void {
	const normalized = RAW_ELISION_MARKERS.has(line) ? PREVIEW_ELISION_MARKER : line;
	if (normalized === PREVIEW_ELISION_MARKER && output[output.length - 1] === PREVIEW_ELISION_MARKER) return;
	output.push(normalized);
}

interface ParsedDiffLine {
	kind: "+" | "-" | " ";
	lineNumber: number;
	content: string;
}

function normalizeAddedRunContext(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_ADDED_RUN_CONTEXT_LINES;
	return Math.max(1, Math.trunc(value));
}

function parseNumberedDiffLine(line: string): ParsedDiffLine | undefined {
	const kind = line[0];
	if (kind !== "+" && kind !== "-" && kind !== " ") return undefined;

	const body = line.slice(1);
	const sep = body.indexOf("|");
	if (sep === -1) return undefined;

	const lineNumber = Number.parseInt(body.slice(0, sep), 10);
	if (!Number.isFinite(lineNumber)) return undefined;

	return { kind, lineNumber, content: body.slice(sep + 1) };
}

function appendAddedRun(output: string[], run: string[], edgeLines: number): void {
	if (run.length === 0) return;

	const collapseThreshold = edgeLines * 2 + 1;
	if (run.length <= collapseThreshold) {
		for (const text of run) appendPreviewLine(output, text);
		return;
	}

	for (let i = 0; i < edgeLines; i++) appendPreviewLine(output, run[i]);
	appendPreviewLine(output, PREVIEW_ELISION_MARKER);
	for (let i = run.length - edgeLines; i < run.length; i++) appendPreviewLine(output, run[i]);
}

export function buildCompactDiffPreview(diff: string, options: CompactDiffOptions = {}): CompactDiffPreview {
	const lines = diff.length === 0 ? [] : diff.split("\n");
	const addedRunContext = normalizeAddedRunContext(options.maxAddedRunContext ?? options.maxUnchangedRun);
	let addedLines = 0;
	let removedLines = 0;
	const formatted: string[] = [];
	const addedRun: string[] = [];

	const flushAddedRun = (): void => {
		appendAddedRun(formatted, addedRun, addedRunContext);
		addedRun.length = 0;
	};

	// The diff producer numbers `+` lines with the post-edit line number,
	// `-` lines with the pre-edit line number, and context lines with the
	// pre-edit line number. To emit fresh line numbers usable for follow-up
	// edits, convert context-line numbers to post-edit positions by tracking
	// the running offset (added so far - removed so far) as we walk the diff.
	for (const line of lines) {
		const parsed = parseNumberedDiffLine(line);
		if (!parsed) {
			flushAddedRun();
			appendPreviewLine(formatted, line);
			continue;
		}

		switch (parsed.kind) {
			case "+": {
				addedLines++;
				addedRun.push(`${parsed.lineNumber}:${parsed.content}`);
				break;
			}
			case "-":
				flushAddedRun();
				removedLines++;
				break;
			default: {
				flushAddedRun();
				const newLineNumber = parsed.lineNumber + addedLines - removedLines;
				appendPreviewLine(formatted, `${newLineNumber}:${parsed.content}`);
				break;
			}
		}
	}
	flushAddedRun();

	return { preview: formatted.join("\n"), addedLines, removedLines };
}
