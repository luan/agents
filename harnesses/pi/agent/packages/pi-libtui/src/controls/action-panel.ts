import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type KeybindingsManager,
	type KeyId,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { renderKeyHint } from "../decoration/glyphs.ts";
import { fitLine } from "../line-layout.ts";

/** One selectable action displayed by {@link ActionPanel}. */
export interface ActionPanelOption<Value extends string = string> {
	/** Stable value passed to selection and activation callbacks. */
	value: Value;
	/** Human-readable action label. */
	label: string;
	/** Optional supporting text rendered after the label. */
	description?: string;
}

/** Layout and appearance available to a custom action-row renderer. */
export interface ActionPanelRowContext {
	/** Available row width in terminal cells. */
	width: number;
	/** Zero-based index in the complete option list. */
	index: number;
	/** One-based numeric shortcut, when numeric shortcuts are enabled. */
	shortcut?: number;
	/** Active Pi theme for non-color text attributes. */
	theme: Theme;
}

/** Overlay-local mouse input. Row and column are zero-based within the rendered panel. */
export interface ActionPanelMouseEvent {
	/** Pointer lifecycle event translated into panel-local coordinates. */
	type: "enter" | "move" | "leave" | "press" | "release";
	/** Zero-based row within the rendered panel. */
	row: number;
	/** Zero-based column within the rendered panel. */
	col: number;
	/** Zero-based mouse button for press and release events. */
	button?: 0 | 1 | 2;
}

/** Rectangular terminal-cell geometry. */
export interface ActionPanelRect {
	/** Zero-based column relative to the owning component. */
	x: number;
	/** Zero-based row relative to the owning component. */
	y: number;
	/** Width in terminal cells. */
	width: number;
	/** Height in terminal rows. */
	height: number;
}

/** Geometry and identity for one rendered action row. */
export interface ActionPanelRowGeometry<Value extends string = string> extends ActionPanelRect {
	/** Zero-based index in the complete option list. */
	index: number;
	/** Stable value associated with the row. */
	value: Value;
}

/** A single rendered row hosted inside an ActionPanel frame. */
export interface ActionPanelFooter {
	/** Render the footer within the supplied terminal-cell width. */
	render(width: number): string[];
	/** Clear cached footer layout after external state changes. */
	invalidate?(): void;
	/** Handle keyboard input; return true when the footer consumes it. */
	handleInput?(data: string): boolean | undefined;
	/** Handle footer-local pointer input; return true when consumed. */
	handleMouse?(event: ActionPanelMouseEvent): boolean;
}

/** Geometry for the most recent render, in coordinates local to its first cell. */
export interface ActionPanelGeometry<Value extends string = string> extends ActionPanelRect {
	/** Interactive geometry for each currently visible action row. */
	rows: readonly ActionPanelRowGeometry<Value>[];
	/** Footer geometry when the panel has a structural footer. */
	footer?: ActionPanelRect;
}

/** Construction options for {@link ActionPanel}. */
export interface ActionPanelOptions<Value extends string> {
	/** Active Pi theme used to derive semantic libtui colors. */
	theme: Theme;
	/** Pi keybinding manager used for navigation, confirmation, and cancellation. */
	keybindings: KeybindingsManager;
	/** Title rendered in the panel border. */
	title: string;
	/** Complete ordered set of selectable actions. */
	options: readonly ActionPanelOption<Value>[];
	/** Initially selected value; defaults to the first option. */
	selected?: Value;
	/** Maximum number of action rows displayed at once. */
	maxVisible?: number;
	/** Maximum panel width in terminal cells. */
	maxWidth?: number;
	/** Maximum panel height in terminal rows. */
	maxHeight?: number;
	/** Set false when the surrounding dialog already presents keyboard help. */
	showHint?: boolean;
	/** Replaces the hint with a separated, single-row structural footer. */
	footer?: ActionPanelFooter;
	/** Enable direct activation with the number keys 1 through 9. */
	numberShortcuts?: boolean;
	/** When false, a click only changes selection; Enter and number shortcuts still activate. */
	activateOnClick?: boolean;
	/** Text displayed when no actions are available. */
	emptyMessage?: string;
	/** Custom action-row renderer; output is fitted to the available width. */
	renderOption?: (option: ActionPanelOption<Value>, context: ActionPanelRowContext) => string;
	/** Request a host render after interactive state changes. */
	requestRender(): void;
	/** Receive selection changes that do not activate the action. */
	onSelectionChange?(value: Value): void;
	/** Receive the activated action value. */
	onSelect(value: Value): void;
	/** Close or dismiss the panel without activation. */
	onCancel(): void;
}

const MIN_WIDTH = 12;

/**
 * A compact, domain-free action picker for anchored overlays.
 *
 * The component deliberately does not know how the overlay is positioned.
 * Consumers translate screen mouse coordinates to overlay-local coordinates,
 * then pass them to handleMouse().
 */
export class ActionPanel<Value extends string = string> implements Component {
	private selectedIndex: number;
	private hoverIndex: number | undefined;
	private pressedIndex: number | undefined;
	private footerPointerInside = false;
	private geometry: ActionPanelGeometry<Value> | undefined;

	/**
	 * Create an action panel.
	 * @param config Actions, theme, interaction callbacks, and layout bounds.
	 */
	constructor(private readonly config: ActionPanelOptions<Value>) {
		const selected = config.options.findIndex((option) => option.value === config.selected);
		this.selectedIndex = selected >= 0 ? selected : 0;
	}

	/**
	 * Handle navigation, activation, cancellation, numeric shortcuts, and footer input.
	 * @param data Raw terminal input from Pi.
	 */
	handleInput(data: string): void {
		if (this.config.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || data === "q") {
			this.config.onCancel();
			return;
		}
		if (this.config.numberShortcuts && /^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			const option = this.config.options[index];
			if (option) this.config.onSelect(option.value);
			return;
		}
		if (data === "j" || this.config.keybindings.matches(data, "tui.select.down")) this.move(1);
		else if (data === "k" || this.config.keybindings.matches(data, "tui.select.up")) this.move(-1);
		else if (matchesKey(data, Key.home)) this.select(0);
		else if (data === "G" || matchesKey(data, Key.end)) this.select(this.config.options.length - 1);
		else if (this.config.keybindings.matches(data, "tui.select.confirm")) this.choose(this.selectedIndex);
		else this.config.footer?.handleInput?.(data);
	}

	/**
	 * Handle pointer input expressed in panel-local coordinates.
	 * @param event Pointer lifecycle event to route to rows or the footer.
	 * @returns True when the event belongs to the panel.
	 */
	handleMouse(event: ActionPanelMouseEvent): boolean {
		if (event.type === "leave") {
			const changed = this.hoverIndex !== undefined || this.pressedIndex !== undefined;
			this.hoverIndex = undefined;
			this.pressedIndex = undefined;
			this.leaveFooter(event);
			if (changed) this.config.requestRender();
			return false;
		}

		const geometry = this.geometry;
		if (!geometry) return false;
		const inside = event.col >= 0 && event.col < geometry.width && event.row >= 0 && event.row < geometry.height;
		if (!inside) {
			this.updateHover(undefined);
			this.leaveFooter(event);
			if (event.type === "release") this.pressedIndex = undefined;
			return false;
		}

		const footer = geometry.footer;
		if (
			footer &&
			event.col >= footer.x &&
			event.col < footer.x + footer.width &&
			event.row >= footer.y &&
			event.row < footer.y + footer.height
		) {
			this.updateHover(undefined);
			this.pressedIndex = undefined;
			const translated = {
				...event,
				row: event.row - footer.y,
				col: event.col - footer.x,
			};
			if (!this.footerPointerInside) {
				this.footerPointerInside = true;
				this.config.footer?.handleMouse?.({ ...translated, type: "enter" });
			}
			if (event.type !== "enter") this.config.footer?.handleMouse?.(translated);
			return true;
		}
		this.leaveFooter(event);

		const row = geometry.rows.find(
			(candidate) =>
				event.col >= candidate.x &&
				event.col < candidate.x + candidate.width &&
				event.row >= candidate.y &&
				event.row < candidate.y + candidate.height,
		);
		this.updateHover(row?.index);

		if (event.type === "press" && (event.button === undefined || event.button === 0)) {
			this.pressedIndex = row?.index;
			if (row) this.setSelected(row.index);
		} else if (event.type === "release" && (event.button === undefined || event.button === 0)) {
			const pressed = this.pressedIndex;
			this.pressedIndex = undefined;
			if (row && pressed === row.index && this.config.activateOnClick !== false) this.choose(row.index);
		}
		return true;
	}

	/** @returns The selected value, or undefined when the option list is empty. */
	getSelectedValue(): Value | undefined {
		return this.config.options[this.selectedIndex]?.value;
	}

	/** @returns A defensive copy of the most recent rendered geometry, if rendered. */
	getGeometry(): ActionPanelGeometry<Value> | undefined {
		if (!this.geometry) return undefined;
		return {
			...this.geometry,
			rows: this.geometry.rows.map((row) => ({ ...row })),
			footer: this.geometry.footer ? { ...this.geometry.footer } : undefined,
		};
	}

	/** Clear cached panel and footer geometry after external state changes. */
	invalidate(): void {
		this.geometry = undefined;
		this.config.footer?.invalidate?.();
	}

	/**
	 * Render the framed panel and update its interactive geometry.
	 * @param availableWidth Width offered by the host in terminal cells.
	 * @returns Rendered terminal rows, or an empty array when the bounds are too small.
	 */
	render(availableWidth: number): string[] {
		const colors = tuiTheme(this.config.theme);
		const width = Math.max(0, Math.min(availableWidth, this.config.maxWidth ?? availableWidth));
		const boundedHeight = Math.max(0, Math.floor(this.config.maxHeight ?? Number.POSITIVE_INFINITY));
		const chromeRows = this.config.footer ? 4 : this.config.showHint === false ? 2 : 3;
		if (width < MIN_WIDTH || boundedHeight < chromeRows + 1) {
			this.geometry = undefined;
			return [];
		}
		const innerWidth = width - 2;
		this.clampSelection();

		const maxRowsByHeight = Math.max(1, boundedHeight - chromeRows);
		const visibleCount = Math.min(
			Math.max(1, this.config.maxVisible ?? 9),
			maxRowsByHeight,
			Math.max(1, this.config.options.length),
		);
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - visibleCount + 1, Math.max(0, this.config.options.length - visibleCount)),
		);
		const visible = this.config.options.slice(start, start + visibleCount);
		const position =
			this.config.options.length === 0 ? "0/0" : `${this.selectedIndex + 1}/${this.config.options.length}`;
		const fixedTitleWidth = visibleWidth(`─  ${position} `);
		const visibleTitle = truncateToWidth(this.config.title, Math.max(0, innerWidth - fixedTitleWidth), "");
		const usedTitleWidth = visibleWidth(`─ ${visibleTitle} ${position} `);
		const lines = [
			colors.fg("border", "╭─ ") +
				colors.fg("accent", this.config.theme.bold(visibleTitle)) +
				colors.fg("text.muted", ` ${position}`) +
				colors.fg("border", ` ${"─".repeat(Math.max(0, innerWidth - usedTitleWidth))}╮`),
		];
		const rows: ActionPanelRowGeometry<Value>[] = [];

		if (visible.length === 0) {
			const empty = colors.fg("text.muted", this.config.emptyMessage ?? "No options.");
			lines.push(`${colors.fg("border", "│")}${fitLine(` ${empty}`, innerWidth)}${colors.fg("border", "│")}`);
		} else {
			for (const [offset, option] of visible.entries()) {
				const index = start + offset;
				const y = lines.length;
				lines.push(
					`${colors.fg("border", "│")}${this.renderRow(option, index, innerWidth)}${colors.fg("border", "│")}`,
				);
				rows.push({
					x: 1,
					y,
					width: innerWidth,
					height: 1,
					index,
					value: option.value,
				});
			}
		}

		let footer: ActionPanelRect | undefined;
		if (this.config.footer) {
			lines.push(colors.fg("border", `├${"─".repeat(innerWidth)}┤`));
			const y = lines.length;
			const content = this.config.footer.render(innerWidth)[0] ?? "";
			lines.push(`${colors.fg("border", "│")}${fitLine(content, innerWidth)}${colors.fg("border", "│")}`);
			footer = { x: 1, y, width: innerWidth, height: 1 };
		} else if (this.config.showHint !== false) {
			const keys = this.config.numberShortcuts
				? "↑↓/jk navigate  1-9/enter select  esc/q cancel"
				: "↑↓/jk navigate  enter select  esc/q cancel";
			lines.push(
				`${colors.fg("border", "│")}${fitLine(` ${colors.fg("text.muted", keys)}`, innerWidth)}${colors.fg("border", "│")}`,
			);
		}
		lines.push(colors.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		this.geometry = { x: 0, y: 0, width, height: lines.length, rows, footer };
		return lines;
	}

	private renderRow(option: ActionPanelOption<Value>, index: number, width: number): string {
		const colors = tuiTheme(this.config.theme);
		const shortcut = this.config.numberShortcuts && index < 9 ? index + 1 : undefined;
		const active = index === this.selectedIndex || index === this.hoverIndex;
		const cursor = index === this.selectedIndex ? colors.fg("accent", "›") : " ";
		const hint =
			shortcut === undefined
				? undefined
				: renderKeyHint(
						this.config.theme,
						String(shortcut) as KeyId,
						undefined,
						active ? "surface.selected" : undefined,
					);
		const prefix = hint === undefined ? ` ${cursor} ` : ` ${cursor}${hint} `;
		const contentWidth = Math.max(0, width - visibleWidth(prefix));
		const content = this.config.renderOption
			? this.config.renderOption(option, {
					width: contentWidth,
					index,
					shortcut,
					theme: this.config.theme,
				})
			: `${option.label}${option.description ? `  ${colors.fg("text.muted", option.description)}` : ""}`;
		const line = `${prefix}${fitLine(content, contentWidth)}`;
		return active ? colors.bg("surface.selected", line) : line;
	}

	private move(delta: number): void {
		if (this.config.options.length === 0) return;
		this.setSelected(Math.max(0, Math.min(this.config.options.length - 1, this.selectedIndex + delta)));
	}

	private select(index: number): void {
		if (this.config.options.length === 0) return;
		this.setSelected(Math.max(0, Math.min(this.config.options.length - 1, index)));
	}

	private setSelected(index: number): void {
		if (this.selectedIndex === index) return;
		this.selectedIndex = index;
		const option = this.config.options[index];
		if (option) this.config.onSelectionChange?.(option.value);
		this.config.requestRender();
	}

	private updateHover(index: number | undefined): void {
		if (this.hoverIndex === index) return;
		this.hoverIndex = index;
		this.config.requestRender();
	}

	private choose(index: number): void {
		const option = this.config.options[index];
		if (option) this.config.onSelect(option.value);
	}

	private leaveFooter(event: ActionPanelMouseEvent): void {
		if (!this.footerPointerInside) return;
		this.footerPointerInside = false;
		this.config.footer?.handleMouse?.({
			...event,
			type: "leave",
			row: -1,
			col: -1,
		});
	}

	private clampSelection(): void {
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.config.options.length - 1)));
	}
}
