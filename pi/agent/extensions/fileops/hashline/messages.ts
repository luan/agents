/**
 * Centralized error and warning text emitted by the hashline parser, applier,
 * and patcher. Consolidating these as named constants makes them easy to
 * audit and keeps wording stable across the rendering paths that surface
 * them.
 */

import { formatNumberedLine, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "./format";

/** Lines of context shown either side of a hash mismatch. */
export const MISMATCH_CONTEXT = 2;

/**
 * Numbered `LINE:TEXT` rows around `anchorLines` (±{@link MISMATCH_CONTEXT}),
 * `*`-marking anchors, `...` between non-adjacent runs. Out-of-range anchors
 * contribute no rows.
 */
export function formatAnchoredContext(anchorLines: readonly number[], fileLines: readonly string[]): string[] {
	const displayLines = new Set<number>();
	for (const line of anchorLines) {
		if (line < 1 || line > fileLines.length) continue;
		const lo = Math.max(1, line - MISMATCH_CONTEXT);
		const hi = Math.min(fileLines.length, line + MISMATCH_CONTEXT);
		for (let lineNum = lo; lineNum <= hi; lineNum++) displayLines.add(lineNum);
	}
	const anchorSet = new Set(anchorLines);
	const rows: string[] = [];
	let previous = -1;
	for (const lineNum of [...displayLines].sort((a, b) => a - b)) {
		if (previous !== -1 && lineNum > previous + 1) rows.push("...");
		previous = lineNum;
		const marker = anchorSet.has(lineNum) ? "*" : " ";
		rows.push(`${marker}${formatNumberedLine(lineNum, fileLines[lineNum - 1] ?? "")}`);
	}
	return rows;
}

/** Optional patch envelope start marker; silently consumed when present. */
export const BEGIN_PATCH_MARKER = "*** Begin Patch";

/** Optional patch envelope end marker; terminates parsing when encountered. */
export const END_PATCH_MARKER = "*** End Patch";

/**
 * Recovery sentinel emitted by an agent loop when a contaminated tool-call
 * stream is truncated mid-call. Behaves like {@link END_PATCH_MARKER} for
 * parsing — terminates the line loop — and does not surface a warning.
 */
export const ABORT_MARKER = "*** Abort";

/** Warning text appended when bare body rows are auto-converted to literal rows. */
export const BARE_BODY_AUTO_PIPED_WARNING =
	"Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines; pasting raw code as payload is not a portable shape.";

/** Error text emitted when a hunk body contains a unified-diff-style `-` row. */
export const MINUS_ROW_REJECTED =
	"`-` rows are not valid; hashline ranges already name the lines being changed. To insert a literal line starting with `-`, write `+-…`.";

/** Error text emitted when a `replace block N:` hunk has no body. */
export const EMPTY_BLOCK =
	"`replace block N:` needs at least one `+TEXT` body row. To delete a block, use `delete block N`.";

/**
 * Block-anchored replace/delete could not resolve to a syntactic block
 * (unsupported language, blank/out-of-range line, no node beginning on N, or
 * parse error). Appends a {@link formatAnchoredContext} preview when
 * `fileLines` is given. `insert after block N:` never reaches this — it is
 * lowered to plain `insert after N:` instead (see
 * {@link insertAfterBlockUnresolvedLoweredWarning}).
 */
export function blockUnresolvedMessage(
	line: number,
	op: "replace" | "delete" = "replace",
	fileLines?: readonly string[],
): string {
	const phrase = op === "delete" ? `delete block ${line}` : `replace block ${line}:`;
	const fallback = op === "delete" ? `delete ${line}..M` : `replace ${line}..M:`;
	let message =
		`\`${phrase}\` could not resolve a syntactic block beginning on line ${line} ` +
		`(unsupported language, blank/closer line, or parse error). Use \`${fallback}\` with explicit lines.`;
	if (fileLines) {
		const context = formatAnchoredContext([line], fileLines);
		if (context.length > 0) message += `\n\n${context.join("\n")}`;
	}
	return message;
}

/** Block-anchored edit reached a path with no {@link BlockResolver} wired in — a host-configuration bug. */
export const BLOCK_RESOLVER_UNAVAILABLE =
	"`replace block`/`delete block`/`insert after block` are not available here (no block resolver configured). Use a concrete line range.";

/**
 * `insert after block N:` anchored on a closing-delimiter line, lowered to
 * plain `insert after N:` — the closer ends a block, and inserting after it
 * is exactly what the plain form does.
 */
export function insertAfterBlockCloserLoweredWarning(line: number): string {
	return `\`insert after block ${line}:\` anchors on a closing delimiter, so it was applied as plain \`insert after ${line}:\`. Anchor on the line that OPENS the construct.`;
}

/**
 * `insert after block N:` anchor unresolvable (unsupported language, blank
 * line, parse error, or no resolver), lowered to plain `insert after N:` —
 * applying with a warning beats failing the patch.
 */
export function insertAfterBlockUnresolvedLoweredWarning(line: number): string {
	return `\`insert after block ${line}:\` could not resolve a syntactic block on line ${line}, so it was applied as plain \`insert after ${line}:\`. Verify the landing line; anchor on a line that OPENS a construct.`;
}

/**
 * Internal invariant error: `applyEdits` received an unresolved `replace block
 * N:` edit. Block edits must be expanded by `resolveBlockEdits` before reaching
 * the applier; hitting this is a wiring bug, not authored-input error.
 */
export const UNRESOLVED_BLOCK_INTERNAL =
	"internal error: unresolved `replace block` edit reached the applier (resolveBlockEdits was not run).";

/** Error text emitted when a delete hunk receives a body row. */
export const DELETE_TAKES_NO_BODY = "`delete N..M` does not take body rows. Remove the body, or use `replace N..M:`.";

/** Error text emitted when a `delete block N` hunk receives a body row. */
export const DELETE_BLOCK_TAKES_NO_BODY =
	"`delete block N` does not take body rows. Remove the body, or use `replace block N:` to replace the block.";

/** Error text emitted when an insert hunk has no body. */
export const EMPTY_INSERT = "`insert` needs at least one `+TEXT` body row.";

/**
 * `insert after` body indented shallower than the anchor: the landing slid
 * forward past trailing closer lines — the common "anchored on the last line
 * I read instead of after the block" mistake.
 */
export function afterInsertLandingShiftWarning(anchorLine: number, landingLine: number, crossed: number): string {
	return `insert after ${anchorLine}: body indented shallower than the anchor, so the landing moved past ${crossed} closing line${crossed === 1 ? "" : "s"} to after line ${landingLine}. For the deeper position inside the block, re-issue with the body indented to match.`;
}

/**
 * `insert after block N:` body indented deeper than the block's closer: the
 * landing was pulled inside the block — a deeper body almost always means
 * "append inside the block's body".
 */
export function blockInsertLandingShiftWarning(blockStart: number, closerLine: number, landingLine: number): string {
	return `insert after block ${blockStart}: body indented deeper than closing line ${closerLine}, so it was placed inside the block, after line ${landingLine}. \`insert after block\` lands AFTER the block at sibling depth — if inside was intended, use plain \`insert after ${closerLine}:\`.`;
}

/** Warning text emitted by `Recovery` when an external write fits a cached snapshot. */
export const RECOVERY_EXTERNAL_WARNING =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";

/** Warning text emitted by `Recovery` when a prior in-session edit advanced the hash. */
export const RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (the file hash advanced after a prior edit in this session).";

/**
 * Warning text emitted by `Recovery` when the session-chain replay
 * fast-path was taken. Distinct from {@link RECOVERY_SESSION_CHAIN_WARNING}
 * because replay is the less-certain mode: the structured-patch 3-way
 * merge refused, the anchor-content gate passed, but a coincidental
 * insert+delete pair earlier in the chain could still leave an anchor's
 * line number pointing at a duplicated row. Surface the hedge so the
 * model verifies before continuing.
 */
export const RECOVERY_SESSION_REPLAY_WARNING =
	"Recovered by replaying your edits onto the current file content — your previous edit in this session changed line(s) you re-targeted with a stale hash. Verify the diff matches your intent before continuing.";

/**
 * Warning emitted when an `insert head:` / `insert tail:` edit is applied to an
 * existing file whose snapshot tag is stale (the file drifted since the read).
 * Head/tail insert position is content-independent — "start"/"end" cannot move
 * with drift — so this is non-fatal: the edit applies onto the live content and
 * we surface the drift instead of hard-failing (unlike an anchored mismatch).
 */
export const HEADTAIL_DRIFT_WARNING =
	"Applied an `insert head:`/`insert tail:` edit onto the current file content even though the snapshot tag was stale (the file changed since your read). Head/tail position is content-independent, so the insert was not rejected — but re-read if the drift was unexpected.";

/**
 * Error text emitted when a hashline section omits the mandatory snapshot tag.
 * The tag is REQUIRED on every section; {@link Patcher.prepare} enforces it
 * before any read-side work runs.
 */
export function missingSnapshotTagMessage(sectionPath: string): string {
	return `Missing hashline snapshot tag for edit to ${sectionPath}; use \`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}\` from your latest read/search output. To create a new file, use the write tool.`;
}
