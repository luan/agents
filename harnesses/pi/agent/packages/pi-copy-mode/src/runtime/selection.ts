import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type {
	NativeSelectionCompleted,
	SelectionPoint,
	SelectionQuoteAnchor,
	SelectionShape,
} from "@luan.sh/pi-libtui/selection";
import { columnBounds, graphemeEnd, type CursorPoint } from "../core/cursor.ts";
import type { FullscreenSurface } from "./fullscreen-surface.ts";

export interface CopySelectionState {
	kind: "cursor" | "character" | "line" | "column";
	anchor: CursorPoint;
	cursor: CursorPoint;
}

type CopySelectionPayload = NativeSelectionCompleted & {
	text: string;
	shape: SelectionShape;
	screenAnchor: SelectionPoint;
	source: { quote: SelectionQuoteAnchor; offsets?: { start: number; end: number } };
};

interface SelectionRange {
	start: CursorPoint;
	end: CursorPoint;
	text: string;
	// Native character ranges retain their inclusive logical endpoint.
	logicalEnd?: CursorPoint;
	sourceEnd?: CursorPoint;
}

function characterRange(surface: FullscreenSurface, state: CopySelectionState): SelectionRange {
	const anchor = surface.selectionAnchor ?? surface.point(state.anchor);
	const focus = surface.selectionFocus ?? surface.point(state.cursor);
	const anchorFirst = anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col);
	const first = anchorFirst ? anchor : focus;
	const last = anchorFirst ? focus : anchor;
	const start = { row: first.row, col: first.col };
	const end = { row: last.row, col: last.boundary === true ? last.col : graphemeEnd(last, surface) };
	const rows = Array.from({ length: end.row - start.row + 1 }, (_, index) => {
		const row = start.row + index;
		const from = row === start.row ? start.col : 0;
		const to = row === end.row ? end.col : surface.lineWidth(row);
		return stripTerminalSequences(sliceByColumn(surface.line(row), from, Math.max(0, to - from), true));
	});
	const text = rows.map((row) => row.trimEnd()).join("\n");
	if (state.kind === "cursor") {
		const cursorEnd = { row: state.cursor.row, col: graphemeEnd(state.cursor, surface) };
		return { start: { ...state.cursor }, end: cursorEnd, text, sourceEnd: cursorEnd };
	}
	return {
		start,
		end,
		text,
		logicalEnd: { row: last.row, col: last.col },
		...(rows.join("\n") === text ? { sourceEnd: end } : {}),
	};
}

function selectionRange(surface: FullscreenSurface, state: CopySelectionState): SelectionRange {
	if (state.kind === "column") {
		const bounds = columnBounds(state.anchor, state.cursor, surface);
		const width = bounds.right - bounds.left;
		const text = Array.from({ length: bounds.bottom - bounds.top + 1 }, (_, index) => {
			const selected = stripTerminalSequences(
				sliceByColumn(surface.line(bounds.top + index), bounds.left, width, true),
			);
			return selected + " ".repeat(Math.max(0, width - visibleWidth(selected)));
		}).join("\n");
		return { start: { row: bounds.top, col: bounds.left }, end: { row: bounds.bottom, col: bounds.right }, text };
	}
	if (state.kind === "line") {
		const top = Math.min(state.anchor.row, state.cursor.row);
		const bottom = Math.max(state.anchor.row, state.cursor.row);
		const text = `${Array.from({ length: bottom - top + 1 }, (_, index) => stripTerminalSequences(surface.line(top + index))).join("\n")}\n`;
		return {
			start: { row: top, col: 0 },
			end: { row: bottom, col: surface.lineGlyphWidth(bottom) },
			text,
			...(bottom + 1 < surface.lineCount ? { sourceEnd: { row: bottom + 1, col: 0 } } : {}),
		};
	}
	return characterRange(surface, state);
}

function sourceOffset(surface: FullscreenSurface, point: CursorPoint): number {
	let offset = 0;
	for (let row = 0; row < point.row; row += 1) offset += stripTerminalSequences(surface.line(row)).length + 1;
	return offset + stripTerminalSequences(sliceByColumn(surface.line(point.row), 0, point.col, true)).length;
}

function sourceQuote(surface: FullscreenSurface, offset: number, exact: string): SelectionQuoteAnchor {
	const context = 80;
	const source = Array.from({ length: surface.lineCount }, (_, row) => stripTerminalSequences(surface.line(row))).join(
		"\n",
	);
	if (source.slice(offset, offset + exact.length) !== exact) return { exact };
	return {
		exact,
		...(offset > 0 ? { prefix: source.slice(Math.max(0, offset - context), offset) } : {}),
		...(offset + exact.length < source.length
			? { suffix: source.slice(offset + exact.length, offset + exact.length + context) }
			: {}),
	};
}

export function copySelectionText(surface: FullscreenSurface, state: CopySelectionState): string {
	return selectionRange(surface, state).text;
}

export function copySelectionPayload(surface: FullscreenSurface, state: CopySelectionState): CopySelectionPayload {
	const range = selectionRange(surface, state);
	const screenEnd = surface.screenPoint(range.end);
	const startOffset = state.kind === "column" ? 0 : sourceOffset(surface, range.start);
	return {
		text: range.text,
		shape: state.kind === "cursor" ? "character" : state.kind,
		screenAnchor: screenEnd,
		logical: { start: range.start, end: range.logicalEnd ?? range.end },
		screen: { start: surface.screenPoint(range.start), end: screenEnd },
		source: {
			quote: state.kind === "column" ? { exact: range.text } : sourceQuote(surface, startOffset, range.text),
			...(range.sourceEnd ? { offsets: { start: startOffset, end: sourceOffset(surface, range.sourceEnd) } } : {}),
		},
	};
}
