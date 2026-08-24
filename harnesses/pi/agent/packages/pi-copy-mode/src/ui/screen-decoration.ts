import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	CURSOR_MARKER,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { removeUnmarkedEditorCursor, renderSemanticCursor, stripCursorRoleMarkers, tuiTheme } from "pi-libtui";
import { graphemeEnd, type CursorDocument, type CursorPoint } from "../core/cursor.ts";
import type { FullscreenSurface } from "../runtime/fullscreen-surface.ts";

export type CopySelectionKind = "cursor" | "character" | "line" | "column";

export interface CopyScreenState {
	kind: CopySelectionKind;
	anchor: CursorPoint;
	cursor: CursorPoint;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const INVERSE = "\x1b[7m";
const RESET = "\x1b[0m";
const INVERSE_OFF = "\x1b[27m";

export function removeEditorCursor(line: string): string {
	const marker = line.indexOf(CURSOR_MARKER);
	if (marker < 0) return removeUnmarkedEditorCursor(line);
	const before = line.slice(0, marker);
	const afterMarker = line.slice(marker + CURSOR_MARKER.length);
	if (!afterMarker.startsWith(INVERSE)) return stripCursorRoleMarkers(removeUnmarkedEditorCursor(before + afterMarker));
	const reset = afterMarker.indexOf(RESET, INVERSE.length);
	const inverseOff = afterMarker.indexOf(INVERSE_OFF, INVERSE.length);
	const candidates = [reset, inverseOff].filter((index) => index >= 0);
	const close = candidates.length > 0 ? Math.min(...candidates) : -1;
	if (close < 0) return stripCursorRoleMarkers(removeUnmarkedEditorCursor(before + afterMarker));
	const wrapped = afterMarker.slice(INVERSE.length, close);
	const plain = stripTerminalSequences(wrapped);
	if ([...graphemes.segment(plain)].length !== 1)
		return stripCursorRoleMarkers(removeUnmarkedEditorCursor(before + afterMarker));
	const closeLength = afterMarker.startsWith(RESET, close) ? RESET.length : INVERSE_OFF.length;
	return stripCursorRoleMarkers(before + wrapped + afterMarker.slice(close + closeLength));
}

function document(surface: FullscreenSurface): CursorDocument {
	return {
		lineCount: surface.lineCount,
		lineWidth: (row) => surface.lineWidth(row),
		lineStops: (row) => surface.lineStops(row),
		viewportHeight: surface.viewportHeight,
	};
}

function columnBounds(
	surface: FullscreenSurface,
	state: CopyScreenState,
): { top: number; bottom: number; left: number; right: number } {
	return {
		top: Math.min(state.anchor.row, state.cursor.row),
		bottom: Math.max(state.anchor.row, state.cursor.row),
		left: Math.min(state.anchor.col, state.cursor.col),
		right: Math.max(
			state.anchor.col + 1,
			state.cursor.col + 1,
			graphemeEnd(state.anchor, document(surface)),
			graphemeEnd(state.cursor, document(surface)),
		),
	};
}

function highlightColumns(theme: Theme, line: string, start: number, width: number, totalWidth: number): string {
	const selected = stripTerminalSequences(sliceByColumn(line, start, width, true));
	const cells = selected + " ".repeat(Math.max(0, width - visibleWidth(selected)));
	const colors = tuiTheme(theme);
	return compositeTuiLine(
		line,
		colors.bg("surface.selected", colors.fg("text.primary", cells)),
		start,
		width,
		totalWidth,
	);
}

export function decorateCopyScreen(
	screen: readonly string[],
	surface: FullscreenSurface,
	state: CopyScreenState,
	theme: Theme,
): string[] {
	const result = screen.map(removeEditorCursor);
	const clip = surface.viewportRect;
	if (state.kind === "line" && clip.width > 0 && clip.height > 0) {
		const top = Math.max(Math.min(state.anchor.row, state.cursor.row), surface.scrollTop);
		const bottom = Math.min(
			Math.max(state.anchor.row, state.cursor.row),
			surface.scrollTop + surface.viewportHeight - 1,
		);
		for (let row = top; row <= bottom; row += 1) {
			const width = surface.lineGlyphWidth(row);
			if (width <= 0) continue;
			const point = surface.screenPoint({ row, col: 0 });
			if (point.row < clip.y || point.row >= clip.y + clip.height || point.row < 0 || point.row >= result.length)
				continue;
			const start = Math.max(clip.x, point.col);
			const end = Math.min(clip.x + clip.width, point.col + width);
			if (end <= start) continue;
			result[point.row] = highlightColumns(
				theme,
				result[point.row] ?? "",
				start,
				end - start,
				Math.max(clip.x + clip.width, visibleWidth(result[point.row] ?? "")),
			);
		}
	}
	if (state.kind === "column" && clip.width > 0 && clip.height > 0) {
		const bounds = columnBounds(surface, state);
		const visibleTop = Math.max(bounds.top, surface.scrollTop);
		const visibleBottom = Math.min(bounds.bottom, surface.scrollTop + surface.viewportHeight - 1);
		for (let row = visibleTop; row <= visibleBottom; row += 1) {
			const point = surface.screenPoint({ row, col: bounds.left });
			if (point.row < clip.y || point.row >= clip.y + clip.height || point.row < 0 || point.row >= result.length)
				continue;
			const start = Math.max(clip.x, point.col);
			const end = Math.min(clip.x + clip.width, point.col + bounds.right - bounds.left);
			if (end <= start) continue;
			result[point.row] = highlightColumns(
				theme,
				result[point.row] ?? "",
				start,
				end - start,
				Math.max(clip.x + clip.width, visibleWidth(result[point.row] ?? "")),
			);
		}
	}
	return result;
}

/** Paint the cursor after feature decorators have rebuilt inline components. */
export function decorateCopyCursor(
	screen: readonly string[],
	surface: FullscreenSurface,
	state: CopyScreenState,
	theme: Theme,
): string[] {
	// The primary copy-mode pass already removes Pi's editor cursor. Do not
	// repeat that cleanup here: it would mistake a one-grapheme selection
	// highlight for an unfocused editor cursor and erase the selection.
	const result = [...screen];
	const clip = surface.viewportRect;
	const cursor = surface.screenPoint(state.cursor);
	if (
		cursor.row >= clip.y &&
		cursor.row < clip.y + clip.height &&
		cursor.col >= clip.x &&
		cursor.col < clip.x + clip.width &&
		cursor.row >= 0 &&
		cursor.row < result.length
	) {
		const cellWidth = Math.max(1, graphemeEnd(state.cursor, document(surface)) - state.cursor.col);
		const width = Math.min(cellWidth, clip.x + clip.width - cursor.col);
		const source = sliceByColumn(result[cursor.row] ?? "", cursor.col, width, true);
		const cell = source + " ".repeat(Math.max(0, width - visibleWidth(source)));
		result[cursor.row] = compositeTuiLine(
			result[cursor.row] ?? "",
			renderSemanticCursor(theme, cell, { role: state.kind === "cursor" ? "navigation" : "selection" }),
			cursor.col,
			width,
			Math.max(clip.x + clip.width, visibleWidth(result[cursor.row] ?? "")),
		);
	}
	return result;
}
