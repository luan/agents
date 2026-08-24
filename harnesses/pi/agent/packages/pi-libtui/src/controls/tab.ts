import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { icon, type TuiIconName } from "../decoration/glyphs.ts";
import type { TuiMouseEvent } from "../mouse.ts";

/** One selectable item rendered by a {@link TabBar}. */
export interface Tab {
	/** Stable value reported to {@link TabBar.onChange} when the tab is selected. */
	id: string;
	/** Human-readable text rendered after the optional icon. */
	label: string;
	/** Semantic icon resolved from the active pi-libtui icon pack on each render. */
	icon?: TuiIconName;
}

function tabLabel(tab: Tab): string {
	return tab.icon ? `${icon(tab.icon)} ${tab.label}` : tab.label;
}

/**
 * A single-line tab selector with keyboard, hover, and primary-click navigation.
 *
 * Tab icons are semantic and therefore follow live pi-libtui appearance changes.
 */
export class TabBar implements Component {
	private activeIndex: number;
	private hoverIndex: number | undefined;
	private renderedTabs: Array<{ index: number; x: number; width: number }> = [];
	/** Called after the active tab changes, with the selected tab and its zero-based index. */
	onChange?: (tab: Tab, index: number) => void;

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
			return false;
		}
		const hit =
			event.row === 0
				? this.renderedTabs.find((tab) => event.col >= tab.x && event.col < tab.x + tab.width)
				: undefined;
		this.hoverIndex = hit?.index;
		if (event.type === "release" && event.button === 0 && hit) this.select(hit.index);
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
			const label = ` ${tabLabel(tab)} `;
			return index === this.activeIndex
				? colors.bg("surface.selected", colors.fg("accent", label))
				: index === this.hoverIndex
					? colors.bg("surface.hover", colors.fg("text.secondary", label))
					: colors.fg("text.secondary", label);
		});
		const boundedWidth = Math.max(0, Math.floor(width));
		let x = 0;
		this.renderedTabs = this.tabs.flatMap((tab, index) => {
			const tabWidth = visibleWidth(` ${tabLabel(tab)} `);
			const renderedWidth = Math.max(0, Math.min(tabWidth, boundedWidth - x));
			const span = renderedWidth > 0 ? [{ index, x, width: renderedWidth }] : [];
			x += tabWidth + 2;
			return span;
		});
		return [`\x1b[49m${truncateToWidth(chunks.join("  "), boundedWidth, "")}\x1b[49m`];
	}

	private select(index: number): void {
		if (this.tabs.length === 0 || index === this.activeIndex) return;
		this.activeIndex = index;
		const tab = this.tabs[index];
		if (tab) this.onChange?.(tab, index);
	}
}
