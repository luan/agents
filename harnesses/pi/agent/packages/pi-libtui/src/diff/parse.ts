import { type FileDiffMetadata, HUNK_HEADER, parsePatchFiles } from "@pierre/diffs";
import { sanitizeTuiText } from "../content/terminal-text.ts";
import type {
	ParseUnifiedDiffOptions,
	UnifiedDiffFile,
	UnifiedDiffHunk,
	UnifiedDiffLine,
	UnifiedDiffModel,
} from "./model.ts";
import { DEFAULT_MAX_CHARACTERS, DEFAULT_MAX_FILES, DEFAULT_MAX_ROWS, hash } from "./structured.ts";

const PARSE_CACHE_LIMIT = 4;

const parseCache = new Map<string, { source: string; model: UnifiedDiffModel }>();
const pierreFiles = new WeakMap<UnifiedDiffModel, readonly FileDiffMetadata[]>();

export { createStructuredDiffModel as createUnifiedDiffModel } from "./structured.ts";

/** Parse a unified patch through Pierre's maintained patch parser. */
export function parseUnifiedDiff(source: string, options: ParseUnifiedDiffOptions = {}): UnifiedDiffModel {
	const maxCharacters = positiveInteger(options.maxCharacters, DEFAULT_MAX_CHARACTERS);
	const maxRows = positiveInteger(options.maxRows, DEFAULT_MAX_ROWS);
	const bounded = boundSource(source, maxCharacters, maxRows);
	const cacheKey = `${maxCharacters}:${maxRows}:${bounded.truncated}:${bounded.rows}:${hash(bounded.source)}`;
	const cached = parseCache.get(cacheKey);
	if (cached?.source === bounded.source) return touch(parseCache, cacheKey, cached).model;

	const patches = parsePierrePatch(bounded.source, cacheKey);
	const files = patches.flatMap((patch) => patch.files).slice(0, DEFAULT_MAX_FILES);
	const fileSides = patchFileSides(bounded.source);
	const converted = files.map((file, index) => convertFile(file, index, fileSides[index]));
	const preamble = patches.flatMap((patch) =>
		patch.patchMetadata ? patch.patchMetadata.replace(/\n$/u, "").split("\n").map(sanitizeTuiText) : [],
	);
	const model: UnifiedDiffModel = Object.freeze({
		revision: hash(`${bounded.source.length}:${bounded.source}:${bounded.truncated}`),
		files: Object.freeze(converted),
		preamble: Object.freeze(preamble),
		additions: converted.reduce((total, file) => total + file.additions, 0),
		removals: converted.reduce((total, file) => total + file.removals, 0),
		sourceRows: bounded.rows,
		truncated: bounded.truncated || files.length < patches.reduce((total, patch) => total + patch.files.length, 0),
	});
	pierreFiles.set(model, Object.freeze(files));
	return boundedSet(parseCache, cacheKey, { source: bounded.source, model }, PARSE_CACHE_LIMIT).model;
}

function parsePierrePatch(source: string, cacheKey: string): ReturnType<typeof parsePatchFiles> {
	try {
		return parsePatchFiles(source, cacheKey, true);
	} catch {
		// Pierre's tolerant mode keeps valid rows when a caller supplied a range
		// for a bounded preview. Complete only the physical-row boundary here;
		// Pierre still owns hunk ranges, row counts, and row semantics.
		const firstHunk = source.indexOf("\n@@");
		if (firstHunk < 0) return [];
		const lastNewline = source.lastIndexOf("\n");
		const tail = source.slice(lastNewline + 1);
		const hasCompleteRow = ["+", "-", " ", "\\"].some((marker) => tail.startsWith(marker));
		const completeSource = source.endsWith("\n")
			? source
			: hasCompleteRow
				? `${source}\n`
				: source.slice(0, lastNewline + 1);
		if (!completeSource) return [];
		return parsePatchFiles(completeSource, cacheKey, false);
	}
}

/** Internal bridge used by the terminal renderer for Pierre/Shiki decoration. */
export function pierreFilesFor(model: UnifiedDiffModel): readonly FileDiffMetadata[] {
	return pierreFiles.get(model) ?? [];
}

interface PatchFileSides {
	readonly oldMissing: boolean;
	readonly newMissing: boolean;
}

function convertFile(file: FileDiffMetadata, fileIndex: number, sides: PatchFileSides | undefined): UnifiedDiffFile {
	const ref = `f${fileIndex}`;
	const oldPath = normalizePath(sides?.oldMissing || file.type === "new" ? undefined : (file.prevName ?? file.name));
	const newPath = normalizePath(sides?.newMissing || file.type === "deleted" ? undefined : file.name);
	const hunks = file.hunks.map((_, hunkIndex) => convertHunk(file, ref, hunkIndex));
	return Object.freeze({
		ref,
		oldPath,
		newPath,
		headerLines: Object.freeze([
			`--- ${oldPath ? `a/${oldPath}` : "/dev/null"}`,
			`+++ ${newPath ? `b/${newPath}` : "/dev/null"}`,
		]),
		hunks: Object.freeze(hunks),
		additions: hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "added").length, 0),
		removals: hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "removed").length, 0),
	});
}

/**
 * Pierre normalizes `/dev/null` to an ordinary path for partial patches, so
 * it cannot tell a missing side from a file whose contents happen to be
 * empty. Keep this bridge limited to the file-header markers needed to retain
 * that presentation fact. The `diff` and `@@` checks are only boundaries;
 * Pierre still owns hunk ranges, row classification, and all diff semantics.
 */
function patchFileSides(source: string): readonly PatchFileSides[] {
	const sides: PatchFileSides[] = [];
	let current: { oldMissing: boolean; newMissing: boolean } | undefined;
	let hasHeader = false;
	let inHunk = false;
	let remainingOldLines = 0;
	let remainingNewLines = 0;
	const finish = () => {
		if (current) sides.push(current);
		current = undefined;
		hasHeader = false;
	};
	const lines = source.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (line.startsWith("diff ")) {
			finish();
			current = { oldMissing: false, newMissing: false };
			inHunk = false;
			remainingOldLines = 0;
			remainingNewLines = 0;
			continue;
		}
		if (!inHunk && isUnifiedFileHeader(lines, index)) {
			if (hasHeader) finish();
			current ??= { oldMissing: false, newMissing: false };
			current.oldMissing = isDevNullHeader(line, "--- ");
			current.newMissing = isDevNullHeader(lines[index + 1]!, "+++ ");
			hasHeader = true;
			index += 1;
			continue;
		}
		if (line.startsWith("@@ ")) {
			const hunk = HUNK_HEADER.exec(line);
			inHunk = true;
			remainingOldLines = hunk ? Number(hunk[2] ?? 1) : 0;
			remainingNewLines = hunk ? Number(hunk[4] ?? 1) : 0;
			if (remainingOldLines === 0 && remainingNewLines === 0) inHunk = false;
			continue;
		}
		if (inHunk) {
			if (!line.startsWith("\\")) {
				if (line.startsWith(" ") || line.startsWith("-")) remainingOldLines = Math.max(0, remainingOldLines - 1);
				if (line.startsWith(" ") || line.startsWith("+")) remainingNewLines = Math.max(0, remainingNewLines - 1);
			}
			if (remainingOldLines === 0 && remainingNewLines === 0) inHunk = false;
		}
	}
	finish();
	return sides;
}

function isUnifiedFileHeader(lines: readonly string[], index: number): boolean {
	const oldLine = lines[index];
	const newLine = lines[index + 1];
	return (
		oldLine !== undefined && newLine !== undefined && isPathHeader(oldLine, "--- ") && isPathHeader(newLine, "+++ ")
	);
}

function isPathHeader(line: string, prefix: "--- " | "+++ "): boolean {
	return line.startsWith(prefix) && line.slice(prefix.length).trim().length > 0;
}

function isDevNullHeader(line: string, prefix: "--- " | "+++ "): boolean {
	return line.startsWith(prefix) && line.slice(prefix.length).split("\t", 1)[0]?.trim() === "/dev/null";
}

function convertHunk(file: FileDiffMetadata, fileRef: string, hunkIndex: number): UnifiedDiffHunk {
	const source = file.hunks[hunkIndex]!;
	const ref = `${fileRef}:h${hunkIndex}`;
	const lines: UnifiedDiffLine[] = [];
	let oldLine = source.deletionStart;
	let newLine = source.additionStart;
	for (const content of source.hunkContent) {
		if (content.type === "context") {
			for (let index = 0; index < content.lines; index += 1) {
				lines.push(
					line(
						ref,
						lines.length,
						"context",
						file.deletionLines[content.deletionLineIndex + index] ?? "",
						oldLine,
						newLine,
					),
				);
				oldLine += 1;
				newLine += 1;
			}
			continue;
		}
		for (let index = 0; index < content.deletions; index += 1) {
			lines.push(
				line(
					ref,
					lines.length,
					"removed",
					file.deletionLines[content.deletionLineIndex + index] ?? "",
					oldLine,
					undefined,
				),
			);
			oldLine += 1;
		}
		for (let index = 0; index < content.additions; index += 1) {
			lines.push(
				line(
					ref,
					lines.length,
					"added",
					file.additionLines[content.additionLineIndex + index] ?? "",
					undefined,
					newLine,
				),
			);
			newLine += 1;
		}
	}
	if (source.noEOFCRDeletions || source.noEOFCRAdditions) {
		lines.push(line(ref, lines.length, "metadata", "\\ No newline at end of file", undefined, undefined));
	}
	return Object.freeze({
		ref,
		header: cleanLine(source.hunkSpecs ?? inferredHunkHeader(source)),
		oldStart: source.deletionStart,
		oldCount: source.deletionCount,
		newStart: source.additionStart,
		newCount: source.additionCount,
		lines: Object.freeze(lines),
	});
}

function line(
	hunkRef: string,
	index: number,
	kind: UnifiedDiffLine["kind"],
	text: string,
	oldLine: number | undefined,
	newLine: number | undefined,
): UnifiedDiffLine {
	return Object.freeze({ ref: `${hunkRef}:l${index}`, kind, text: cleanLine(text), oldLine, newLine });
}

function inferredHunkHeader(hunk: FileDiffMetadata["hunks"][number]): string {
	return `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@${hunk.hunkContext ? ` ${hunk.hunkContext}` : ""}`;
}

function cleanLine(text: string): string {
	return sanitizeTuiText(text.replace(/\r?\n$/u, ""));
}

function normalizePath(raw: string | undefined): string | undefined {
	if (!raw || raw === "/dev/null") return undefined;
	const path = raw.split("\t", 1)[0]?.trim();
	if (!path) return undefined;
	return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function boundSource(
	source: string,
	maxCharacters: number,
	maxRows: number,
): {
	readonly source: string;
	readonly rows: number;
	readonly truncated: boolean;
} {
	const characterBounded = source.slice(0, maxCharacters);
	let end = characterBounded.length;
	let rows = 0;
	let cursor = 0;
	while (cursor < characterBounded.length && rows < maxRows) {
		const newline = characterBounded.indexOf("\n", cursor);
		rows += 1;
		if (newline < 0) {
			cursor = characterBounded.length;
			break;
		}
		cursor = newline + 1;
	}
	if (cursor < characterBounded.length) end = cursor;
	const bounded = characterBounded.slice(0, end);
	return { source: bounded, rows: Math.min(rows, maxRows), truncated: bounded.length < source.length };
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
}

function touch<K, V>(cache: Map<K, V>, key: K, value: V): V {
	cache.delete(key);
	cache.set(key, value);
	return value;
}

function boundedSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
	cache.set(key, value);
	while (cache.size > limit) {
		const oldest = cache.keys().next().value as K | undefined;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return value;
}
