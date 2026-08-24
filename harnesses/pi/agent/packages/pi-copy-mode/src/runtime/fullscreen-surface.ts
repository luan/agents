import type { TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { type LayoutBox, type LayoutSelectionPoint, resolveFullscreenLayout } from "pi-libtui/mouse";
import type { CursorPoint } from "../core/cursor.ts";

interface PrivateFullscreenRenderer {
	mode: "fullscreen";
	copySelectionToClipboard(): Promise<void>;
	copySelection?(text: string): Promise<boolean>;
	flash(message: string): void;
	terminal?: { write(data: string): void };
	requestRender(): void;
	requestImmediateRender?(): void;
}

export interface FullscreenSurface {
	readonly lineCount: number;
	line(row: number): string;
	lineWidth(row: number): number;
	lineGlyphWidth(row: number): number;
	lineStops(row: number): readonly number[];
	/** Deepest structurally rendered component and its local row at a transcript row. */
	componentAt(row: number): { component: object; row: number } | undefined;
	readonly scrollTop: number;
	readonly viewportHeight: number;
	readonly viewportRect: { x: number; y: number; width: number; height: number };
	readonly selectionAnchor: LayoutSelectionPoint | undefined;
	readonly selectionFocus: LayoutSelectionPoint | undefined;
	setSelection(anchor: LayoutSelectionPoint | undefined, focus: LayoutSelectionPoint | undefined): void;
	point(point: CursorPoint, boundary?: boolean): LayoutSelectionPoint;
	scrollTo(row: number): void;
	copySelectionToClipboard(): Promise<void>;
	copyText(text: string): Promise<boolean>;
	requestImmediateRender(): void;
	screenPoint(point: CursorPoint): CursorPoint;
}

// type-boundary: Pi 0.84.2's stable TUI proxy exposes private clipboard and render methods; the host layout capability owns layout validation.
export type PiFullscreenBoundary = unknown;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
interface LineMetrics {
	source: string;
	width: number;
	glyphWidth: number;
	stops: readonly number[];
}
const lineMetricsCache = new WeakMap<readonly string[], Map<number, LineMetrics>>();
let lineMetricComputations = 0;

export function getLineMetricComputationCount(): number {
	return lineMetricComputations;
}

export function resetLineMetricComputationCount(): void {
	lineMetricComputations = 0;
}

function graphemeStarts(line: string): number[] {
	const starts: number[] = [];
	let column = 0;
	for (const segment of graphemes.segment(stripTerminalSequences(line))) {
		if (starts.at(-1) !== column) starts.push(column);
		column += visibleWidth(segment.segment);
	}
	return starts.length > 0 ? starts : [0];
}

function lineAt(lines: readonly string[], row: number): string {
	const line: PiFullscreenBoundary = lines[row];
	return typeof line === "string" ? line : "";
}

function lineMetrics(lines: readonly string[], row: number): LineMetrics {
	let cache = lineMetricsCache.get(lines);
	if (!cache) {
		cache = new Map();
		lineMetricsCache.set(lines, cache);
	}
	const source = lineAt(lines, row);
	const existing = cache.get(row);
	if (existing?.source === source) return existing;
	lineMetricComputations += 1;
	const metrics = {
		source,
		width: visibleWidth(source),
		glyphWidth: visibleWidth(stripTerminalSequences(source).trimEnd()),
		stops: graphemeStarts(source),
	};
	cache.set(row, metrics);
	return metrics;
}

function isNumber(value: PiFullscreenBoundary): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

interface StructuralSpan {
	component: object;
	row: number;
	height: number;
}

interface ComponentPoint {
	component: object;
	row: number;
}

function structuralSpans(component: object): readonly StructuralSpan[] | undefined {
	const getSpans = Reflect.get(component, "getSpans");
	if (typeof getSpans !== "function") return undefined;
	let value: PiFullscreenBoundary;
	try {
		value = Reflect.apply(getSpans, component, []) as PiFullscreenBoundary;
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const spans: StructuralSpan[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return [];
		const span = entry as Partial<StructuralSpan>;
		if (!span.component || typeof span.component !== "object" || !isNumber(span.row) || !isNumber(span.height))
			return [];
		spans.push({ component: span.component, row: Math.floor(span.row), height: Math.max(0, Math.floor(span.height)) });
	}
	return spans;
}

function structuralComponentAt(component: object, row: number, ancestors = new Set<object>()): ComponentPoint {
	if (ancestors.has(component)) return { component, row };
	const spans = structuralSpans(component);
	if (!spans) return { component, row };
	const span = spans.find((candidate) => row >= candidate.row && row < candidate.row + candidate.height);
	if (!span) return { component, row };
	ancestors.add(component);
	const found: ComponentPoint = structuralComponentAt(span.component, row - span.row, ancestors);
	ancestors.delete(component);
	return found;
}

function layoutComponentAt(box: LayoutBox, row: number, originY: number): ComponentPoint {
	for (const child of box.children) {
		const start = child.rect.y - originY;
		if (row >= start && row < start + child.rect.height) return layoutComponentAt(child, row, originY);
	}
	return structuralComponentAt(box.component, row - (box.rect.y - originY));
}

function contentLayoutBox(
	box: LayoutBox,
	lines: readonly string[],
	ancestors = new Set<object>(),
): LayoutBox | undefined {
	if (ancestors.has(box)) return undefined;
	ancestors.add(box);
	try {
		for (const child of box.children) {
			if (child.scrollContentLines === lines) return child;
			const found = contentLayoutBox(child, lines, ancestors);
			if (found) return found;
		}
		return undefined;
	} finally {
		ancestors.delete(box);
	}
}

export function validateFullscreenSurface(tui: TUI): FullscreenSurface | undefined {
	const boundary: PiFullscreenBoundary = tui;
	if (!boundary || typeof boundary !== "object") return undefined;
	const renderer = boundary as Partial<PrivateFullscreenRenderer>;
	if (
		renderer.mode !== "fullscreen" ||
		typeof renderer.copySelectionToClipboard !== "function" ||
		typeof renderer.requestRender !== "function" ||
		typeof renderer.flash !== "function"
	)
		return undefined;
	const layout = resolveFullscreenLayout(tui as object);
	if (!layout) return undefined;
	const lines = layout.lines;
	const contentBox = contentLayoutBox(layout.primaryBox, lines) ?? layout.primaryBox.children[0] ?? layout.primaryBox;
	return {
		lineCount: lines.length,
		line: (row) => lineAt(lines, row),
		lineWidth: (row) => lineMetrics(lines, row).width,
		lineGlyphWidth: (row) => lineMetrics(lines, row).glyphWidth,
		lineStops: (row) => lineMetrics(lines, row).stops,
		componentAt(row) {
			if (!contentBox || !Number.isFinite(row)) return undefined;
			const boundedRow = Math.floor(row);
			if (boundedRow < 0 || boundedRow >= lines.length) return undefined;
			return layoutComponentAt(contentBox, boundedRow, contentBox.rect.y);
		},
		viewportRect: {
			x: layout.viewport.x,
			y: layout.viewport.y,
			width: layout.viewport.width,
			height: layout.viewport.height,
		},
		get scrollTop() {
			return layout.primaryScrollView.scrollTop;
		},
		get viewportHeight() {
			return Math.max(1, layout.primaryScrollView.viewportHeight);
		},
		get selectionAnchor() {
			return layout.selectionAnchor;
		},
		get selectionFocus() {
			return layout.selectionFocus;
		},
		setSelection(anchor, focus) {
			layout.setSelection(anchor, focus);
		},
		point(point, boundaryPoint = false) {
			return layout.point(point, boundaryPoint);
		},
		scrollTo(row) {
			layout.primaryScrollView.scrollTo(row, { disableFollow: true });
		},
		copySelectionToClipboard() {
			return renderer.copySelectionToClipboard?.call(tui) ?? Promise.resolve();
		},
		async copyText(text) {
			if (typeof renderer.copySelection === "function") {
				let copied = false;
				try {
					copied = await renderer.copySelection.call(tui, text);
				} catch {
					copied = false;
				}
				return copied;
			}
			const terminal = renderer.terminal;
			if (!terminal || typeof terminal.write !== "function") return false;
			terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
			return true;
		},
		requestImmediateRender() {
			if (typeof renderer.requestImmediateRender === "function") renderer.requestImmediateRender.call(tui);
			else renderer.requestRender?.call(tui);
		},
		screenPoint(point) {
			return layout.screenPoint(point);
		},
	};
}
