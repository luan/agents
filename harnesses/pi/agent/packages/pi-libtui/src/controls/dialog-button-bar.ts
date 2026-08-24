import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeyId, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getTuiAppearance } from "../appearance.ts";
import { type TuiBackgroundToken, type TuiForegroundToken, tuiTheme } from "../color/theme.ts";
import { icon, keyHintGlyph, keyIcon, type TuiIconName } from "../decoration/glyphs.ts";
import { renderPill } from "../decoration/powerline-pill.ts";
import type { TuiMouseEvent } from "../mouse.ts";
import type { ActionPanelMouseEvent, ActionPanelRect } from "./action-panel.ts";

/** One action rendered by {@link DialogButtonBar}. */
export interface DialogButtonSpec<Value extends string = string> {
	/** Stable value passed to the activation callback. */
	value: Value;
	/** Static label or lazy label read on each render. */
	label: string | (() => string);
	/** Semantic icon resolved from the active pi-libtui appearance pack. */
	icon?: TuiIconName;
	/** Semantic foreground token for the label and icon. */
	foreground: TuiForegroundToken;
	/** Semantic background token for the resting button surface. */
	background: TuiBackgroundToken;
	/** User-configured shortcuts; the first is displayed and every shortcut activates. */
	shortcuts?: readonly KeyId[];
	/** Start buttons grow from the left; end buttons grow from the right. */
	align?: "start" | "end";
}

/** Interactive geometry and identity for one rendered dialog button. */
export interface DialogButtonGeometry<Value extends string = string> extends ActionPanelRect {
	/** Zero-based index in the configured button list. */
	index: number;
	/** Stable value associated with the button. */
	value: Value;
}

/** Geometry for the most recent dialog-button-bar render. */
export interface DialogButtonBarGeometry<Value extends string = string> extends ActionPanelRect {
	/** Interactive geometry for each button that fit in the row. */
	buttons: readonly DialogButtonGeometry<Value>[];
}

/** Construction options for {@link DialogButtonBar}. */
export interface DialogButtonBarOptions<Value extends string> {
	/** Active Pi theme used to derive semantic libtui colors. */
	theme: Theme;
	/** Buttons in source order; alignment determines their rendered edge. */
	buttons: readonly DialogButtonSpec<Value>[];
	/** Gap between buttons in terminal cells; defaults to one. */
	gap?: number;
	/** Optional content fitted into the space before the end-aligned actions. */
	leading?: (width: number) => string;
	/** Request a host render after hover or press state changes. */
	requestRender(): void;
	/** Receive the stable value of a clicked button or matched shortcut. */
	onActivate(value: Value): void;
}

/** A domain-free, one-row dialog action bar with structural pointer handling. */
export class DialogButtonBar<Value extends string = string> implements Component {
	private hoverIndex: number | undefined;
	private pressedIndex: number | undefined;
	private geometry: DialogButtonBarGeometry<Value> | undefined;

	/**
	 * Create a dialog action row.
	 * @param config Theme, actions, layout options, and activation callback.
	 */
	constructor(private readonly config: DialogButtonBarOptions<Value>) {}

	/**
	 * Match and activate a configured keyboard shortcut.
	 * @param data Raw terminal input from Pi.
	 * @returns True when a button shortcut consumed the input.
	 */
	handleInput(data: string): boolean {
		const index = this.config.buttons.findIndex((button) => button.shortcuts?.some((key) => matchesKey(data, key)));
		if (index < 0) return false;
		this.activate(index);
		return true;
	}

	/**
	 * Handle pointer input expressed in button-bar-local coordinates.
	 * @param event Pointer lifecycle event to route to buttons.
	 * @returns True when the pointer is over a rendered button.
	 */
	handleMouse(event: ActionPanelMouseEvent): boolean {
		if (event.type === "leave") {
			const changed = this.hoverIndex !== undefined || this.pressedIndex !== undefined;
			this.hoverIndex = undefined;
			this.pressedIndex = undefined;
			if (changed) this.config.requestRender();
			return false;
		}

		const geometry = this.geometry;
		if (!geometry) return false;
		const button = geometry.buttons.find(
			(candidate) =>
				event.col >= candidate.x &&
				event.col < candidate.x + candidate.width &&
				event.row >= candidate.y &&
				event.row < candidate.y + candidate.height,
		);
		this.updateHover(button?.index);

		if (event.type === "press" && (event.button === undefined || event.button === 0)) {
			this.pressedIndex = button?.index;
		} else if (event.type === "release" && (event.button === undefined || event.button === 0)) {
			const pressed = this.pressedIndex;
			this.pressedIndex = undefined;
			if (button && pressed === button.index) this.activate(button.index);
		}
		return button !== undefined;
	}

	/**
	 * Structural pointer entry point used by pi-libtui's shared component host.
	 * @param event Component-local pointer event from the shared host.
	 * @returns True when a supported event targets a rendered button.
	 */
	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "drag" || event.type === "wheel") return false;
		return this.handleMouse({
			type: event.type,
			row: event.row,
			col: event.col,
			button: event.button,
		});
	}

	/** @returns A defensive copy of the latest button geometry, if rendered. */
	getGeometry(): DialogButtonBarGeometry<Value> | undefined {
		if (!this.geometry) return undefined;
		return {
			...this.geometry,
			buttons: this.geometry.buttons.map((button) => ({ ...button })),
		};
	}

	/** Clear cached button geometry after external state changes. */
	invalidate(): void {
		this.geometry = undefined;
	}

	/**
	 * Render one action row and update its interactive geometry.
	 * @param width Available width in terminal cells.
	 * @returns One rendered row, or no rows when width is zero.
	 */
	render(width: number): string[] {
		const boundedWidth = Math.max(0, Math.floor(width));
		if (boundedWidth === 0) {
			this.geometry = undefined;
			return [];
		}
		const gap = Math.max(0, Math.floor(this.config.gap ?? 1));
		const cells = Array.from({ length: boundedWidth }, () => " ");
		const geometry: DialogButtonGeometry<Value>[] = [];
		let startX = 0;
		let endX = boundedWidth;

		for (const [index, button] of this.config.buttons.entries()) {
			if ((button.align ?? "end") !== "start") continue;
			const label = ` ${plainLabel(button)} `;
			const labelWidth = visibleWidth(label);
			const buttonWidth = buttonWidthFor(labelWidth);
			if (startX + buttonWidth > endX) continue;
			cells[startX] = this.renderButton(button, index, fitLabel(label, labelWidth));
			for (let offset = 1; offset < buttonWidth; offset += 1) cells[startX + offset] = "";
			geometry.push({
				x: startX,
				y: 0,
				width: buttonWidth,
				height: 1,
				index,
				value: button.value,
			});
			startX += buttonWidth + gap;
		}

		for (const [index, button] of [...this.config.buttons.entries()].reverse()) {
			if ((button.align ?? "end") !== "end") continue;
			const label = ` ${plainLabel(button)} `;
			const labelWidth = visibleWidth(label);
			const buttonWidth = buttonWidthFor(labelWidth);
			const x = endX - buttonWidth;
			if (x < startX) continue;
			cells[x] = this.renderButton(button, index, fitLabel(label, labelWidth));
			for (let offset = 1; offset < buttonWidth; offset += 1) cells[x + offset] = "";
			geometry.push({
				x,
				y: 0,
				width: buttonWidth,
				height: 1,
				index,
				value: button.value,
			});
			endX = x - gap;
		}

		const leadingWidth = Math.max(0, endX - startX);
		if (this.config.leading && leadingWidth > 0) {
			const content = truncateToWidth(this.config.leading(leadingWidth), leadingWidth, "");
			cells[startX] = content;
			for (let offset = 1; offset < visibleWidth(content); offset += 1) cells[startX + offset] = "";
		}

		geometry.sort((left, right) => left.x - right.x);
		this.geometry = {
			x: 0,
			y: 0,
			width: boundedWidth,
			height: 1,
			buttons: geometry,
		};
		return [cells.join("")];
	}

	private renderButton(button: DialogButtonSpec<Value>, index: number, label: string): string {
		const colors = tuiTheme(this.config.theme);
		const hovered = index === this.hoverIndex || index === this.pressedIndex;
		const background = hovered ? colors.contrastBackground(colors.color(button.background)) : button.background;
		const shortcut = button.shortcuts?.[0];
		const renderedLabel = shortcut ? label.replace(shortcutSuffix(shortcut), keyHintGlyph(shortcut)) : label;
		if (getTuiAppearance().powerlineButtons) {
			return renderPill(
				this.config.theme,
				{ icon: false, label: renderedLabel },
				background,
				button.foreground,
				undefined,
				undefined,
				true,
			);
		}
		const foreground = colors.fg(button.foreground, renderedLabel);
		return colors.bg(background, foreground);
	}

	private updateHover(index: number | undefined): void {
		if (this.hoverIndex === index) return;
		this.hoverIndex = index;
		this.config.requestRender();
	}

	private activate(index: number): void {
		const button = this.config.buttons[index];
		if (button) this.config.onActivate(button.value);
	}
}

function fitLabel(label: string, width: number): string {
	return truncateToWidth(label, width, "") + " ".repeat(Math.max(0, width - visibleWidth(label)));
}

function buttonWidthFor(labelWidth: number): number {
	return labelWidth + (getTuiAppearance().powerlineButtons ? 2 : 0);
}

function plainLabel(button: DialogButtonSpec): string {
	const label = typeof button.label === "function" ? button.label() : button.label;
	const content = button.icon ? `${icon(button.icon)} ${label}` : label;
	const shortcut = button.shortcuts?.[0];
	return shortcut ? `${content} ${shortcutSuffix(shortcut)}` : content;
}

function shortcutSuffix(shortcut: KeyId): string {
	return keyIcon(shortcut);
}
