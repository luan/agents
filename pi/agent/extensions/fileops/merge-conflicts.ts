/**
 * Unresolved merge-conflict regions in a file.
 *
 * "Where are the conflict markers" is the most repeated search in the recorded
 * corpus, and it is a search that never should have been one: the answer is a
 * fixed grammar at fixed line numbers, and `search` pays for it by returning
 * the surrounding code too. `read path:conflicts` answers it in one call with
 * the marker lines and the exact ranges to re-read.
 */

const OURS_MARKER = /^<{7}(?: |$)/;
const BASE_MARKER = /^\|{7}(?: |$)/;
const SPLIT_MARKER = /^={7}$/;
const THEIRS_MARKER = /^>{7}(?: |$)/;

export interface ConflictRegion {
	/** 1-based line of the `<<<<<<<` marker. */
	startLine: number;
	/** 1-based line of the `>>>>>>>` marker. */
	endLine: number;
	/** Inclusive body range on our side, empty when the side has no lines. */
	ours?: { startLine: number; endLine: number };
	/** Inclusive body range of the merge base, present only in diff3 output. */
	base?: { startLine: number; endLine: number };
	/** Inclusive body range on their side. */
	theirs?: { startLine: number; endLine: number };
	/** Every marker line of the region, in order, for display. */
	markerLines: number[];
}

function bodyRange(startLine: number, endLine: number): { startLine: number; endLine: number } | undefined {
	return endLine >= startLine ? { startLine, endLine } : undefined;
}

/**
 * Scan `lines` for conflict regions.
 *
 * A region is only reported once it closes: an unterminated `<<<<<<<` is a file
 * that contains the literal marker text, not a conflict, and reporting it would
 * make the tool lie about a clean file.
 */
export function findConflictRegions(lines: readonly string[]): ConflictRegion[] {
	const regions: ConflictRegion[] = [];
	let start: number | undefined;
	let baseLine: number | undefined;
	let splitLine: number | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const lineNumber = index + 1;
		if (OURS_MARKER.test(line)) {
			start = lineNumber;
			baseLine = undefined;
			splitLine = undefined;
			continue;
		}
		if (start === undefined) continue;
		if (BASE_MARKER.test(line)) {
			baseLine = lineNumber;
			continue;
		}
		if (SPLIT_MARKER.test(line)) {
			splitLine = lineNumber;
			continue;
		}
		if (!THEIRS_MARKER.test(line) || splitLine === undefined) continue;
		const oursEnd = (baseLine ?? splitLine) - 1;
		regions.push({
			startLine: start,
			endLine: lineNumber,
			ours: bodyRange(start + 1, oursEnd),
			base: baseLine === undefined ? undefined : bodyRange(baseLine + 1, splitLine - 1),
			theirs: bodyRange(splitLine + 1, lineNumber - 1),
			markerLines: [start, ...(baseLine === undefined ? [] : [baseLine]), splitLine, lineNumber],
		});
		start = undefined;
		baseLine = undefined;
		splitLine = undefined;
	}
	return regions;
}

function describeSide(label: string, side: { startLine: number; endLine: number } | undefined): string {
	return side ? `${label} ${side.startLine}-${side.endLine}` : `${label} empty`;
}

/** One index line per region: where it is, and how to re-read each side. */
export function formatConflictIndex(regions: readonly ConflictRegion[]): string[] {
	return regions.map((region, index) => {
		const sides = [describeSide("ours", region.ours)];
		if (region.base) sides.push(describeSide("base", region.base));
		sides.push(describeSide("theirs", region.theirs));
		return `#${index + 1} ${region.startLine}-${region.endLine} · ${sides.join(" · ")}`;
	});
}
