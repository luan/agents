import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type {
	FullscreenLayout,
	FullscreenLayoutCapability,
	LayoutFrame,
	LayoutScrollViewReference,
	LayoutSelectionPoint,
} from "../mouse.ts";
import type { NativeSelectionCompleted, NativeSelectionGeometry, SelectionPoint } from "../selection.ts";
import {
	findScrollViewBox,
	intersect,
	isRecord,
	parseLayoutScrollViewReference,
	rendererLayoutFrame,
	terminalSize,
} from "./pi-layout-adapter.ts";

interface PrivateSelectionPoint extends SelectionPoint {
	scrollView?: LayoutScrollViewReference;
	boundary?: boolean;
}

// type-boundary: Pi 0.84.2's private selection fields are untyped; these validators narrow each reflected value.
type PiPrivateValue = unknown;

function parseSelectionPoint(value: PiPrivateValue): PrivateSelectionPoint | undefined {
	if (!isRecord(value) || typeof value.row !== "number" || typeof value.col !== "number") return undefined;
	if (!Number.isFinite(value.row) || !Number.isFinite(value.col)) return undefined;
	const scrollView = value.scrollView === undefined ? undefined : parseLayoutScrollViewReference(value.scrollView);
	if (value.scrollView !== undefined && !scrollView) return undefined;
	return {
		row: value.row,
		col: value.col,
		scrollView,
		boundary: value.boundary === true,
	};
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function selectionScreenPoint(
	point: PrivateSelectionPoint,
	frame: LayoutFrame,
	size: { rows: number; columns: number },
): SelectionPoint | undefined {
	if (!point.scrollView) {
		return {
			row: clamp(point.row, 0, Math.max(0, size.rows - 1)),
			col: clamp(point.col, 0, Math.max(0, size.columns - 1)),
		};
	}
	const box = findScrollViewBox(frame, point.scrollView);
	if (!box || box.rect.width <= 0 || box.rect.height <= 0) return undefined;
	const scrollTop = Reflect.get(point.scrollView, "scrollTop") as PiPrivateValue;
	if (typeof scrollTop !== "number") return undefined;
	const visible = intersect(box.rect, box.clip);
	if (visible.width <= 0 || visible.height <= 0) return undefined;
	const rawRow = box.rect.y + point.row - scrollTop;
	const row = clamp(rawRow, visible.y, visible.y + visible.height - 1);
	const rawCol =
		rawRow < visible.y
			? visible.x
			: rawRow >= visible.y + visible.height
				? visible.x + visible.width - 1
				: box.rect.x + point.col;
	return {
		row: clamp(row, 0, Math.max(0, size.rows - 1)),
		col: clamp(rawCol, visible.x, Math.min(size.columns - 1, visible.x + visible.width - 1)),
	};
}

function selectionLines(
	renderer: object,
	frame: LayoutFrame,
	start: PrivateSelectionPoint,
): readonly string[] | undefined {
	if (start.scrollView) {
		return findScrollViewBox(frame, start.scrollView)?.scrollContentLines;
	}
	const previousScreen = Reflect.get(renderer, "previousScreen") as PiPrivateValue;
	return Array.isArray(previousScreen) && previousScreen.every((line) => typeof line === "string")
		? previousScreen
		: undefined;
}

function selectedText(lines: readonly string[], start: PrivateSelectionPoint, end: PrivateSelectionPoint): string {
	const selected: string[] = [];
	for (let row = start.row; row <= end.row; row += 1) {
		const source = lines[row] ?? "";
		const width = visibleWidth(source);
		const from = row === start.row ? Math.min(start.col, width) : 0;
		const to = row === end.row ? Math.min(end.boundary ? end.col : end.col + 1, width) : width;
		selected.push(stripTerminalSequences(sliceByColumn(source, from, Math.max(0, to - from), true)).trimEnd());
	}
	return selected.join("\n");
}

const SELECTION_QUOTE_CONTEXT = 80;

function selectionQuote(
	lines: readonly string[],
	start: PrivateSelectionPoint,
	exact: string,
): { exact: string; prefix?: string; suffix?: string } {
	const plainLines = lines.map((line) => stripTerminalSequences(line).trimEnd());
	if (!Number.isInteger(start.row) || start.row < 0 || start.row >= plainLines.length) return { exact };
	let offset = 0;
	for (let row = 0; row < start.row; row += 1) offset += plainLines[row]!.length + 1;
	const sourceLine = lines[start.row] ?? "";
	const prefix = stripTerminalSequences(sliceByColumn(sourceLine, 0, Math.max(0, start.col), true));
	offset += Math.min(prefix.length, plainLines[start.row]!.length);
	const source = plainLines.join("\n");
	if (source.slice(offset, offset + exact.length) !== exact) return { exact };
	return {
		exact,
		...(offset > 0 ? { prefix: source.slice(Math.max(0, offset - SELECTION_QUOTE_CONTEXT), offset) } : {}),
		...(offset + exact.length < source.length
			? { suffix: source.slice(offset + exact.length, offset + exact.length + SELECTION_QUOTE_CONTEXT) }
			: {}),
	};
}

interface NativeSelectionSnapshot {
	start: PrivateSelectionPoint;
	end: PrivateSelectionPoint;
	frame: LayoutFrame;
	geometry: NativeSelectionGeometry;
}

function nativeSelectionSnapshot(renderer: object): NativeSelectionSnapshot | undefined {
	const anchor = parseSelectionPoint(Reflect.get(renderer, "selectionAnchor") as PiPrivateValue);
	const focus = parseSelectionPoint(Reflect.get(renderer, "selectionFocus") as PiPrivateValue);
	if (!anchor || !focus || anchor.scrollView !== focus.scrollView) return undefined;
	if (anchor.row === focus.row && anchor.col === focus.col) return undefined;
	const anchorFirst = anchor.row < focus.row || (anchor.row === focus.row && anchor.col < focus.col);
	const start = anchorFirst ? anchor : focus;
	const end = anchorFirst ? focus : anchor;
	const frame = rendererLayoutFrame(renderer);
	const size = terminalSize(renderer);
	if (!frame || !size) return undefined;
	const screenStart = selectionScreenPoint(start, frame, size);
	const screenEnd = selectionScreenPoint(end, frame, size);
	if (!screenStart || !screenEnd) return undefined;
	return {
		start,
		end,
		frame,
		geometry: {
			shape: Reflect.get(renderer, "selectionGranularity") === "line" ? "line" : "character",
			logical: {
				start: { row: start.row, col: start.col },
				end: { row: end.row, col: end.col },
			},
			screen: { start: screenStart, end: screenEnd },
		},
	};
}

export function nativeSelectionGeometry(renderer: object): NativeSelectionGeometry | undefined {
	return nativeSelectionSnapshot(renderer)?.geometry;
}

export function nativeSelectionCompleted(renderer: object): NativeSelectionCompleted | undefined {
	const snapshot = nativeSelectionSnapshot(renderer);
	if (!snapshot) return undefined;
	const { start, end, frame, geometry } = snapshot;
	const lines = selectionLines(renderer, frame, start);
	if (!lines) return undefined;
	const text = selectedText(lines, start, end);
	return { ...geometry, text, source: { quote: selectionQuote(lines, start, text) } };
}

export function rendererFullscreenLayout(renderer: object): FullscreenLayout | undefined {
	const frame = rendererLayoutFrame(renderer);
	const primaryScrollView = frame?.primaryScrollView;
	if (!frame || !primaryScrollView) return undefined;
	const primaryBox = findScrollViewBox(frame, primaryScrollView);
	const lines = primaryBox?.scrollContentLines;
	const viewport = primaryBox ? intersect(primaryBox.rect, primaryBox.clip) : undefined;
	if (!primaryBox || !lines || !viewport || viewport.width <= 0 || viewport.height <= 0) return undefined;
	const selectionPoint = (key: "selectionAnchor" | "selectionFocus"): LayoutSelectionPoint | undefined => {
		const point = parseSelectionPoint(Reflect.get(renderer, key) as PiPrivateValue);
		if (point?.scrollView !== primaryScrollView) return undefined;
		return {
			row: point.row,
			col: point.col,
			scrollView: primaryScrollView,
			...(point.boundary ? { boundary: true } : {}),
		};
	};
	return {
		frame,
		primaryBox,
		primaryScrollView,
		lines,
		viewport: { ...viewport, scrollTop: primaryScrollView.scrollTop },
		get selectionAnchor() {
			return selectionPoint("selectionAnchor");
		},
		get selectionFocus() {
			return selectionPoint("selectionFocus");
		},
		setSelection(anchor, focus) {
			Reflect.set(renderer, "selectionAnchor", anchor);
			Reflect.set(renderer, "selectionFocus", focus);
			Reflect.set(renderer, "selectionActive", anchor !== undefined && focus !== undefined);
		},
		point(point, boundary = false) {
			return { ...point, scrollView: primaryScrollView, ...(boundary ? { boundary: true } : {}) };
		},
		screenPoint(point) {
			return {
				row: primaryBox.rect.y + point.row - primaryScrollView.scrollTop,
				col: primaryBox.rect.x + point.col,
			};
		},
	};
}

export const fullscreenLayoutCapability: FullscreenLayoutCapability = {
	protocol: "pi-libtui/fullscreen-layout/v1",
	version: 1,
	resolve: rendererFullscreenLayout,
};
