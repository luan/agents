import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "../mouse.ts";
import { getTuiRenderEpoch } from "../render-epoch.ts";
import { applyScrollbar } from "../scrollbar.ts";

/** Shared bounded payload viewport for every expanded mode. */
export class ExpandedRegionViewport implements Component {
	private maxHeight: number;
	private readonly allowGrowth: boolean;
	private scrollTop = 0;
	private renderedWidth = 0;
	private renderedBodyHeight = 0;
	private renderedContentHeight = 0;
	private cachedWidth = -1;
	private cachedEpoch = -1;
	private cachedLines: string[] | undefined;

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
		const epoch = getTuiRenderEpoch();
		if (this.cachedWidth !== this.renderedWidth || this.cachedEpoch !== epoch || !this.cachedLines) {
			this.cachedWidth = this.renderedWidth;
			this.cachedEpoch = epoch;
			this.cachedLines = this.renderSource(this.renderedWidth);
		}
		const lines = this.cachedLines;
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
		if (event.type !== "wheel" || event.wheel === undefined) return false;
		return this.scrollBy(event.wheel === -1 ? -3 : 3);
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = -1;
		this.cachedEpoch = -1;
	}

	scrollToStart(): void {
		this.scrollTop = 0;
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
