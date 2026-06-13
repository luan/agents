/**
 * Apply a parsed list of {@link Edit}s to a text body and return the
 * post-edit lines plus any diagnostic warnings. Pure function: no FS, no
 * mutation of the input.
 *
 * Replacement groups are first normalized by {@link repairReplacementBoundaries},
 * which absorbs common model mistakes where a payload restates unchanged range
 * boundaries or duplicates/drops structural closers.
 */
import { afterInsertLandingShiftWarning, blockInsertLandingShiftWarning, UNRESOLVED_BLOCK_INTERNAL } from "./messages";
import { cloneCursor } from "./tokenizer";
import type { Anchor, ApplyOptions, ApplyResult, Cursor, Edit } from "./types";

type LineOrigin = "original" | "insert" | "replacement";

type InsertEdit = Extract<Edit, { kind: "insert" }>;
type DeleteEdit = Extract<Edit, { kind: "delete" }>;
type AppliedEdit = InsertEdit | DeleteEdit;

interface IndexedEdit {
	edit: AppliedEdit;
	idx: number;
}

function isReplacementInsert(edit: Edit): edit is InsertEdit & { mode: "replacement" } {
	return edit.kind === "insert" && edit.mode === "replacement";
}

function getCursorAnchors(cursor: Cursor): Anchor[] {
	return cursor.kind === "before_anchor" || cursor.kind === "after_anchor" ? [cursor.anchor] : [];
}

function getEditAnchors(edit: AppliedEdit): Anchor[] {
	if (edit.kind === "delete") return [edit.anchor];
	return getCursorAnchors(edit.cursor);
}

/**
 * Verify every anchored edit points at an existing line. File-version binding is
 * checked once per section via the header hash before this function runs.
 */
function validateLineBounds(edits: readonly AppliedEdit[], fileLines: readonly string[]): void {
	for (const edit of edits) {
		for (const anchor of getEditAnchors(edit)) {
			if (anchor.line < 1 || anchor.line > fileLines.length) {
				throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
			}
		}
	}
}

function trailingPhantomLine(fileLines: readonly string[]): number {
	return fileLines.length > 1 && fileLines[fileLines.length - 1] === "" ? fileLines.length : 0;
}

function dropTrailingPhantomDeletes(edits: AppliedEdit[], fileLines: readonly string[]): AppliedEdit[] {
	const phantomLine = trailingPhantomLine(fileLines);
	if (phantomLine === 0) return edits;
	return edits.filter((edit) => edit.kind !== "delete" || edit.anchor.line !== phantomLine);
}

function cloneAppliedEdit(edit: AppliedEdit, index: number): AppliedEdit {
	if (edit.kind === "delete") return { ...edit, anchor: { ...edit.anchor }, index };
	return { ...edit, cursor: cloneCursor(edit.cursor), index };
}

function insertAtStart(fileLines: string[], lineOrigins: LineOrigin[], lines: string[]): void {
	if (lines.length === 0) return;
	const origins = lines.map((): LineOrigin => "insert");
	if (fileLines.length === 1 && fileLines[0] === "") {
		fileLines.splice(0, 1, ...lines);
		lineOrigins.splice(0, 1, ...origins);
		return;
	}
	fileLines.splice(0, 0, ...lines);
	lineOrigins.splice(0, 0, ...origins);
}

function insertAtEnd(fileLines: string[], lineOrigins: LineOrigin[], lines: string[]): number | undefined {
	if (lines.length === 0) return undefined;
	const origins = lines.map((): LineOrigin => "insert");
	if (fileLines.length === 1 && fileLines[0] === "") {
		fileLines.splice(0, 1, ...lines);
		lineOrigins.splice(0, 1, ...origins);
		return 1;
	}
	const hasTrailingNewline = fileLines.length > 0 && fileLines[fileLines.length - 1] === "";
	const insertIndex = hasTrailingNewline ? fileLines.length - 1 : fileLines.length;
	fileLines.splice(insertIndex, 0, ...lines);
	lineOrigins.splice(insertIndex, 0, ...origins);
	return insertIndex + 1;
}

function bucketAnchorEditsByLine(edits: IndexedEdit[]): Map<number, IndexedEdit[]> {
	const byLine = new Map<number, IndexedEdit[]>();
	for (const entry of edits) {
		const line =
			entry.edit.kind === "delete"
				? entry.edit.anchor.line
				: entry.edit.cursor.kind === "before_anchor" || entry.edit.cursor.kind === "after_anchor"
					? entry.edit.cursor.anchor.line
					: 0;
		const bucket = byLine.get(line);
		if (bucket) bucket.push(entry);
		else byLine.set(line, [entry]);
	}
	return byLine;
}

// ═══════════════════════════════════════════════════════════════════════════
// Replacement-boundary repair
//
// Models routinely miscount a replacement range's edges. Sometimes the payload
// re-states unchanged lines that still live on both sides of the range
// (duplicating a function header and final statement); sometimes it only
// re-states or omits a structural closer, which leaves delimiter balance broken.
//
// OMP-style boundary absorption widens the deletion when replacement payloads
// duplicate adjacent file context. Generic context requires 2+ matching lines;
// single-line absorption is limited to structural closing delimiters whose
// removal restores the deleted range's delimiter balance.

/** A line that is nothing but closing delimiters: `}`, `)`, `];`, `})`, `},`. */
export const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/;

interface DelimiterBalance {
	paren: number;
	bracket: number;
	brace: number;
}

/**
 * Net `()` / `[]` / `{}` delta across `lines`, skipping delimiters inside line
 * comments (`//`), block comments, and string/template literals. Block-comment
 * and backtick-template state carry across lines; `"` / `'` reset at EOL since
 * they cannot span lines. Deliberately language-light: constructs it cannot
 * classify (e.g. regex literals) are counted naively, which can only suppress a
 * repair (the safe direction), never force one.
 */
function computeDelimiterBalance(lines: readonly string[]): DelimiterBalance {
	const balance: DelimiterBalance = { paren: 0, bracket: 0, brace: 0 };
	let inBlockComment = false;
	let quote = "";
	for (const line of lines) {
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inBlockComment) {
				if (ch === "*" && line[i + 1] === "/") {
					inBlockComment = false;
					i++;
				}
				continue;
			}
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = "";
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				quote = ch;
				continue;
			}
			if (ch === "/" && line[i + 1] === "/") break;
			if (ch === "/" && line[i + 1] === "*") {
				inBlockComment = true;
				i++;
				continue;
			}
			switch (ch) {
				case "(":
					balance.paren++;
					break;
				case ")":
					balance.paren--;
					break;
				case "[":
					balance.bracket++;
					break;
				case "]":
					balance.bracket--;
					break;
				case "{":
					balance.brace++;
					break;
				case "}":
					balance.brace--;
					break;
			}
		}
		// `"` / `'` cannot span lines; only backtick templates and block comments do.
		if (quote === '"' || quote === "'") quote = "";
	}
	return balance;
}

function balanceDelta(a: DelimiterBalance, b: DelimiterBalance): DelimiterBalance {
	return { paren: a.paren - b.paren, bracket: a.bracket - b.bracket, brace: a.brace - b.brace };
}

function balanceNegate(a: DelimiterBalance): DelimiterBalance {
	return { paren: -a.paren, bracket: -a.bracket, brace: -a.brace };
}

function balanceEqual(a: DelimiterBalance, b: DelimiterBalance): boolean {
	return a.paren === b.paren && a.bracket === b.bracket && a.brace === b.brace;
}

function balanceIsZero(a: DelimiterBalance): boolean {
	return a.paren === 0 && a.bracket === 0 && a.brace === 0;
}

const ZERO_DELIMITER_BALANCE: DelimiterBalance = { paren: 0, bracket: 0, brace: 0 };

function shouldDropSingleStructuralBoundary(
	fullPayload: readonly string[],
	keptPayload: readonly string[],
	expectedBalance: DelimiterBalance,
): boolean {
	return (
		balanceEqual(computeDelimiterBalance(keptPayload), expectedBalance) &&
		!balanceEqual(computeDelimiterBalance(fullPayload), expectedBalance)
	);
}

interface ReplacementGroup {
	/** Positions in the edit array of the payload inserts, in payload order. */
	insertIndices: number[];
	/** Positions in the edit array of the range deletes, ascending by line. */
	deleteIndices: number[];
	payload: string[];
	/** First deleted line (1-indexed). */
	startLine: number;
	/** Last deleted line (1-indexed). */
	endLine: number;
	/** Source patch line for warning and grouping. */
	lineNum: number;
}

/**
 * Detect a replacement group starting at `start`: a run of `before_anchor`
 * replacement inserts sharing one source op line, immediately followed by the
 * contiguous range deletes for that same op. Mirrors how the parser lowers an
 * OMP/hashline replacement hunk with a body.
 */
function findReplacementGroup(edits: readonly AppliedEdit[], start: number): ReplacementGroup | undefined {
	const first = edits[start];
	if (first?.kind !== "insert" || first.mode !== "replacement" || first.cursor.kind !== "before_anchor") {
		return undefined;
	}
	const { lineNum } = first;
	const anchorLine = first.cursor.anchor.line;
	const insertIndices: number[] = [];
	const payload: string[] = [];
	let i = start;
	for (; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.kind !== "insert" || edit.mode !== "replacement" || edit.lineNum !== lineNum) break;
		if (edit.cursor.kind !== "before_anchor" || edit.cursor.anchor.line !== anchorLine) break;
		insertIndices.push(i);
		payload.push(edit.text);
	}
	const deleteIndices: number[] = [];
	let expectedLine = anchorLine;
	for (; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.kind !== "delete" || edit.lineNum !== lineNum || edit.anchor.line !== expectedLine) break;
		deleteIndices.push(i);
		expectedLine++;
	}
	if (deleteIndices.length === 0) return undefined;
	return {
		insertIndices,
		deleteIndices,
		payload,
		startLine: anchorLine,
		endLine: anchorLine + deleteIndices.length - 1,
		lineNum,
	};
}

function findDuplicateSuffix(group: ReplacementGroup, fileLines: readonly string[], delta: DelimiterBalance): number {
	if (balanceIsZero(delta)) return 0;
	const { payload, endLine } = group;
	const maxK = Math.min(payload.length, fileLines.length - endLine);
	for (let k = maxK; k >= 1; k--) {
		let matches = true;
		for (let t = 0; t < k; t++) {
			if (payload[payload.length - k + t] !== fileLines[endLine + t]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		if (balanceEqual(computeDelimiterBalance(payload.slice(payload.length - k)), delta)) return k;
	}
	return 0;
}

function findDuplicatePrefix(group: ReplacementGroup, fileLines: readonly string[], delta: DelimiterBalance): number {
	if (balanceIsZero(delta)) return 0;
	const { payload, startLine } = group;
	const maxJ = Math.min(payload.length, startLine - 1);
	for (let j = maxJ; j >= 1; j--) {
		let matches = true;
		for (let t = 0; t < j; t++) {
			if (payload[t] !== fileLines[startLine - 1 - j + t]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		if (balanceEqual(computeDelimiterBalance(payload.slice(0, j)), delta)) return j;
	}
	return 0;
}

function payloadEndsWithDeletedSuffix(group: ReplacementGroup, fileLines: readonly string[], count: number): boolean {
	if (group.payload.length < count) return false;
	const deletedStart = group.endLine - count;
	const payloadStart = group.payload.length - count;
	for (let offset = 0; offset < count; offset++) {
		if (group.payload[payloadStart + offset] !== fileLines[deletedStart + offset]) return false;
	}
	return true;
}

function findDroppedSuffixClosers(
	group: ReplacementGroup,
	fileLines: readonly string[],
	delta: DelimiterBalance,
): number {
	const wanted = balanceNegate(delta);
	const maxM = group.deleteIndices.length;
	for (let m = 1; m <= maxM; m++) {
		if (!STRUCTURAL_CLOSER_RE.test(fileLines[group.endLine - m] ?? "")) break;
		if (payloadEndsWithDeletedSuffix(group, fileLines, m)) continue;
		if (balanceEqual(computeDelimiterBalance(fileLines.slice(group.endLine - m, group.endLine)), wanted)) return m;
	}
	return 0;
}

interface BoundaryEcho {
	leading: number;
	trailing: number;
}

function hasNonWhitespace(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code !== 9 && code !== 10 && code !== 11 && code !== 12 && code !== 13 && code !== 32) return true;
	}
	return false;
}

function countDuplicateLeadingBoundaryLines(group: ReplacementGroup, fileLines: readonly string[]): number {
	const { payload, startLine } = group;
	const max = Math.min(payload.length, startLine - 1);
	for (let count = max; count >= 1; count--) {
		let matches = true;
		let hasContent = false;
		for (let offset = 0; offset < count; offset++) {
			const line = payload[offset];
			if (line !== fileLines[startLine - 1 - count + offset]) {
				matches = false;
				break;
			}
			hasContent ||= hasNonWhitespace(line);
		}
		if (matches && hasContent) return count;
	}
	return 0;
}

function countDuplicateTrailingBoundaryLines(group: ReplacementGroup, fileLines: readonly string[]): number {
	const { payload, endLine } = group;
	const max = Math.min(payload.length, fileLines.length - endLine);
	for (let count = max; count >= 1; count--) {
		let matches = true;
		let hasContent = false;
		for (let offset = 0; offset < count; offset++) {
			const line = payload[payload.length - count + offset];
			if (line !== fileLines[endLine + offset]) {
				matches = false;
				break;
			}
			hasContent ||= hasNonWhitespace(line);
		}
		if (matches && hasContent) return count;
	}
	return 0;
}

function findBoundaryEcho(group: ReplacementGroup, fileLines: readonly string[]): BoundaryEcho | undefined {
	const leadingMax = countDuplicateLeadingBoundaryLines(group, fileLines);
	if (leadingMax === 0) return undefined;
	const trailingMax = countDuplicateTrailingBoundaryLines(group, fileLines);
	if (trailingMax === 0) return undefined;
	if (leadingMax + trailingMax >= group.payload.length) return undefined;
	const leadingBalance = computeDelimiterBalance(group.payload.slice(0, leadingMax));
	const trailingBalance = computeDelimiterBalance(group.payload.slice(group.payload.length - trailingMax));
	const droppedBalance = balanceDelta(leadingBalance, balanceNegate(trailingBalance));
	if (!balanceIsZero(droppedBalance)) {
		const delta = balanceDelta(
			computeDelimiterBalance(group.payload),
			computeDelimiterBalance(fileLines.slice(group.startLine - 1, group.endLine)),
		);
		if (!balanceEqual(droppedBalance, delta)) return undefined;
	}
	return { leading: leadingMax, trailing: trailingMax };
}

function describeBoundaryEchoRepair(group: ReplacementGroup, echo: BoundaryEcho): string {
	return (
		`Auto-repaired a replacement boundary echo at line ${group.startLine}: ` +
		`dropped ${echo.leading} leading and ${echo.trailing} trailing payload line(s) already present outside the range. ` +
		`Issue the payload as the final desired content for the selected range only — never restate unchanged lines bordering the range.`
	);
}

function describeBoundaryRepair(group: ReplacementGroup, action: string): string {
	return (
		`Auto-repaired a delimiter-balance mismatch in the replacement at line ${group.startLine}: ${action}. ` +
		`Issue the payload as the final desired content only — never restate or omit a closing bracket bordering the range.`
	);
}

interface PureInsertGroup {
	startIndex: number;
	endIndex: number;
	lineNum: number;
	cursor: Cursor;
	payload: string[];
}

function cursorMatches(a: Cursor, b: Cursor): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "bof" || a.kind === "eof") return true;
	if (b.kind === "bof" || b.kind === "eof") return false;
	return a.anchor.line === b.anchor.line;
}

function findPureInsertGroup(edits: readonly AppliedEdit[], start: number): PureInsertGroup | undefined {
	const first = edits[start];
	if (first?.kind !== "insert") return undefined;

	const { lineNum } = first;
	const cursor = first.cursor;
	const payload: string[] = [];
	let index = start;
	while (index < edits.length) {
		const edit = edits[index];
		if (edit.kind !== "insert" || edit.lineNum !== lineNum) break;
		if (!cursorMatches(edit.cursor, cursor)) break;
		payload.push(edit.text);
		index++;
	}

	if (index < edits.length && edits[index].kind === "delete" && edits[index].lineNum === lineNum) return undefined;
	return { startIndex: start, endIndex: index - 1, lineNum, cursor, payload };
}

function pureInsertNeighborhood(
	cursor: Cursor,
	fileLines: readonly string[],
): { aboveEndIdx: number; belowStartIdx: number } {
	if (cursor.kind === "bof") return { aboveEndIdx: -1, belowStartIdx: 0 };
	if (cursor.kind === "eof") return { aboveEndIdx: fileLines.length - 1, belowStartIdx: fileLines.length };
	if (cursor.kind === "before_anchor")
		return { aboveEndIdx: cursor.anchor.line - 2, belowStartIdx: cursor.anchor.line - 1 };
	return { aboveEndIdx: cursor.anchor.line - 1, belowStartIdx: cursor.anchor.line };
}

interface PureInsertAbsorbResult {
	keptPayload: string[];
	absorbedLeading: number;
	absorbedTrailing: number;
	leadingFileRange?: { start: number; end: number };
	trailingFileRange?: { start: number; end: number };
}

function tryAbsorbPureInsertGroup(
	group: PureInsertGroup,
	fileLines: readonly string[],
	allowGenericBoundaryAbsorb: boolean,
): PureInsertAbsorbResult {
	const empty: PureInsertAbsorbResult = { keptPayload: group.payload, absorbedLeading: 0, absorbedTrailing: 0 };
	if (group.payload.length === 0) return empty;

	const { aboveEndIdx, belowStartIdx } = pureInsertNeighborhood(group.cursor, fileLines);
	let absorbedLeading = 0;
	if (allowGenericBoundaryAbsorb) {
		const maxLead = Math.min(group.payload.length, aboveEndIdx + 1);
		for (let count = maxLead; count >= 2; count--) {
			let ok = true;
			for (let offset = 0; offset < count; offset++) {
				if (group.payload[offset] !== fileLines[aboveEndIdx - count + 1 + offset]) {
					ok = false;
					break;
				}
			}
			if (ok) {
				absorbedLeading = count;
				break;
			}
		}
	}
	if (
		absorbedLeading === 0 &&
		allowGenericBoundaryAbsorb &&
		group.cursor.kind === "after_anchor" &&
		group.payload.length > 0 &&
		aboveEndIdx >= 0 &&
		!STRUCTURAL_CLOSER_RE.test(group.payload[0]) &&
		group.payload[0] === fileLines[aboveEndIdx]
	) {
		absorbedLeading = 1;
	}
	if (
		absorbedLeading === 0 &&
		group.payload.length > 0 &&
		aboveEndIdx >= 0 &&
		STRUCTURAL_CLOSER_RE.test(group.payload[0]) &&
		group.payload[0] === fileLines[aboveEndIdx] &&
		shouldDropSingleStructuralBoundary(group.payload, group.payload.slice(1), ZERO_DELIMITER_BALANCE)
	) {
		absorbedLeading = 1;
	}

	let absorbedTrailing = 0;
	const remainingPayload = group.payload.slice(absorbedLeading);
	const remaining = remainingPayload.length;
	if (allowGenericBoundaryAbsorb) {
		const maxTrail = Math.min(remaining, fileLines.length - belowStartIdx);
		for (let count = maxTrail; count >= 2; count--) {
			let ok = true;
			for (let offset = 0; offset < count; offset++) {
				if (group.payload[group.payload.length - count + offset] !== fileLines[belowStartIdx + offset]) {
					ok = false;
					break;
				}
			}
			if (ok) {
				absorbedTrailing = count;
				break;
			}
		}
	}
	if (
		absorbedTrailing === 0 &&
		group.cursor.kind === "before_anchor" &&
		allowGenericBoundaryAbsorb &&
		remaining > 0 &&
		belowStartIdx < fileLines.length &&
		!STRUCTURAL_CLOSER_RE.test(remainingPayload[remainingPayload.length - 1]) &&
		remainingPayload[remainingPayload.length - 1] === fileLines[belowStartIdx]
	) {
		absorbedTrailing = 1;
	}
	if (
		absorbedTrailing === 0 &&
		remaining > 0 &&
		belowStartIdx < fileLines.length &&
		STRUCTURAL_CLOSER_RE.test(remainingPayload[remainingPayload.length - 1]) &&
		remainingPayload[remainingPayload.length - 1] === fileLines[belowStartIdx] &&
		shouldDropSingleStructuralBoundary(remainingPayload, remainingPayload.slice(0, -1), ZERO_DELIMITER_BALANCE)
	) {
		absorbedTrailing = 1;
	}

	if (absorbedLeading === 0 && absorbedTrailing === 0) return empty;
	return {
		keptPayload: group.payload.slice(absorbedLeading, group.payload.length - absorbedTrailing),
		absorbedLeading,
		absorbedTrailing,
		leadingFileRange:
			absorbedLeading > 0 ? { start: aboveEndIdx - absorbedLeading + 2, end: aboveEndIdx + 1 } : undefined,
		trailingFileRange:
			absorbedTrailing > 0 ? { start: belowStartIdx + 1, end: belowStartIdx + absorbedTrailing } : undefined,
	};
}

function normalizePureInsertBoundaries(
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
	warnings: string[],
	options: ApplyOptions,
): AppliedEdit[] {
	const out: AppliedEdit[] = [];
	let nextSyntheticIndex = edits.length;
	for (let index = 0; index < edits.length; index++) {
		const group = findPureInsertGroup(edits, index);
		if (!group) {
			out.push(edits[index]);
			continue;
		}

		const result = tryAbsorbPureInsertGroup(group, fileLines, options.autoDropPureInsertDuplicates === true);
		if (result.absorbedLeading === 0 && result.absorbedTrailing === 0) {
			for (let groupIndex = group.startIndex; groupIndex <= group.endIndex; groupIndex++)
				out.push(edits[groupIndex]);
			index = group.endIndex;
			continue;
		}

		if (result.leadingFileRange) {
			const { start, end } = result.leadingFileRange;
			warnings.push(
				`Auto-dropped ${result.absorbedLeading} duplicate line(s) at the start of insert at line ${group.lineNum} ` +
					`(file lines ${start}..${end} already match the payload's leading lines).`,
			);
		}
		if (result.trailingFileRange) {
			const { start, end } = result.trailingFileRange;
			warnings.push(
				`Auto-dropped ${result.absorbedTrailing} duplicate line(s) at the end of insert at line ${group.lineNum} ` +
					`(file lines ${start}..${end} already match the payload's trailing lines).`,
			);
		}
		for (const text of result.keptPayload) {
			out.push({
				kind: "insert",
				cursor: cloneCursor(group.cursor),
				text,
				lineNum: group.lineNum,
				index: nextSyntheticIndex++,
			});
		}
		index = group.endIndex;
	}
	return out;
}

/**
 * Normalize replacement groups so common off-by-one boundaries do not duplicate
 * unchanged surrounding lines or structural closers. Returns the repaired edit
 * list plus one warning per repaired group.
 */
function repairReplacementBoundaries(
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
): {
	edits: AppliedEdit[];
	warnings: string[];
} {
	const out: AppliedEdit[] = [];
	const warnings: string[] = [];
	let i = 0;
	while (i < edits.length) {
		const group = findReplacementGroup(edits, i);
		if (!group) {
			out.push(edits[i]);
			i++;
			continue;
		}
		const inserts = group.insertIndices.map((idx) => edits[idx]);
		const deletes = group.deleteIndices.map((idx) => edits[idx]);
		i = group.deleteIndices[group.deleteIndices.length - 1] + 1;

		const boundaryEcho = findBoundaryEcho(group, fileLines);
		if (boundaryEcho) {
			warnings.push(describeBoundaryEchoRepair(group, boundaryEcho));
			out.push(...inserts.slice(boundaryEcho.leading, inserts.length - boundaryEcho.trailing), ...deletes);
			continue;
		}

		const delta = balanceDelta(
			computeDelimiterBalance(group.payload),
			computeDelimiterBalance(fileLines.slice(group.startLine - 1, group.endLine)),
		);
		if (balanceIsZero(delta)) {
			out.push(...inserts, ...deletes);
			continue;
		}

		const dupSuffix = findDuplicateSuffix(group, fileLines, delta);
		if (dupSuffix > 0) {
			warnings.push(
				describeBoundaryRepair(
					group,
					`dropped ${dupSuffix} duplicated trailing payload line(s) already present below the range`,
				),
			);
			out.push(...inserts.slice(0, inserts.length - dupSuffix), ...deletes);
			continue;
		}
		const dupPrefix = findDuplicatePrefix(group, fileLines, delta);
		if (dupPrefix > 0) {
			warnings.push(
				describeBoundaryRepair(
					group,
					`dropped ${dupPrefix} duplicated leading payload line(s) already present above the range`,
				),
			);
			out.push(...inserts.slice(dupPrefix), ...deletes);
			continue;
		}
		const droppedClosers = findDroppedSuffixClosers(group, fileLines, delta);
		if (droppedClosers > 0) {
			warnings.push(
				describeBoundaryRepair(
					group,
					`kept ${droppedClosers} structural closing line(s) the range deleted without restating`,
				),
			);
			out.push(...inserts, ...deletes.slice(0, deletes.length - droppedClosers));
			continue;
		}
		out.push(...inserts, ...deletes);
	}
	return { edits: out, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════
// After-insert landing correction

/** Leading run of tabs and spaces. */
function leadingIndent(line: string): string {
	let end = 0;
	while (end < line.length) {
		const code = line.charCodeAt(end);
		if (code !== 9 && code !== 32) break;
		end++;
	}
	return line.slice(0, end);
}

/** `deeper` strictly extends `shallower` (same indent style, more depth). */
function isIndentDeeper(deeper: string, shallower: string): boolean {
	return deeper.length > shallower.length && deeper.startsWith(shallower);
}

interface AfterInsertGroup {
	/** Anchor line shared by every insert row of the hunk. */
	anchor: number;
	/** Indices into the edit list, in patch order. */
	members: number[];
	/** First line of the resolved block when lowered from `insert after block N:`. */
	blockStart?: number;
}

/**
 * Depth of an after-insert hunk's body: the shallowest indentation across its
 * non-blank rows. Returns `undefined` when no depth claim can be made — an
 * all-blank or all-closer body, or rows whose indentation styles are not
 * mutually comparable (tabs vs spaces).
 */
function bodyTargetIndent(rows: readonly string[]): string | undefined {
	const nonBlank = rows.filter(hasNonWhitespace);
	if (nonBlank.length === 0) return undefined;
	if (nonBlank.every((row) => STRUCTURAL_CLOSER_RE.test(row))) return undefined;
	let target = leadingIndent(nonBlank[0] ?? "");
	for (const row of nonBlank) {
		const indent = leadingIndent(row);
		if (indent.startsWith(target)) continue;
		if (target.startsWith(indent)) target = indent;
		else return undefined;
	}
	return target;
}

function resolveShiftedLanding(
	group: AfterInsertGroup,
	target: string,
	fileLines: readonly string[],
	targetedLines: ReadonlySet<number>,
): { line: number; crossed: number } | undefined {
	const anchorText = fileLines[group.anchor - 1];
	if (anchorText === undefined || !hasNonWhitespace(anchorText)) return undefined;
	if (!isIndentDeeper(leadingIndent(anchorText), target)) return undefined;

	let landing = group.anchor;
	let crossed = 0;
	for (let line = group.anchor + 1; line <= fileLines.length; line++) {
		const text = fileLines[line - 1] ?? "";
		if (!hasNonWhitespace(text)) continue;
		if (!STRUCTURAL_CLOSER_RE.test(text)) break;
		const indent = leadingIndent(text);
		if (!indent.startsWith(target)) break;
		if (targetedLines.has(line)) return undefined;
		landing = line;
		crossed++;
		if (indent.length === target.length) break;
	}
	return landing === group.anchor ? undefined : { line: landing, crossed };
}

function resolveInwardLanding(
	group: AfterInsertGroup,
	target: string,
	blockStart: number,
	fileLines: readonly string[],
	targetedLines: ReadonlySet<number>,
): number | undefined {
	const anchorText = fileLines[group.anchor - 1];
	if (anchorText === undefined || !hasNonWhitespace(anchorText)) return undefined;
	if (!STRUCTURAL_CLOSER_RE.test(anchorText)) return undefined;
	if (!isIndentDeeper(target, leadingIndent(anchorText))) return undefined;

	let landing = group.anchor;
	for (let line = group.anchor; line > blockStart; line--) {
		const text = fileLines[line - 1] ?? "";
		if (!hasNonWhitespace(text)) {
			landing = line - 1;
			continue;
		}
		if (!STRUCTURAL_CLOSER_RE.test(text)) break;
		const indent = leadingIndent(text);
		if (!isIndentDeeper(target, indent)) break;
		if (line !== group.anchor && targetedLines.has(line)) return undefined;
		landing = line - 1;
	}
	return landing === group.anchor ? undefined : landing;
}

function repairAfterInsertLandings(
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
): { edits: readonly AppliedEdit[]; warnings: string[] } {
	const groups = new Map<string, AfterInsertGroup>();
	edits.forEach((edit, idx) => {
		if (edit.kind !== "insert" || edit.mode === "replacement") return;
		if (edit.cursor.kind !== "after_anchor") return;
		const key = `${edit.cursor.anchor.line}:${edit.lineNum}`;
		const group = groups.get(key);
		if (group === undefined)
			groups.set(key, { anchor: edit.cursor.anchor.line, members: [idx], blockStart: edit.blockStart });
		else group.members.push(idx);
	});
	if (groups.size === 0) return { edits, warnings: [] };

	const targetedLines = new Set<number>();
	for (const edit of edits) {
		if (edit.kind === "delete") targetedLines.add(edit.anchor.line);
		else if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") {
			targetedLines.add(edit.cursor.anchor.line);
		}
	}

	let out: AppliedEdit[] | undefined;
	const warnings: string[] = [];
	const retarget = (group: AfterInsertGroup, line: number): void => {
		out ??= [...edits];
		for (const idx of group.members) {
			const edit = out[idx] as InsertEdit;
			out[idx] = { ...edit, cursor: { kind: "after_anchor", anchor: { line } } };
		}
	};
	for (const group of groups.values()) {
		const target = bodyTargetIndent(group.members.map((idx) => (edits[idx] as InsertEdit).text));
		if (target === undefined) continue;
		const outward = resolveShiftedLanding(group, target, fileLines, targetedLines);
		if (outward !== undefined) {
			retarget(group, outward.line);
			warnings.push(afterInsertLandingShiftWarning(group.anchor, outward.line, outward.crossed));
			continue;
		}
		if (group.blockStart === undefined) continue;
		const inward = resolveInwardLanding(group, target, group.blockStart, fileLines, targetedLines);
		if (inward === undefined) continue;
		retarget(group, inward);
		warnings.push(blockInsertLandingShiftWarning(group.blockStart, group.anchor, inward));
	}
	return { edits: out ?? edits, warnings };
}

/**
 * Apply a parsed list of edits to a text body. Pure function — no I/O.
 *
 * Returns the post-edit text and the first changed line number (1-indexed).
 * Throws if an anchor is out of bounds.
 */
export function applyEdits(text: string, edits: readonly Edit[], options: ApplyOptions = {}): ApplyResult {
	if (edits.length === 0) return { text, firstChangedLine: undefined };

	// Block edits are deferred until `resolveBlockEdits` expands them into
	// concrete inserts + deletes. Reaching the applier with one still present
	// is an internal wiring bug, not authored-input error.
	for (const edit of edits) {
		if (edit.kind === "block") throw new Error(UNRESOLVED_BLOCK_INTERNAL);
	}
	const appliedEdits = edits as readonly AppliedEdit[];

	const fileLines = text.split("\n");
	const lineOrigins: LineOrigin[] = fileLines.map(() => "original");

	let firstChangedLine: number | undefined;
	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	const targetEdits = dropTrailingPhantomDeletes(
		appliedEdits.map((edit, index) => cloneAppliedEdit(edit, index)),
		fileLines,
	);
	validateLineBounds(targetEdits, fileLines);
	const { edits: replacementRepaired, warnings } = repairReplacementBoundaries(targetEdits, fileLines);
	const pureInsertRepaired = normalizePureInsertBoundaries(replacementRepaired, fileLines, warnings, options);
	const { edits: repaired, warnings: landingWarnings } = repairAfterInsertLandings(pureInsertRepaired, fileLines);
	warnings.push(...landingWarnings);

	// Partition edits into BOF, EOF, and anchor-targeted buckets.
	const bofLines: string[] = [];
	const eofLines: string[] = [];
	const anchorEdits: IndexedEdit[] = [];
	repaired.forEach((edit, idx) => {
		if (edit.kind === "insert" && edit.cursor.kind === "bof") {
			bofLines.push(edit.text);
		} else if (edit.kind === "insert" && edit.cursor.kind === "eof") {
			eofLines.push(edit.text);
		} else {
			anchorEdits.push({ edit, idx });
		}
	});

	// Apply per-line buckets bottom-up so earlier indices stay valid.
	const byLine = bucketAnchorEditsByLine(anchorEdits);
	for (const line of [...byLine.keys()].sort((a, b) => b - a)) {
		const bucket = byLine.get(line);
		if (!bucket) continue;
		bucket.sort((a, b) => a.idx - b.idx);

		const idx = line - 1;
		const currentLine = fileLines[idx] ?? "";
		const beforeLines: string[] = [];
		const afterLines: string[] = [];
		const replacementLines: string[] = [];
		let deleteLine = false;

		for (const { edit } of bucket) {
			if (isReplacementInsert(edit)) {
				replacementLines.push(edit.text);
			} else if (edit.kind === "insert" && edit.cursor.kind === "after_anchor") {
				afterLines.push(edit.text);
			} else if (edit.kind === "insert") {
				beforeLines.push(edit.text);
			} else if (edit.kind === "delete") {
				deleteLine = true;
			}
		}
		if (beforeLines.length === 0 && afterLines.length === 0 && replacementLines.length === 0 && !deleteLine) continue;

		const replacement = deleteLine
			? [...beforeLines, ...replacementLines, ...afterLines]
			: [...beforeLines, ...replacementLines, currentLine, ...afterLines];
		const origins: LineOrigin[] = [];
		for (let i = 0; i < beforeLines.length; i++) origins.push("insert");
		for (let i = 0; i < replacementLines.length; i++) origins.push(deleteLine ? "replacement" : "insert");
		if (!deleteLine) origins.push(lineOrigins[idx] ?? "original");
		for (let i = 0; i < afterLines.length; i++) origins.push("insert");

		fileLines.splice(idx, 1, ...replacement);
		lineOrigins.splice(idx, 1, ...origins);
		trackFirstChanged(line);
	}

	if (bofLines.length > 0) {
		insertAtStart(fileLines, lineOrigins, bofLines);
		trackFirstChanged(1);
	}
	const eofChangedLine = insertAtEnd(fileLines, lineOrigins, eofLines);
	if (eofChangedLine !== undefined) trackFirstChanged(eofChangedLine);

	return {
		text: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}
