import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { type IBufferCell, type IBufferLine, Terminal } from "@xterm/headless";
import { markNativeCursorPosition, type NativeCursorStyle } from "../cursor.ts";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 5_000;
const DEFAULT_REPAINT_INTERVAL_MS = 40;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const MAX_SCROLLBACK = 10_000;

/** Clamp a PTY and its projection to the same supported viewport. */
export function normalizeTerminalDimensions(cols: number, rows: number): readonly [number, number] {
	return [clampDimension(cols, MAX_COLS), clampDimension(rows, MAX_ROWS)];
}

// type-boundary: @xterm/headless 6 keeps its low-latency user-input hint on the
// private write buffer. The hint retains public write ordering, async handlers,
// and slicing; remove this seam when Terminal exposes it.
type ProjectionTerminal = Terminal & {
	_core?: {
		_writeBuffer?: { handleUserInput?: () => void };
		_inputHandler?: {
			onRequestRefreshRows?: (listener: (range: { start: number; end: number } | undefined) => void) => {
				dispose(): void;
			};
		};
	};
};

export interface ProjectionTimer {
	dispose(): void;
}

/** Injectable clock used to make repaint throttling deterministic. */
export interface ProjectionScheduler {
	now(): number;
	schedule(callback: () => void, delayMs: number): ProjectionTimer;
}

export interface TerminalProjectionOptions {
	readonly requestRender: () => void;
	readonly cols?: number;
	readonly rows?: number;
	readonly scrollback?: number;
	readonly repaintIntervalMs?: number;
	readonly scheduler?: ProjectionScheduler;
}

export interface RenderTerminalLinesOptions {
	/** Include the bounded xterm scrollback instead of only the viewport. */
	readonly includeScrollback?: boolean;
	/** Include Pi's hardware cursor marker. Defaults to true. */
	readonly cursor?: boolean;
	/** Maximum returned rows. Defaults to the configured viewport or scrollback bound. */
	readonly maxRows?: number;
}

const SYSTEM_SCHEDULER: ProjectionScheduler = {
	now: () => Date.now(),
	schedule(callback, delayMs) {
		if (delayMs <= 0) {
			let disposed = false;
			queueMicrotask(() => {
				if (!disposed) callback();
			});
			return { dispose: () => (disposed = true) };
		}
		const handle = setTimeout(callback, delayMs);
		handle.unref?.();
		return { dispose: () => clearTimeout(handle) };
	},
};

/**
 * Side-effect-free terminal emulation for streamed PTY bytes.
 *
 * Projection replays cell state as an allowlisted subset of SGR. OSC, DCS,
 * title changes, clipboard controls, and other terminal side effects never
 * escape into the host renderer.
 */
export class TerminalProjection {
	private readonly terminal: Terminal;
	private readonly parsedSubscription: { dispose(): void };
	private readonly dirtyRowsSubscription: { dispose(): void } | undefined;
	private readonly cursorSubscriptions: readonly { dispose(): void }[];
	private readonly requestRender: () => void;
	private readonly scheduler: ProjectionScheduler;
	private readonly repaintIntervalMs: number;
	private repaintTimer: ProjectionTimer | undefined;
	private lastRenderAt = Number.NEGATIVE_INFINITY;
	private disposed = false;
	private bufferRevision = 0;
	private renderedRevision = -1;
	private renderedKey = "";
	private renderedLines: string[] | undefined;
	private readonly projectedRows = new Map<
		number,
		{ cursorColumn: number | undefined; cursorStyle: NativeCursorStyle | undefined; value: string }
	>();
	private projectedBufferType: "normal" | "alternate" | undefined;
	private projectedBaseY = 0;
	private contentEndRow = 0;
	private cursorVisible = true;
	private cursorStyle: NativeCursorStyle | undefined;

	constructor(options: TerminalProjectionOptions) {
		const [cols, rows] = normalizeTerminalDimensions(options.cols ?? DEFAULT_COLS, options.rows ?? DEFAULT_ROWS);
		this.requestRender = options.requestRender;
		this.scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
		this.repaintIntervalMs = clampNonNegative(options.repaintIntervalMs ?? DEFAULT_REPAINT_INTERVAL_MS);
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols,
			rows,
			scrollback: clampNonNegative(options.scrollback ?? DEFAULT_SCROLLBACK, MAX_SCROLLBACK),
			convertEol: false,
		});
		this.parsedSubscription = this.terminal.onWriteParsed(() => {
			this.markParsed();
		});
		this.cursorSubscriptions = [
			this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
				if (params.includes(25)) this.cursorVisible = true;
				return false;
			}),
			this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
				if (params.includes(25)) this.cursorVisible = false;
				return false;
			}),
			this.terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
				this.cursorStyle = nativeCursorStyle(params[0]);
				return false;
			}),
		];
		// type-boundary: @xterm/headless 6 exposes dirty viewport rows only on its
		// private input handler. Cache correctness falls back to full invalidation
		// when that installed structural seam is unavailable.
		this.dirtyRowsSubscription = (this.terminal as ProjectionTerminal)._core?._inputHandler?.onRequestRefreshRows?.(
			(range) => this.invalidateProjectedRows(range),
		);
	}

	get cols(): number {
		return this.terminal.cols;
	}

	get rows(): number {
		return this.terminal.rows;
	}

	get acceptsFocusEvents(): boolean {
		return this.terminal.modes.sendFocusMode;
	}

	/** Route interactive bytes through xterm's immediate, ordered input path. */
	write(data: string | Uint8Array): void {
		if (this.disposed || data.length === 0) return;
		const writeBuffer = (this.terminal as ProjectionTerminal)._core?._writeBuffer;
		writeBuffer?.handleUserInput?.call(writeBuffer);
		this.terminal.write(data);
	}

	/** Resolve after every previously queued write has been parsed. */
	drain(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return new Promise((resolve) => this.terminal.write("", resolve));
	}

	resize(cols: number, rows: number): boolean {
		if (this.disposed) return false;
		const [nextCols, nextRows] = normalizeTerminalDimensions(cols, rows);
		if (nextCols === this.terminal.cols && nextRows === this.terminal.rows) return false;
		this.terminal.resize(nextCols, nextRows);
		this.projectedRows.clear();
		this.bufferRevision += 1;
		this.scheduleRender();
		return true;
	}

	renderLines(options: RenderTerminalLinesOptions = {}): string[] {
		if (this.disposed) return [];
		const cacheKey = `${options.includeScrollback ?? false}\0${options.cursor ?? true}\0${options.maxRows ?? ""}`;
		if (this.renderedRevision === this.bufferRevision && this.renderedKey === cacheKey && this.renderedLines) {
			return this.renderedLines;
		}
		const buffer = this.terminal.buffer.active;
		if (buffer.type !== this.projectedBufferType || buffer.baseY !== this.projectedBaseY) {
			this.projectedRows.clear();
			this.projectedBufferType = buffer.type;
			this.projectedBaseY = buffer.baseY;
		}
		const includeScrollback = options.includeScrollback ?? false;
		const firstRow = includeScrollback ? 0 : buffer.viewportY;
		const endRow = includeScrollback
			? Math.max(1, Math.min(buffer.length, this.contentEndRow + 1))
			: buffer.viewportY + this.terminal.rows;
		const availableRows = endRow - firstRow;
		const rowCount = Math.min(availableRows, clampNonNegative(options.maxRows ?? availableRows, MAX_SCROLLBACK));
		const boundedFirstRow = endRow - rowCount;
		const cursorLine = buffer.baseY + buffer.cursorY;
		const lines: string[] = [];
		const cell = buffer.getNullCell();
		for (let offset = 0; offset < rowCount; offset += 1) {
			const bufferRow = boundedFirstRow + offset;
			const cursorColumn =
				options.cursor !== false && this.cursorVisible && bufferRow === cursorLine ? buffer.cursorX : undefined;
			const cached = this.projectedRows.get(bufferRow);
			if (cached && cached.cursorColumn === cursorColumn && cached.cursorStyle === this.cursorStyle) {
				lines.push(cached.value);
				continue;
			}
			const projected = projectLine(buffer.getLine(bufferRow), this.terminal.cols, cursorColumn, cell);
			const value =
				cursorColumn !== undefined && this.cursorStyle
					? markNativeCursorPosition(projected, this.cursorStyle)
					: projected;
			this.projectedRows.set(bufferRow, { cursorColumn, cursorStyle: this.cursorStyle, value });
			lines.push(value);
		}
		this.renderedRevision = this.bufferRevision;
		this.renderedKey = cacheKey;
		this.renderedLines = lines;
		return lines;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.repaintTimer?.dispose();
		this.repaintTimer = undefined;
		this.parsedSubscription.dispose();
		this.dirtyRowsSubscription?.dispose();
		for (const subscription of this.cursorSubscriptions) subscription.dispose();
		this.terminal.dispose();
		this.renderedLines = undefined;
		this.projectedRows.clear();
	}

	private markParsed(): void {
		if (!this.dirtyRowsSubscription) this.projectedRows.clear();
		const buffer = this.terminal.buffer.active;
		this.contentEndRow = Math.max(this.contentEndRow, buffer.baseY + buffer.cursorY);
		this.bufferRevision += 1;
		// Synchronized output is one atomic frame even when its bytes cross native
		// reads. Publishing the body early causes tearing and burns an extra host frame.
		if (!this.terminal.modes.synchronizedOutputMode) this.scheduleRender();
	}

	private invalidateProjectedRows(range: { start: number; end: number } | undefined): void {
		if (!range) {
			this.projectedRows.clear();
			return;
		}
		const viewportY = this.terminal.buffer.active.viewportY;
		for (let row = range.start; row <= range.end; row += 1) this.projectedRows.delete(viewportY + row);
	}

	private scheduleRender(): void {
		if (this.disposed || this.repaintTimer) return;
		const elapsed = this.scheduler.now() - this.lastRenderAt;
		const delay = Math.max(0, this.repaintIntervalMs - elapsed);
		this.repaintTimer = this.scheduler.schedule(() => {
			this.repaintTimer = undefined;
			if (this.disposed) return;
			this.lastRenderAt = this.scheduler.now();
			try {
				this.requestRender();
			} catch {
				// Host repaint failures must not escape a terminal timer.
			}
		}, delay);
	}
}

function nativeCursorStyle(parameter: number | number[] | undefined): NativeCursorStyle {
	const value = Array.isArray(parameter) ? parameter[0] : parameter;
	if (value === 1) return "blinking-block";
	if (value === 2) return "steady-block";
	if (value === 3) return "blinking-underline";
	if (value === 4) return "steady-underline";
	if (value === 5) return "blinking-bar";
	if (value === 6) return "steady-bar";
	return "terminal-default";
}

function projectLine(
	line: IBufferLine | undefined,
	cols: number,
	cursorColumn: number | undefined,
	cell: IBufferCell,
): string {
	let lastCell = cursorColumn ?? -1;
	if (line) {
		for (let column = 0; column < cols; column += 1) {
			const current = line.getCell(column, cell);
			if (current && current.getWidth() > 0 && (current.getChars().length > 0 || !current.isAttributeDefault())) {
				lastCell = column;
			}
		}
	}

	let result = "";
	let activeStyle = "";
	for (let column = 0; column <= lastCell; column += 1) {
		if (column === cursorColumn) result += CURSOR_MARKER;
		const current = line?.getCell(column, cell);
		if (!current || current.getWidth() === 0) continue;
		const style = cellStyle(current);
		if (style !== activeStyle) {
			result += style ? `\x1b[0;${style}m` : "\x1b[0m";
			activeStyle = style;
		}
		result += current.isInvisible() ? " " : current.getChars() || " ";
	}
	if (cursorColumn === lastCell + 1) result += CURSOR_MARKER;
	if (activeStyle) result += "\x1b[0m";
	return result;
}

/** Only these inert visual attributes can be replayed into Pi's renderer. */
function cellStyle(cell: IBufferCell): string {
	if (cell.isAttributeDefault()) return "";
	const codes: number[] = [];
	if (cell.isBold()) codes.push(1);
	if (cell.isDim()) codes.push(2);
	if (cell.isItalic()) codes.push(3);
	if (cell.isUnderline()) codes.push(4);
	if (cell.isInverse()) codes.push(7);
	if (cell.isInvisible()) codes.push(8);
	if (cell.isStrikethrough()) codes.push(9);
	if (cell.isOverline()) codes.push(53);
	appendColor(codes, cell.getFgColor(), cell.isFgRGB(), cell.isFgPalette(), false);
	appendColor(codes, cell.getBgColor(), cell.isBgRGB(), cell.isBgPalette(), true);
	return codes.join(";");
}

function appendColor(codes: number[], color: number, rgb: boolean, palette: boolean, background: boolean): void {
	if (rgb) {
		codes.push(background ? 48 : 38, 2, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
		return;
	}
	if (!palette) return;
	if (color < 8) {
		codes.push((background ? 40 : 30) + color);
		return;
	}
	if (color < 16) {
		codes.push((background ? 100 : 90) + color - 8);
		return;
	}
	codes.push(background ? 48 : 38, 5, color);
}

function clampDimension(value: number, maximum: number): number {
	return Math.min(maximum, Math.max(1, Math.floor(Number.isFinite(value) ? value : 1)));
}

function clampNonNegative(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
	return Math.min(maximum, Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)));
}
