import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { icon, type TuiIconName } from "../decoration/glyphs.ts";
import { renderPill } from "../decoration/powerline-pill.ts";
import type { TuiMouseEvent } from "../mouse.ts";

/** One selectable item rendered by a {@link TabBar}. */
export interface Tab {
	/** Stable value reported to {@link TabBar.onChange} when the tab is selected. */
	id: string;
	/** Human-readable text rendered after the optional icon. */
	label: string;
	/** Semantic icon resolved from the active pi-libtui icon pack on each render. */
	icon?: TuiIconName | { readonly glyph: string };
}

/**
 * A single-line tab selector with keyboard, hover, and primary-click navigation.
 *
 * Tab icons are semantic and therefore follow live pi-libtui appearance changes.
 */
export class TabBar implements Component {
	private activeIndex: number;
	private hoverIndex: number | undefined;
	private hoverCloseIndex: number | undefined;
	private pressedIndex: number | undefined;
	private pressedClose = false;
	private dragTargetIndex: number | undefined;
	private renderedTabs: Array<{ index: number; x: number; width: number; closeX?: number; closeWidth?: number }> = [];
	/** Called after the active tab changes, with the selected tab and its zero-based index. */
	onChange?: (tab: Tab, index: number) => void;
	/** Called when a tab's shared close affordance is clicked. Defining it enables closing every tab. */
	onClose?: (tab: Tab, index: number) => void;
	/** Called after a primary-button drag requests a new zero-based tab position. */
	onMove?: (tab: Tab, fromIndex: number, toIndex: number) => void;

	/**
	 * Creates a tab bar.
	 *
	 * @param tabs Ordered tabs to render and navigate. The array is not mutated.
	 * @param theme Pi theme used through pi-libtui's semantic color adapter.
	 * @param initialIndex Initially active zero-based tab index. Values outside the tab range are clamped.
	 */
	constructor(
		private readonly tabs: readonly Tab[],
		private readonly theme: Theme,
		initialIndex = 0,
	) {
		this.activeIndex = Math.max(0, Math.min(initialIndex, tabs.length - 1));
	}

	/**
	 * Handles left/right arrows and Vim-style `h`/`l` navigation.
	 *
	 * @param data Raw terminal input sequence.
	 * @returns `true` when the input is a supported navigation key, even if selection cannot change.
	 */
	handleInput(data: string): boolean {
		if (matchesKey(data, "right") || data === "l") {
			this.select((this.activeIndex + 1) % this.tabs.length);
			return true;
		}
		if (matchesKey(data, "left") || data === "h") {
			this.select((this.activeIndex - 1 + this.tabs.length) % this.tabs.length);
			return true;
		}
		return false;
	}

	/**
	 * Updates hover state and selects a tab on a primary-button release.
	 *
	 * Call {@link render} before routing pointer events so visible tab geometry is available.
	 *
	 * @param event Pointer event in coordinates local to the tab bar.
	 * @returns `true` when the event hits a rendered tab; leave events clear hover and return `false`.
	 */
	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "leave") {
			this.hoverIndex = undefined;
			this.hoverCloseIndex = undefined;
			if (event.button === undefined) {
				this.pressedIndex = undefined;
				this.pressedClose = false;
				this.dragTargetIndex = undefined;
			}
			return false;
		}
		const hit =
			event.row === 0
				? this.renderedTabs.find((tab) => event.col >= tab.x && event.col < tab.x + tab.width)
				: undefined;
		this.hoverIndex = hit?.index;
		const closeHit =
			hit?.closeX !== undefined &&
			hit.closeWidth !== undefined &&
			event.col >= hit.closeX &&
			event.col < hit.closeX + hit.closeWidth;
		this.hoverCloseIndex = closeHit ? hit.index : undefined;
		if (event.type === "press" && event.button === 0 && hit) {
			this.pressedIndex = hit.index;
			this.pressedClose = closeHit;
			this.dragTargetIndex = hit.index;
			return true;
		}
		if (event.type === "drag" && event.button === 0 && hit && this.pressedIndex !== undefined) {
			this.dragTargetIndex = hit.index;
			return true;
		}
		if (event.type === "release" && event.button === 0 && hit) {
			const from = this.pressedIndex;
			const tab = this.tabs[from ?? hit.index];
			if (tab && from !== undefined && this.pressedClose && closeHit && from === hit.index) {
				this.onClose?.(tab, from);
			} else if (tab && from !== undefined && this.dragTargetIndex !== undefined && from !== this.dragTargetIndex) {
				this.onMove?.(tab, from, this.dragTargetIndex);
			} else if (from === undefined && closeHit) {
				const direct = this.tabs[hit.index];
				if (direct) this.onClose?.(direct, hit.index);
			} else this.select(hit.index);
			this.pressedIndex = undefined;
			this.pressedClose = false;
			this.dragTargetIndex = undefined;
		}
		return hit !== undefined;
	}

	/** Clears cached pointer geometry. A later {@link render} rebuilds it. */
	invalidate(): void {
		this.renderedTabs = [];
	}

	/**
	 * Renders the tab bar as one terminal line and records geometry for pointer handling.
	 *
	 * @param width Maximum terminal-cell width. Negative and fractional values are normalized.
	 * @returns A one-element array containing the truncated, ANSI-styled tab line.
	 */
	render(width: number): string[] {
		const colors = tuiTheme(this.theme);
		const chunks = this.tabs.map((tab, index) => {
			const active = index === this.activeIndex;
			const close = closeGlyph
				? ` ${colors.fg(index === this.hoverCloseIndex ? "accent" : "text.muted", closeGlyph)} `
				: "";
			return renderPill(
				this.theme,
				{ icon: tab.icon ?? false, label: `${tab.label}${close}` },
				active ? "surface.selected" : index === this.hoverIndex ? "surface.hover" : "surface.raised",
				active ? "accent" : "text.secondary",
				undefined,
				"\x1b[49m",
			);
		});
		const boundedWidth = Math.max(0, Math.floor(width));
		let x = 0;
		this.renderedTabs = this.tabs.flatMap((_tab, index) => {
			const tabWidth = visibleWidth(chunks[index] ?? "");
			const renderedWidth = Math.max(0, Math.min(tabWidth, boundedWidth - x));
			const closeWidth = closeGlyph ? visibleWidth(closeGlyph) : undefined;
			const closeX = closeGlyph ? x + tabWidth - 2 - visibleWidth(closeGlyph) : undefined;
			const span =
				renderedWidth > 0
					? [
							{
								index,
								x,
								width: renderedWidth,
								...(closeX !== undefined && closeWidth !== undefined && closeX + closeWidth <= x + renderedWidth
									? { closeX, closeWidth }
									: {}),
							},
						]
					: [];
			x += tabWidth + 1;
			return span;
		});
		return [`\x1b[49m${truncateToWidth(chunks.join(" "), boundedWidth, "")}\x1b[49m`];
	}

	private select(index: number): void {
		if (this.tabs.length === 0 || index === this.activeIndex) return;
		this.activeIndex = index;
		const tab = this.tabs[index];
		if (tab) this.onChange?.(tab, index);
	}
}
