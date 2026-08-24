import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { TerminalProjection } from "./projection.ts";

export type {
	ProjectionScheduler,
	ProjectionTimer,
	RenderTerminalLinesOptions,
	TerminalProjectionOptions,
} from "./projection.ts";
export { TerminalProjection };

const CUMULATIVE_TAIL_LIMIT = 64 * 1024;
const MIN_CUMULATIVE_OVERLAP = 16;

export interface TerminalOutputOptions {
	requestRender(): void;
	cols?: number;
	rows?: number;
	maxRows?: number;
}

/** Incremental ANSI/TTY output view with replay-safe replacement and bounded scrollback. */
export class TerminalOutput implements Component {
	private projection: TerminalProjection;
	private sourceLength = 0;
	private sourceTail = "";
	private maxRows: number;
	private omissionRow: number | undefined;
	private disposed = false;

	constructor(private readonly options: TerminalOutputOptions) {
		this.maxRows = Math.max(1, Math.floor(options.maxRows ?? 6));
		this.omissionRow = undefined;
		this.projection = this.createProjection();
	}

	getOmissionRow(): number | undefined {
		return this.omissionRow;
	}

	setText(text: string): void {
		if (this.disposed) return;
		this.projection.dispose();
		this.projection = this.createProjection();
		this.sourceLength = text.length;
		this.sourceTail = retainedSourceTail(text);
		this.omissionRow = undefined;
		if (text) this.write(text);
	}

	/** Consume a cumulative append-only snapshot without rescanning its retained prefix. */
	appendCumulative(text: string): void {
		if (this.disposed) return;
		if (text.length < this.sourceLength) {
			this.setText(text);
			return;
		}
		const chunk = text.slice(this.sourceLength);
		this.sourceLength = text.length;
		this.sourceTail = retainedSourceTail(text);
		if (chunk) this.write(chunk);
	}

	private write(chunk: string): void {
		if (!chunk || this.disposed) return;
		this.projection.write(chunk);
	}

	/**
	 * Consume a cumulative snapshot whose prefix may have been truncated by the
	 * caller. This is deliberately separate from setText(): only a caller that
	 * knows the snapshot is a retained cumulative tail may reuse terminal state
	 * by overlap.
	 */
	appendCumulativeTail(text: string): void {
		if (this.disposed) return;
		if (text.length === 0 || this.sourceLength === 0 || this.sourceTail.length === 0) {
			this.setText(text);
			return;
		}
		const overlap = cumulativeTailOverlap(this.sourceTail, text);
		if (overlap < MIN_CUMULATIVE_OVERLAP) {
			this.setText(text);
			return;
		}
		const chunk = text.slice(overlap);
		if (chunk) this.projection.write(chunk);
		this.sourceLength += chunk.length;
		this.sourceTail = retainedSourceTail(text);
		this.omissionRow = undefined;
	}

	/** Wait until all terminal input written so far has been projected. */
	async drain(): Promise<void> {
		if (this.disposed) return;
		await this.projection.drain();
	}

	setMaxRows(maxRows: number): void {
		this.maxRows = Math.max(1, Math.floor(maxRows));
		this.omissionRow = undefined;
	}

	render(width: number): string[] {
		this.omissionRow = undefined;
		this.projection.resize(Math.max(1, width), this.options.rows ?? 24);
		const lines = [...this.projection.renderLines({ includeScrollback: true, cursor: false })];
		while (lines.at(-1) === "") lines.pop();
		if (lines.length <= this.maxRows) return lines;
		const visibleRows = this.maxRows - 1;
		this.omissionRow = 0;
		return [
			truncateToWidth(`… ${lines.length - visibleRows} rows omitted …`, Math.max(0, width), "…"),
			...lines.slice(-visibleRows),
		];
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.projection.dispose();
	}

	private createProjection(): TerminalProjection {
		return new TerminalProjection({
			requestRender: this.options.requestRender,
			cols: this.options.cols ?? 80,
			rows: this.options.rows ?? 24,
		});
	}
}

function retainedSourceTail(text: string): string {
	return text.length <= CUMULATIVE_TAIL_LIMIT ? text : text.slice(-CUMULATIVE_TAIL_LIMIT);
}

/** Return the longest suffix/prefix overlap needed to append a shifted tail. */
function cumulativeTailOverlap(previousTail: string, nextText: string): number {
	if (previousTail.length === 0 || nextText.length === 0) return 0;
	const needle = nextText.slice(0, Math.min(32, nextText.length));
	for (let searchStart = Math.max(0, previousTail.length - nextText.length); ; ) {
		const match = previousTail.indexOf(needle, searchStart);
		if (match < 0) return 0;
		const overlap = previousTail.length - match;
		if (overlap <= nextText.length && nextText.startsWith(previousTail.slice(match))) return overlap;
		searchStart = match + 1;
	}
}
