import { lineHashAt } from "./line-hash";
import type { Anchor, Edit } from "./types";

// A matching tag proves which version, never where the numbers came from: 13 of 15 corrupting trials had a fresh tag.
// Rejected, never relocated. Hashless and contentless anchors keep current behavior.
function anchorsForEdit(edit: Edit): Anchor[] {
	if (edit.kind === "delete" || edit.kind === "block") return [edit.anchor];
	if (edit.kind === "cut") return []; // The parser emits matching delete anchors for every cut line.
	if (edit.kind === "paste") {
		if (edit.at.kind === "span") return [edit.at.range.start, edit.at.range.end];
		const cursor = edit.at.cursor;
		return cursor.kind === "before_anchor" || cursor.kind === "after_anchor" ? [cursor.anchor] : [];
	}
	const cursor = edit.cursor;
	return cursor.kind === "before_anchor" || cursor.kind === "after_anchor" ? [cursor.anchor] : [];
}

/** Count lines whose trimmed text equals `needle`, stopping at 2: only "exactly one" changes the decision. */
function trimmedOccurrences(lines: readonly string[], needle: string): number {
	let count = 0;
	for (const candidate of lines) {
		if (candidate.trim() !== needle) continue;
		if (++count > 1) return count;
	}
	return count;
}

/**
 * Decide a content-anchor mismatch. Returns the refusal, or `null` to accept.
 *
 * Accepts exactly one shape: the anchor equals line N after trimming and no other line in the file
 * trims to that text. The exact check exists to stop a stale number landing on a look-alike line —
 * the 23.6% silent-wrong rate, 52 of 220 trials. With one candidate in the whole file there is no
 * look-alike to land on, so the content still pins the number as strongly as a byte match would.
 * A `}` or a bare `});` fails uniqueness on the first duplicate and is refused as before.
 */
function contentMismatchMessage(
	lines: readonly string[],
	line: number,
	content: string,
	actualContent: string,
): string | null {
	const trimmed = content.trim();
	if (trimmed.length > 0 && actualContent.trim() === trimmed) {
		const occurrences = trimmedOccurrences(lines, trimmed);
		if (occurrences === 1) return null;
		return `Anchor ${line} differs from line ${line} only by leading whitespace, but ${occurrences} lines in this file carry that same text at different indentation, so the indentation is the only thing that says which one you meant. Expected ${JSON.stringify(content)}, found ${JSON.stringify(actualContent)}. The file did not change, so re-reading will not help: re-anchor with the leading whitespace copied exactly from the row you read, or add that row's #hash. The edit was not applied and nothing was relocated.`;
	}
	return `Anchor ${line} expected ${JSON.stringify(content)}, but found ${JSON.stringify(actualContent)}. The file changed since you read that line; re-read and re-anchor. The edit was not applied and nothing was relocated.`;
}

export function anchorHashMismatch(text: string, edits: readonly Edit[]): string | null {
	const lines = text.split("\n");
	const seen = edits
		.flatMap(anchorsForEdit)
		.filter((anchor) => anchor.hash !== undefined || anchor.content !== undefined);
	for (const anchor of seen) {
		const { line, hash, content } = anchor;
		if (line > lines.length) {
			if (content !== undefined) {
				return `Anchor ${line} expected ${JSON.stringify(content)}, but line ${line} does not exist (file has ${lines.length} lines). Re-read the file and use the line numbers and content from that read.`;
			}
			return `Anchor ${line}#${hash} does not exist (file has ${lines.length} lines). Re-read the file and use the line numbers and hashes from that read.`;
		}
		const actualContent = lines[line - 1] ?? "";
		if (content !== undefined && actualContent !== content) {
			const message = contentMismatchMessage(lines, line, content, actualContent);
			if (message !== null) return message;
		}
		if (hash !== undefined) {
			const actualHash = lineHashAt(lines, line);
			if (actualHash !== hash) {
				return `Anchor ${line}#${hash} no longer matches line ${line}, which now hashes to ${actualHash} (content: ${JSON.stringify(actualContent)}). The file changed since you read those numbers; re-read and re-anchor. The edit was not applied and nothing was relocated.`;
			}
		}
	}
	return null;
}

/** Supply rate: hashed anchors over total, the gate to making hashes mandatory. */
export function anchorHashCoverage(edits: readonly Edit[]): { hashed: number; total: number } {
	let hashed = 0;
	let total = 0;
	for (const anchor of edits.flatMap(anchorsForEdit)) {
		total++;
		if (anchor.hash) hashed++;
	}
	return { hashed, total };
}
