import { visibleWidth } from "@earendil-works/pi-tui";
import type { CursorPoint } from "./cursor.ts";

export type WordMotionClass = "word" | "WORD";
export type CharMotion = "f" | "F" | "t" | "T";
export interface LastCharMotion {
	motion: CharMotion;
	char: string;
}
export interface LazyTextDocument {
	lineCount: number;
	line(row: number): string;
}

type GraphemeClass = "space" | "word" | "other";
interface Grapheme {
	text: string;
	col: number;
	endCol: number;
	class: GraphemeClass;
}
interface CachedLine {
	source: string;
	graphemes: readonly Grapheme[];
}

// Ported from main's vim motions and word-boundary cache, with display columns and lazy rows.
export class VimMotionCache {
	private readonly lines = new Map<number, CachedLine>();
	private readonly segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	private computations = 0;

	constructor(private readonly maxEntries = 256) {}

	get entryCount(): number {
		return this.lines.size;
	}
	get computationCount(): number {
		return this.computations;
	}

	graphemes(document: LazyTextDocument, row: number): readonly Grapheme[] {
		const source = document.line(row);
		const cached = this.lines.get(row);
		if (cached?.source === source) {
			this.lines.delete(row);
			this.lines.set(row, cached);
			return cached.graphemes;
		}
		let col = 0;
		const graphemes = [...this.segmenter.segment(source)].map(({ segment }) => {
			const width = visibleWidth(segment);
			const result: Grapheme = {
				text: segment,
				col,
				endCol: col + width,
				class: /^\s+$/u.test(segment) ? "space" : /^[\p{L}\p{N}_]+$/u.test(segment) ? "word" : "other",
			};
			col += width;
			return result;
		});
		this.computations += 1;
		this.lines.delete(row);
		if (this.lines.size >= Math.max(1, this.maxEntries)) {
			const oldest = this.lines.keys().next().value;
			if (oldest !== undefined) this.lines.delete(oldest);
		}
		this.lines.set(row, { source, graphemes });
		return graphemes;
	}
}

function semanticClass(grapheme: Grapheme, kind: WordMotionClass): GraphemeClass {
	return kind === "WORD" && grapheme.class !== "space" ? "word" : grapheme.class;
}

function indexAt(graphemes: readonly Grapheme[], col: number): number {
	const index = graphemes.findIndex((grapheme) => col < grapheme.endCol);
	return index < 0 ? graphemes.length : index;
}

function firstNonspace(graphemes: readonly Grapheme[]): number {
	return graphemes.findIndex((grapheme) => grapheme.class !== "space");
}

function lastNonspace(graphemes: readonly Grapheme[]): number {
	for (let index = graphemes.length - 1; index >= 0; index -= 1) if (graphemes[index]?.class !== "space") return index;
	return -1;
}

function oneWordMotion(
	document: LazyTextDocument,
	cache: VimMotionCache,
	point: CursorPoint,
	direction: "forward" | "backward",
	target: "start" | "end",
	kind: WordMotionClass,
): CursorPoint {
	let row = point.row;
	let graphemes = cache.graphemes(document, row);
	let index = indexAt(graphemes, point.col);
	if (direction === "forward" && target === "start") {
		if (index < graphemes.length && graphemes[index]?.class !== "space") {
			const current = semanticClass(graphemes[index]!, kind);
			while (index < graphemes.length && semanticClass(graphemes[index]!, kind) === current) index += 1;
		}
		while (true) {
			while (index < graphemes.length && graphemes[index]?.class === "space") index += 1;
			if (index < graphemes.length) return { row, col: graphemes[index]!.col };
			if (row >= document.lineCount - 1) return { row, col: graphemes.at(-1)?.col ?? 0 };
			row += 1;
			graphemes = cache.graphemes(document, row);
			index = 0;
		}
	}
	if (direction === "forward") {
		index = Math.min(graphemes.length, index + 1);
		while (true) {
			while (index < graphemes.length && graphemes[index]?.class === "space") index += 1;
			if (index < graphemes.length) {
				const current = semanticClass(graphemes[index]!, kind);
				while (index + 1 < graphemes.length && semanticClass(graphemes[index + 1]!, kind) === current) index += 1;
				return { row, col: graphemes[index]!.col };
			}
			if (row >= document.lineCount - 1) return { row, col: graphemes.at(-1)?.col ?? 0 };
			row += 1;
			graphemes = cache.graphemes(document, row);
			index = 0;
		}
	}
	index = Math.min(graphemes.length - 1, index - 1);
	while (true) {
		while (index >= 0 && graphemes[index]?.class === "space") index -= 1;
		if (index >= 0) {
			const current = semanticClass(graphemes[index]!, kind);
			while (index > 0 && semanticClass(graphemes[index - 1]!, kind) === current) index -= 1;
			return { row, col: graphemes[index]!.col };
		}
		if (row <= 0) return { row: 0, col: 0 };
		row -= 1;
		graphemes = cache.graphemes(document, row);
		index = lastNonspace(graphemes);
	}
}

export function findWordMotionTarget(
	document: LazyTextDocument,
	cache: VimMotionCache,
	point: CursorPoint,
	direction: "forward" | "backward",
	target: "start" | "end",
	kind: WordMotionClass,
	count = 1,
): CursorPoint {
	let result = point;
	for (let index = 0; index < Math.max(1, count); index += 1)
		result = oneWordMotion(document, cache, result, direction, target, kind);
	return result;
}

export function reverseCharMotion(motion: CharMotion): CharMotion {
	return ({ f: "F", F: "f", t: "T", T: "t" } as const)[motion];
}

export function findCharMotionTarget(
	document: LazyTextDocument,
	cache: VimMotionCache,
	point: CursorPoint,
	motion: CharMotion,
	target: string,
	isRepeat = false,
	count = 1,
): CursorPoint | undefined {
	const graphemes = cache.graphemes(document, point.row);
	let current = indexAt(graphemes, point.col);
	const forward = motion === "f" || motion === "t";
	const till = motion === "t" || motion === "T";
	for (let step = 0; step < Math.max(1, count); step += 1) {
		const repeatOffset = step === 0 && till && isRepeat ? 1 : 0;
		let found = -1;
		if (forward) {
			for (let index = current + 1 + repeatOffset; index < graphemes.length; index += 1) {
				if (graphemes[index]?.text === target || graphemes[index]?.text.startsWith(target)) {
					found = index;
					break;
				}
			}
		} else {
			for (let index = current - 1 - repeatOffset; index >= 0; index -= 1) {
				if (graphemes[index]?.text === target || graphemes[index]?.text.startsWith(target)) {
					found = index;
					break;
				}
			}
		}
		if (found < 0) return undefined;
		current = found;
	}
	if (!till) return { row: point.row, col: graphemes[current]!.col };
	const targetIndex = forward ? current - 1 : current + 1;
	return targetIndex >= 0 && targetIndex < graphemes.length
		? { row: point.row, col: graphemes[targetIndex]!.col }
		: undefined;
}

function blank(line: string): boolean {
	return /^\s*$/u.test(line);
}
function paragraphStart(document: LazyTextDocument, row: number): boolean {
	return !blank(document.line(row)) && (row === 0 || blank(document.line(row - 1)));
}

export function findParagraphMotionTarget(
	document: LazyTextDocument,
	fromRow: number,
	direction: "forward" | "backward",
	count = 1,
): CursorPoint {
	let row = fromRow;
	for (let step = 0; step < Math.max(1, count); step += 1) {
		let candidate = row + (direction === "forward" ? 1 : -1);
		let found = row;
		while (candidate >= 0 && candidate < document.lineCount) {
			if (paragraphStart(document, candidate)) {
				found = candidate;
				break;
			}
			candidate += direction === "forward" ? 1 : -1;
		}
		if (found === row) found = direction === "forward" ? document.lineCount - 1 : 0;
		row = found;
	}
	return { row, col: 0 };
}

export function findFirstNonblank(document: LazyTextDocument, cache: VimMotionCache, row: number): number {
	const index = firstNonspace(cache.graphemes(document, row));
	return index < 0 ? 0 : cache.graphemes(document, row)[index]!.col;
}
