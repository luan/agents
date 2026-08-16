import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { type IBufferCell, type IBufferLine, Terminal } from "@xterm/headless";

const MIN_RENDER_INTERVAL_MS = 40;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 5_000;

/**
 * Owns terminal emulation for one PTY process.
 *
 * The PTY bytes stay separate from the normalized output used by tool results.
 */
export class TerminalProjection {
	private readonly terminal: Terminal;
	private readonly parsedSubscription: { dispose(): void };
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private lastRenderAt = 0;
	private disposed = false;

	constructor(
		private readonly requestRender: () => void,
		cols = DEFAULT_COLS,
		rows = DEFAULT_ROWS,
	) {
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols: clampDimension(cols),
			rows: clampDimension(rows),
			scrollback: DEFAULT_SCROLLBACK,
		});
		this.parsedSubscription = this.terminal.onWriteParsed(() => this.scheduleRender());
	}

	get cols(): number {
		return this.terminal.cols;
	}

	get rows(): number {
		return this.terminal.rows;
	}

	write(data: string): void {
		if (this.disposed) return;
		this.terminal.write(data);
	}

	resize(cols: number, rows: number): boolean {
		if (this.disposed) return false;
		const nextCols = clampDimension(cols);
		const nextRows = clampDimension(rows);
		if (nextCols === this.terminal.cols && nextRows === this.terminal.rows) return false;
		this.terminal.resize(nextCols, nextRows);
		return true;
	}

	renderLines(): string[] {
		const buffer = this.terminal.buffer.active;
		const cursorLine = buffer.baseY + buffer.cursorY;
		const lines: string[] = [];
		for (let row = 0; row < this.terminal.rows; row += 1) {
			const bufferRow = buffer.viewportY + row;
			const cursorColumn = bufferRow === cursorLine ? buffer.cursorX : undefined;
			lines.push(projectLine(buffer.getLine(bufferRow), this.terminal.cols, cursorColumn));
		}
		return lines;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		this.parsedSubscription.dispose();
		this.terminal.dispose();
	}

	private scheduleRender(): void {
		if (this.disposed || this.renderTimer) return;
		const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - (Date.now() - this.lastRenderAt));
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.lastRenderAt = Date.now();
			this.requestRender();
		}, delay);
		this.renderTimer.unref();
	}
}

function projectLine(line: IBufferLine | undefined, cols: number, cursorColumn: number | undefined): string {
	let lastCell = cursorColumn ?? -1;
	if (line) {
		for (let column = 0; column < cols; column += 1) {
			const cell = line.getCell(column);
			if (cell && cell.getWidth() > 0 && (cell.getChars().length > 0 || !cell.isAttributeDefault()))
				lastCell = column;
		}
	}

	let result = "";
	let activeStyle = "";
	for (let column = 0; column <= lastCell; column += 1) {
		if (column === cursorColumn) result += CURSOR_MARKER;
		const cell = line?.getCell(column);
		if (!cell || cell.getWidth() === 0) continue;
		const style = cellStyle(cell);
		if (style !== activeStyle) {
			result += style ? `\u001b[0;${style}m` : "\u001b[0m";
			activeStyle = style;
		}
		result += cell.isInvisible() ? " " : cell.getChars() || " ";
	}
	if (cursorColumn === lastCell + 1) result += CURSOR_MARKER;
	if (activeStyle) result += "\u001b[0m";
	return result;
}

function cellStyle(cell: IBufferCell): string {
	const codes: number[] = [];
	if (cell.isBold()) codes.push(1);
	if (cell.isDim()) codes.push(2);
	if (cell.isItalic()) codes.push(3);
	if (cell.isUnderline()) codes.push(4);
	if (cell.isBlink()) codes.push(5);
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

function clampDimension(value: number): number {
	return Math.max(1, Math.floor(value));
}
