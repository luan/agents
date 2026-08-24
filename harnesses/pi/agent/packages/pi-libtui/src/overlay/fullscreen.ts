import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	isFocusable,
	type OverlayOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { subscribeTuiAppearance } from "../appearance.ts";
import { tuiTheme } from "../color/theme.ts";
import { resolveTuiTitle, type TuiTitleSource } from "../decoration/status.ts";
import { fitLine } from "../line-layout.ts";
import type { TuiMouseEvent } from "../mouse.ts";

type PointerComponent = Component & {
	onMouse?: (event: TuiMouseEvent) => boolean;
};

/**
 * Returns Pi overlay options that cover the terminal from its top-left corner.
 *
 * @returns Full-width, full-height, zero-margin overlay options.
 */
export function fullscreenOverlayOptions(): OverlayOptions {
	return {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
	};
}

function topBorder(theme: Theme, title: string, width: number): string {
	const colors = tuiTheme(theme);
	const visibleTitle = truncateToWidth(title, Math.max(0, width - 5), "");
	const label = visibleTitle ? ` ${colors.fg("accent", visibleTitle)} ` : "";
	const used = 2 + visibleWidth(label) + 1;
	return colors.fg("border", "╭─") + label + colors.fg("border", `${"─".repeat(Math.max(0, width - used))}╮`);
}

/** Covers the terminal with a bordered component while leaving the host TUI alive. */
export class FullscreenOverlay implements Component, Focusable {
	private readonly removeAppearanceSubscription: () => void;
	private childWidth = 0;
	private childHeight = 0;
	private _focused = false;

	/**
	 * Creates a terminal-sized bordered host around a child component.
	 *
	 * @param tui Active Pi TUI whose terminal row count defines the overlay height.
	 * @param theme Pi theme used to derive semantic border and title colors.
	 * @param child Component rendered inside the one-cell frame.
	 * @param title Static or dynamic title source rendered in the top border.
	 */
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly child: Component,
		private readonly title: TuiTitleSource = "",
	) {
		this.removeAppearanceSubscription = subscribeTuiAppearance(() => this.tui.requestRender());
	}

	/** Whether this overlay and its focusable child own focus. */
	get focused(): boolean {
		return this._focused;
	}
	/**
	 * Transfers focus to or from the focusable child.
	 *
	 * @param value Whether the overlay should own focus.
	 */
	set focused(value: boolean) {
		this._focused = value;
		if (isFocusable(this.child)) this.child.focused = value;
	}

	/**
	 * Invalidates the child component when it supports invalidation.
	 *
	 * @returns Nothing.
	 */
	invalidate(): void {
		this.child.invalidate?.();
	}

	/**
	 * Releases the appearance subscription owned by this overlay.
	 *
	 * @returns Nothing.
	 */
	dispose(): void {
		this.removeAppearanceSubscription();
	}

	/**
	 * Forwards raw terminal input to the child when it handles input.
	 *
	 * @param data Raw terminal input sequence from Pi.
	 * @returns Nothing.
	 */
	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	/**
	 * Translates a frame-local pointer event into child coordinates and dispatches it.
	 *
	 * @param event Pointer event expressed in overlay-local coordinates.
	 * @returns Whether the child handled the event; modal selection gestures are consumed anywhere inside the overlay.
	 */
	onMouse(event: TuiMouseEvent): boolean {
		const blocksSelection = event.type === "press" || event.type === "drag" || event.type === "release";
		const child = this.child as PointerComponent;
		if (typeof child.onMouse !== "function") return blocksSelection;
		const translated = { ...event, row: event.row - 1, col: event.col - 1 };
		if (
			event.type !== "leave" &&
			(translated.row < 0 ||
				translated.row >= this.childHeight ||
				translated.col < 0 ||
				translated.col >= this.childWidth)
		)
			return blocksSelection;
		try {
			return Reflect.apply(child.onMouse, child, [translated]) === true || blocksSelection;
		} catch {
			return blocksSelection;
		}
	}

	/**
	 * Renders a border and pads or clips the child to the current terminal height.
	 *
	 * @param width Available terminal width in columns.
	 * @returns Exactly `tui.terminal.rows` rows when both dimensions can contain a frame, otherwise one blank fitted row.
	 */
	render(width: number): string[] {
		const colors = tuiTheme(this.theme);
		const height = Math.max(1, this.tui.terminal.rows);
		if (width < 2 || height < 2) {
			this.childWidth = 0;
			this.childHeight = 0;
			return [fitLine("", width)];
		}
		const innerWidth = width - 2;
		const innerHeight = height - 2;
		this.childWidth = innerWidth;
		this.childHeight = innerHeight;
		const content = this.child.render(innerWidth).slice(0, innerHeight);
		while (content.length < innerHeight) content.push("");
		return [
			topBorder(this.theme, resolveTuiTitle(this.title), width),
			...content.map((line) => `${colors.fg("border", "│")}${fitLine(line, innerWidth)}${colors.fg("border", "│")}`),
			colors.fg("border", `╰${"─".repeat(innerWidth)}╯`),
		];
	}
}
