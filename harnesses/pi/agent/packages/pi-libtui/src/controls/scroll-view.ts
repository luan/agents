import { type Component, type Focusable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "../mouse.ts";

export interface ScrollViewOptions {
	renderContent: (width: number) => readonly string[];
	height?: number | (() => number);
	scrollbar?: boolean;
	requestRender?: () => void;
}

export interface ScrollViewGeometry {
	width: number;
	height: number;
	contentHeight: number;
	offset: number;
	maxOffset: number;
}

/** A bounded, focusable viewport with keyboard and pointer scrolling. */
export class ScrollView implements Component, Focusable {
	private _focused = false;
	private offset = 0;
	private geometry: ScrollViewGeometry | undefined;

	constructor(private readonly options: ScrollViewOptions) {}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		if (this._focused === value) return;
		this._focused = value;
		this.options.requestRender?.();
	}
	getOffset(): number {
		return this.offset;
	}
	getGeometry(): ScrollViewGeometry | undefined {
		return this.geometry && { ...this.geometry };
	}
	setOffset(offset: number): void {
		this.scrollTo(offset);
	}
	invalidate(): void {
		this.geometry = undefined;
	}

	handleInput(data: string): void {
		this.handleViewportInput(data);
	}
	handleViewportInput(data: string): boolean {
		const page = this.geometry?.height ?? 0;
		if (data === "j" || data === "\u001b[B") return this.scrollBy(1);
		if (data === "k" || data === "\u001b[A") return this.scrollBy(-1);
		if (data === " " || data === "\u001b[6~") return this.scrollBy(page);
		if (data === "\u001b[5~") return this.scrollBy(-page);
		if (data === "g" || data === "\u001b[H" || data === "\u001b[1~") return this.scrollTo(0);
		if (data === "G" || data === "\u001b[F" || data === "\u001b[4~")
			return this.scrollTo(this.geometry?.maxOffset ?? 0);
		return false;
	}

	onMouse(event: TuiMouseEvent): boolean {
		const geometry = this.geometry;
		if (
			event.type === "leave" ||
			!geometry ||
			event.row < 0 ||
			event.row >= geometry.height ||
			event.col < 0 ||
			event.col >= geometry.width
		)
			return false;
		if (event.type === "press" && event.button === 0) {
			this.focused = true;
			return true;
		}
		if (event.type === "wheel" && event.wheel) return this.scrollBy(event.wheel);
		return event.type === "move" || event.type === "press" || event.type === "release";
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(0, Math.floor(width));
		const configured = typeof this.options.height === "function" ? this.options.height() : this.options.height;
		const height = configured === undefined ? undefined : Math.max(0, Math.floor(configured));
		const scrollbar = this.options.scrollbar !== false && boundedWidth > 1;
		const contentWidth = scrollbar ? boundedWidth - 1 : boundedWidth;
		const content = this.options.renderContent(contentWidth).map((line) => truncateToWidth(line, contentWidth, ""));
		const viewportHeight = height ?? content.length;
		const maxOffset = Math.max(0, content.length - viewportHeight);
		this.offset = Math.min(this.offset, maxOffset);
		this.geometry = {
			width: boundedWidth,
			height: viewportHeight,
			contentHeight: content.length,
			offset: this.offset,
			maxOffset,
		};
		const lines = Array.from({ length: viewportHeight }, (_, row) => content[this.offset + row] ?? "");
		if (!scrollbar || maxOffset === 0)
			return lines.map((line) => `${line}${" ".repeat(Math.max(0, boundedWidth - visibleWidth(line)))}`);
		const thumbHeight = Math.max(1, Math.floor((viewportHeight * viewportHeight) / content.length));
		const track = viewportHeight - thumbHeight;
		const start = Math.floor((this.offset * track) / maxOffset);
		return lines.map(
			(line, row) =>
				`${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))}${row >= start && row < start + thumbHeight ? "█" : "│"}`,
		);
	}

	private scrollBy(delta: number): boolean {
		return this.scrollTo(this.offset + delta);
	}
	private scrollTo(offset: number): boolean {
		const next = Math.max(0, Math.min(Math.floor(Number.isFinite(offset) ? offset : 0), this.geometry?.maxOffset ?? 0));
		if (next === this.offset) return true;
		this.offset = next;
		if (this.geometry) this.geometry = { ...this.geometry, offset: next };
		this.options.requestRender?.();
		return true;
	}
}
