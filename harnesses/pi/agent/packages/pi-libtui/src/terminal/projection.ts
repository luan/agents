import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { type IBufferCell, type IBufferLine, Terminal } from "@xterm/headless";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 5_000;
const DEFAULT_REPAINT_INTERVAL_MS = 40;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const MAX_SCROLLBACK = 10_000;

// type-boundary: @xterm/headless 6 keeps synchronous writes on its private core
// even though the public Terminal type omits it. Use that installed runtime
// seam only for the first snapshot; remove it when Terminal exposes writeSync.
type SyncWriteTerminal = Terminal & {
	_core?: { _writeBuffer?: { writeSync?: (data: string | Uint8Array) => void } };
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
	private contentEndRow = 0;
	private hasParsedWrite = false;
	private initialRepaintPending = false;

	constructor(options: TerminalProjectionOptions) {
		this.requestRender = options.requestRender;
		this.scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
		this.repaintIntervalMs = clampNonNegative(options.repaintIntervalMs ?? DEFAULT_REPAINT_INTERVAL_MS);
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols: clampDimension(options.cols ?? DEFAULT_COLS, MAX_COLS),
			rows: clampDimension(options.rows ?? DEFAULT_ROWS, MAX_ROWS),
			scrollback: clampNonNegative(options.scrollback ?? DEFAULT_SCROLLBACK, MAX_SCROLLBACK),
			convertEol: false,
		});
		this.parsedSubscription = this.terminal.onWriteParsed(() => {
			this.markParsed();
		});
	}

	get cols(): number {
		return this.terminal.cols;
	}

	get rows(): number {
		return this.terminal.rows;
	}

	/** Parse the first snapshot before an unrelated host repaint can see an empty surface. */
	write(data: string | Uint8Array): void {
		if (this.disposed || data.length === 0) return;
		if (!this.hasParsedWrite) {
			const writeBuffer = (this.terminal as SyncWriteTerminal)._core?._writeBuffer;
			const writeSync = writeBuffer?.writeSync;
			if (writeBuffer && writeSync) {
				writeSync.call(writeBuffer, data);
				this.hasParsedWrite = true;
				this.markParsed(false);
				this.initialRepaintPending = true;
				queueMicrotask(() => {
					if (this.disposed || !this.initialRepaintPending) return;
					this.initialRepaintPending = false;
					this.scheduleRender();
				});
				return;
			}
		}
		this.initialRepaintPending = false;
		this.terminal.write(data);
		this.hasParsedWrite = true;
	}

	/** Resolve after every previously queued write has been parsed. */
	drain(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return new Promise((resolve) => this.terminal.write("", resolve));
	}

	resize(cols: number, rows: number): boolean {
		if (this.disposed) return false;
		const nextCols = clampDimension(cols, MAX_COLS);
		const nextRows = clampDimension(rows, MAX_ROWS);
		if (nextCols === this.terminal.cols && nextRows === this.terminal.rows) return false;
		this.terminal.resize(nextCols, nextRows);
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
			const cursorColumn = options.cursor !== false && bufferRow === cursorLine ? buffer.cursorX : undefined;
			lines.push(projectLine(buffer.getLine(bufferRow), this.terminal.cols, cursorColumn, cell));
		}
		this.renderedRevision = this.bufferRevision;
		this.renderedKey = cacheKey;
		this.renderedLines = lines;
		return lines;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.initialRepaintPending = false;
		this.repaintTimer?.dispose();
		this.repaintTimer = undefined;
		this.parsedSubscription.dispose();
		this.terminal.dispose();
		this.renderedLines = undefined;
	}

	private markParsed(schedule = true): void {
		const buffer = this.terminal.buffer.active;
		this.contentEndRow = Math.max(this.contentEndRow, buffer.baseY + buffer.cursorY);
		this.bufferRevision += 1;
		if (schedule) this.scheduleRender();
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
