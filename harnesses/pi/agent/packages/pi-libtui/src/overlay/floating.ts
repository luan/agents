import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, compositeTuiLine, type Focusable, isFocusable } from "@earendil-works/pi-tui";
import { BackgroundSurface } from "../background-surface.ts";
import type { TuiBackgroundToken } from "../color/theme.ts";
import type { TuiMouseEvent } from "../mouse.ts";

type PointerComponent = Component & { onMouse?(event: TuiMouseEvent): boolean; dispose?(): void };
type HeightAwareComponent = Component & { setMaxHeight?(height: number): void };

export interface FloatingOverlayOptions {
	readonly base: Component;
	readonly overlay: Component;
	readonly overlayWidth: (availableWidth: number) => number;
	readonly align?: "start" | "end";
	readonly maxHeight?: () => number;
	readonly surface?: { readonly theme: Theme; readonly background: TuiBackgroundToken };
}

/** Composites a focus-owning child over ordinary content and owns its pointer geometry. */
export class FloatingOverlay implements Component, Focusable {
	private readonly renderedOverlay: Component;
	private overlayX = 0;
	private overlayWidth = 0;
	private overlayHeight = 0;

	constructor(private readonly options: FloatingOverlayOptions) {
		this.renderedOverlay = options.surface
			? new BackgroundSurface({
					theme: options.surface.theme,
					component: options.overlay,
					background: options.surface.background,
				})
			: options.overlay;
	}

	get focused(): boolean {
		return isFocusable(this.options.overlay) && this.options.overlay.focused;
	}

	set focused(value: boolean) {
		if (isFocusable(this.options.overlay)) this.options.overlay.focused = value;
		if (isFocusable(this.options.base)) this.options.base.focused = false;
	}

	handleInput(data: string): void {
		this.options.overlay.handleInput?.(data);
	}

	onMouse(event: TuiMouseEvent): boolean {
		const overlay = this.options.overlay as PointerComponent;
		const base = this.options.base as PointerComponent;
		if (event.type === "leave") {
			overlay.onMouse?.(event);
			return base.onMouse?.(event) === true;
		}
		if (
			event.col >= this.overlayX &&
			event.col < this.overlayX + this.overlayWidth &&
			event.row >= 0 &&
			event.row < this.overlayHeight
		)
			return overlay.onMouse?.({ ...event, col: event.col - this.overlayX }) === true;
		return base.onMouse?.(event) === true;
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(0, Math.floor(width));
		const base = this.options.base.render(boundedWidth);
		if (boundedWidth === 0) return base;
		this.overlayWidth = Math.max(1, Math.min(boundedWidth, Math.floor(this.options.overlayWidth(boundedWidth))));
		this.overlayX = this.options.align === "start" ? 0 : boundedWidth - this.overlayWidth;
		const maxHeight = this.options.maxHeight?.();
		if (maxHeight !== undefined)
			(this.options.overlay as HeightAwareComponent).setMaxHeight?.(Math.max(0, Math.floor(maxHeight)));
		const overlay = this.renderedOverlay.render(this.overlayWidth);
		this.overlayHeight = overlay.length;
		return Array.from({ length: Math.max(base.length, overlay.length) }, (_, row) => {
			const line = base[row] ?? "";
			const floating = overlay[row];
			return floating === undefined
				? line
				: compositeTuiLine(line, floating, this.overlayX, this.overlayWidth, boundedWidth);
		});
	}

	invalidate(): void {
		this.options.base.invalidate();
		this.renderedOverlay.invalidate();
	}

	dispose(): void {
		(this.options.base as PointerComponent).dispose?.();
		(this.options.overlay as PointerComponent).dispose?.();
	}
}
