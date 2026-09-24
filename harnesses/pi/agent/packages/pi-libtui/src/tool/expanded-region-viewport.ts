import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "../mouse.ts";
import { applyScrollbar, scrollbarGeometry } from "../scrollbar.ts";

/** Shared bounded payload viewport for every expanded mode. */
export class ExpandedRegionViewport implements Component {
	private maxHeight: number;
	private readonly allowGrowth: boolean;
	private scrollTop = 0;
	private renderedWidth = 0;
	private renderedBodyHeight = 0;
	private renderedContentHeight = 0;
	private renderedContentWidth = 0;
	private dragOffset: number | undefined;

	constructor(
		private readonly renderSource: (width: number) => string[],
		maxHeight: number,
		allowGrowth: boolean,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
	) {
		this.maxHeight = Number.isFinite(maxHeight) ? Math.max(1, Math.floor(maxHeight)) : 20;
		this.allowGrowth = allowGrowth;
	}

	ensureMinimumHeight(rows: number): void {
		if (!this.allowGrowth || !Number.isFinite(rows)) return;
		this.maxHeight = Math.max(this.maxHeight, Math.max(1, Math.floor(rows)));
	}

	render(width: number): string[] {
		this.renderedWidth = Math.max(0, Math.floor(width));
		// Reserve the scrollbar lane before rendering, including nested scrollbars.
		this.renderedContentWidth = this.renderedWidth > 2 ? this.renderedWidth - 2 : this.renderedWidth;
		// Child controls can change independently; their renderers own content caching.
		const lines = this.renderSource(this.renderedContentWidth);
		this.renderedContentHeight = lines.length;
		this.renderedBodyHeight = this.maxHeight;
		const maxScrollTop = Math.max(0, lines.length - this.renderedBodyHeight);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScrollTop));
		const visible = lines.slice(this.scrollTop, this.scrollTop + this.renderedBodyHeight);
		return applyScrollbar(visible, {
			theme: this.theme,
			width: this.renderedWidth,
			height: this.renderedBodyHeight,
			offset: this.scrollTop,
			total: lines.length,
		});
	}

	get scrollOffset(): number {
		return this.scrollTop;
	}

	get contentWidth(): number {
		return this.renderedContentWidth;
	}

	get contentHeight(): number {
		return this.renderedContentHeight;
	}

	handleViewportInput(data: string): boolean {
		if (matchesKey(data, "up")) return this.scrollBy(-1);
		if (matchesKey(data, "down")) return this.scrollBy(1);
		if (matchesKey(data, "pageUp")) return this.scrollBy(-Math.max(1, this.renderedBodyHeight - 1));
		if (matchesKey(data, "pageDown")) return this.scrollBy(Math.max(1, this.renderedBodyHeight - 1));
		if (matchesKey(data, "home")) return this.scrollTo(0);
		if (matchesKey(data, "end")) return this.scrollTo(Number.MAX_SAFE_INTEGER);
		return false;
	}

	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "wheel" && event.wheel !== undefined) return this.scrollBy(event.wheel === -1 ? -3 : 3);
		const geometry = scrollbarGeometry(this.renderedBodyHeight, this.renderedContentHeight, this.scrollTop);
		if (this.dragOffset !== undefined) {
			if (event.type === "release") {
				this.dragOffset = undefined;
				return true;
			}
			if (event.type === "drag") {
				this.scrollTo(
					Math.round(((event.row - this.dragOffset) * geometry.maxOffset) / Math.max(1, geometry.trackHeight)),
				);
				return true;
			}
		}
		if (
			this.renderedWidth <= 1 ||
			geometry.maxOffset === 0 ||
			event.col !== this.renderedWidth - 1 ||
			event.row < 0 ||
			event.row >= this.renderedBodyHeight
		)
			return false;
		if (event.type !== "press" || event.button !== 0) return false;
		const onThumb = event.row >= geometry.thumbStart && event.row < geometry.thumbStart + geometry.thumbHeight;
		this.dragOffset = onThumb ? event.row - geometry.thumbStart : Math.floor(geometry.thumbHeight / 2);
		if (!onThumb)
			this.scrollTo(
				Math.round(((event.row - this.dragOffset) * geometry.maxOffset) / Math.max(1, geometry.trackHeight)),
			);
		return true;
	}

	capturesPointer(): boolean {
		return this.dragOffset !== undefined;
	}

	invalidate(): void {}

	scrollToStart(): void {
		this.scrollTop = 0;
		this.dragOffset = undefined;
	}

	private maxScrollTop(): number {
		return Math.max(0, this.renderedContentHeight - this.renderedBodyHeight);
	}

	private scrollTo(next: number): boolean {
		const clamped = Math.max(0, Math.min(this.maxScrollTop(), Math.floor(next)));
		if (clamped === this.scrollTop) return false;
		this.scrollTop = clamped;
		this.requestRender();
		return true;
	}

	private scrollBy(delta: number): boolean {
		return this.scrollTo(this.scrollTop + delta);
	}
}
