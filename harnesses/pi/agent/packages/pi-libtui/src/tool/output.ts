import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { sanitizeTuiAnsiChunk } from "../content/terminal-text.ts";
import { RenderedLinesCache } from "../render-cache.ts";
import { BoundedStreamBuffer, type BoundedStreamSnapshot } from "../stream.ts";

/** Complete replace-style state for a streaming tool output surface. */
export interface ToolOutputView {
	text: string;
	/** Monotonic caller-owned content revision used for exact render caching. */
	revision: number;
}

/** Explicit bounded row policy selected by a tool-owned view mode. */
export interface ToolOutputViewport {
	maxRows: number;
	selection?: "head" | "tail" | "head-tail";
}

/** Bounds and appearance for a streaming tool output surface. */
export interface ToolOutputOptions {
	theme: Theme;
	initial?: ToolOutputView;
	viewport?: ToolOutputViewport;
	/** Maximum retained output budget, measured as UTF-8 bytes by the stream buffer. */
	maxCharacters?: number;
}

/**
 * A bounded, ANSI-safe output component with explicit append and replace paths.
 *
 * Callers own stream semantics, revisions, and named view modes; the component
 * owns retention, bounded row selection, wrapping, and stable output references.
 */
export class ToolOutput implements Component {
	private readonly cache = new RenderedLinesCache();
	private readonly stream: BoundedStreamBuffer;
	private readonly renderStreams = new Map<string, BoundedStreamBuffer>();
	private streamSnapshot: BoundedStreamSnapshot;
	private ansiPending = "";
	private plainAscii: boolean;
	private currentRevision: number;
	private hasRevision: boolean;
	private cumulativeSourceLength: number;
	private viewport: Required<ToolOutputViewport>;
	private readonly maxCharacters: number;
	private omissionRow: number | undefined;

	constructor(private readonly options: ToolOutputOptions) {
		this.maxCharacters = finitePositive(options.maxCharacters, 1_000_000);
		this.viewport = normalizeViewport(options.viewport);
		this.stream = new BoundedStreamBuffer({ maxBytes: this.maxCharacters, omissionMarker: () => "" });
		this.streamSnapshot = this.stream.snapshot();
		this.plainAscii = true;
		this.currentRevision = 0;
		this.hasRevision = false;
		this.cumulativeSourceLength = 0;
		this.omissionRow = undefined;
		this.reset(options.initial);
	}

	getOmissionRow(): number | undefined {
		return this.omissionRow;
	}

	/** Replace the complete visible stream state. */
	replace(view: ToolOutputView): void {
		if (this.hasRevision && view.revision === this.currentRevision) return;
		this.reset(view);
	}

	/** Start a new stream, even when its first revision matches the previous stream. */
	reset(view?: ToolOutputView): void {
		const source = view?.text ?? "";
		const sanitized = sanitizeTuiAnsiChunk(source, Math.min(this.maxCharacters, 4_096));
		const safeText = sanitized.text;
		this.streamSnapshot = this.stream.replaceFinal(safeText);
		this.plainAscii = isPlainAscii(safeText);
		this.ansiPending = "";
		this.currentRevision = view?.revision ?? 0;
		this.hasRevision = view !== undefined;
		this.cumulativeSourceLength = source.length;
		this.omissionRow = undefined;
		this.renderStreams.clear();
		this.cache.clear();
	}

	/** Consume a cumulative append-only snapshot without copying its retained prefix. */
	appendCumulative(text: string, revision: number): void {
		if (text.length < this.cumulativeSourceLength) {
			this.replace({ text, revision });
			return;
		}
		const chunk = text.slice(this.cumulativeSourceLength);
		this.append(chunk, revision);
	}

	/** Append one stream chunk and advance to the caller-owned revision. */
	append(chunk: string, revision: number): void {
		this.cumulativeSourceLength += chunk.length;
		const sanitized = sanitizeTuiAnsiChunk(this.ansiPending + chunk, Math.min(this.maxCharacters, 4_096));
		this.ansiPending = sanitized.pending;
		const safeChunk = sanitized.text;
		if (safeChunk.length > 0) {
			this.plainAscii &&= isPlainAscii(safeChunk);
			this.streamSnapshot = this.stream.append(safeChunk);
			for (const stream of this.renderStreams.values()) stream.append(safeChunk);
		} else {
			this.streamSnapshot = this.stream.snapshot();
		}
		this.currentRevision = revision;
		this.hasRevision = true;
		this.omissionRow = undefined;
		this.cache.clear();
	}

	/** Apply an explicit bounded row policy chosen by the owning tool mode. */
	setViewport(viewport: ToolOutputViewport): void {
		const next = normalizeViewport(viewport);
		if (this.viewport.maxRows === next.maxRows && this.viewport.selection === next.selection) return;
		this.viewport = next;
		this.omissionRow = undefined;
		this.renderStreams.clear();
		this.cache.clear();
	}

	render(width: number): string[] {
		const key = `${this.currentRevision}\0${this.viewport.maxRows}\0${this.viewport.selection}\0${this.streamSnapshot.totalBytes}\0${this.streamSnapshot.omittedBytes}\0${this.streamSnapshot.truncated}\0${this.plainAscii}`;
		return this.cache.get(width, key, () => this.renderFresh(width));
	}

	private renderFresh(width: number): string[] {
		this.omissionRow = undefined;
		if (width <= 0) return [];
		const maximum = this.viewport.maxRows;
		const boundedText = this.renderText(maximum, width);
		const visibleText = boundedText.replace(/\n$/, "");
		const wrapped =
			boundedText.length === 0
				? []
				: this.plainAscii
					? wrapPlainAscii(visibleText, width)
					: wrapTextWithAnsi(visibleText, width);
		const prefix = this.streamSnapshot.truncated ? 1 : 0;
		const available = maximum - prefix;
		if (available === 0) {
			const colors = tuiTheme(this.options.theme);
			this.omissionRow = 0;
			return [
				truncateToWidth(
					colors.fg("text.muted", `… ${this.streamSnapshot.omittedBytes} earlier characters discarded`),
					width,
					"…",
				),
			];
		}
		const bounded = boundRows(wrapped, available, width, this.options.theme, this.viewport.selection);
		if (!this.streamSnapshot.truncated) {
			this.omissionRow = bounded.omissionRow;
			return bounded.lines;
		}
		const colors = tuiTheme(this.options.theme);
		this.omissionRow = 0;
		return [
			truncateToWidth(
				colors.fg("text.muted", `… ${this.streamSnapshot.omittedBytes} earlier characters discarded`),
				width,
				"…",
			),
			...bounded.lines,
		];
	}

	private renderText(rows: number, width: number): string {
		// Two source code units per visible cell leaves room for ANSI and wide
		// glyphs without rescanning retained history on every streamed frame.
		const budget = Math.max(256, rows * Math.max(1, width) * 2);
		const key = `${this.viewport.maxRows}\0${width}`;
		let stream = this.renderStreams.get(key);
		if (stream === undefined) {
			if (this.renderStreams.size >= 4) this.renderStreams.clear();
			stream = new BoundedStreamBuffer({
				maxBytes: budget,
				omissionMarker: () => "\n… output clipped before wrapping …\n",
			});
			stream.replaceFinal(this.streamSnapshot.text);
			this.renderStreams.set(key, stream);
		}
		return stream.snapshot().text;
	}

	invalidate(): void {
		this.cache.clear();
	}
}

function finitePositive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function isPlainAscii(text: string): boolean {
	return /^[\x20-\x7e\n]*$/u.test(text);
}

function wrapPlainAscii(text: string, width: number): string[] {
	const rows: string[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) rows.push("");
		else for (let index = 0; index < line.length; index += width) rows.push(line.slice(index, index + width));
	}
	return rows;
}

interface BoundedRows {
	readonly lines: string[];
	readonly omissionRow?: number;
}

function boundRows(
	lines: readonly string[],
	maximum: number,
	width: number,
	theme: Theme,
	selection: Required<ToolOutputViewport>["selection"],
): BoundedRows {
	if (lines.length <= maximum) return { lines: [...lines] };
	const colors = tuiTheme(theme);
	if (maximum === 1)
		return {
			lines: [truncateToWidth(colors.fg("text.muted", `… ${lines.length} rows`), width, "…")],
			omissionRow: 0,
		};
	const visibleRows = maximum - 1;
	if (selection === "head") {
		return {
			lines: [
				...lines.slice(0, visibleRows),
				truncateToWidth(colors.fg("text.muted", `… ${lines.length - visibleRows} rows omitted …`), width, "…"),
			],
			omissionRow: visibleRows,
		};
	}
	if (selection === "tail") {
		return {
			lines: [
				truncateToWidth(colors.fg("text.muted", `… ${lines.length - visibleRows} rows omitted …`), width, "…"),
				...lines.slice(-visibleRows),
			],
			omissionRow: 0,
		};
	}
	const head = Math.floor(visibleRows / 2);
	const tail = visibleRows - head;
	const omitted = lines.length - head - tail;
	return {
		lines: [
			...lines.slice(0, head),
			truncateToWidth(colors.fg("text.muted", `… ${omitted} rows omitted …`), width, "…"),
			...lines.slice(lines.length - tail),
		],
		omissionRow: head,
	};
}

function normalizeViewport(viewport: ToolOutputViewport | undefined): Required<ToolOutputViewport> {
	const requested = viewport?.maxRows ?? 6;
	const maxRows = Number.isFinite(requested) ? Math.min(10_000, Math.max(1, Math.floor(requested))) : 6;
	return { maxRows, selection: viewport?.selection ?? "head-tail" };
}
