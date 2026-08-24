import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Key,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { renderKeyHint } from "../decoration/glyphs.ts";
import { fitLine } from "../line-layout.ts";
import type { TuiMouseEvent } from "../mouse.ts";
import { DialogButtonBar } from "./dialog-button-bar.ts";
import type { SelectOption } from "./searchable-select.ts";
import { SelectableList, type SelectableListRenderContext } from "./selectable-list.ts";
import { SemanticInput } from "./semantic-input.ts";

/** One searchable option displayed by {@link PickerPanel}. */
export interface PickerOption<Value extends string = string> extends SelectOption<Value> {
	/** Optional text used instead of the visible label and description for fuzzy matching. */
	searchText?: string;
}

/** Layout and appearance available to a custom picker-row renderer. */
export interface PickerRowContext {
	/** Available row width in terminal cells. */
	width: number;
	/** Active Pi theme for non-color text attributes. */
	theme: Theme;
}

/** Minimum host surface required by {@link PickerPanel}. */
export interface PickerPanelHost {
	/** Terminal dimensions used to bound the panel height. */
	terminal: { rows: number };
	/** Request a host render after interactive state changes. */
	requestRender(): void;
}

/** Construction options for {@link PickerPanel}. */
export interface PickerPanelOptions<Value extends string> {
	/** Host terminal and render-request surface. */
	tui: PickerPanelHost;
	/** Active Pi theme used to derive semantic libtui colors. */
	theme: Theme;
	/** Pi keybinding manager used for navigation, confirmation, and cancellation. */
	keybindings: KeybindingsManager;
	/** Title rendered in the panel border. */
	title: string;
	/** Complete ordered set of searchable options. */
	options: readonly PickerOption<Value>[];
	/** Initially selected value; defaults to the first option. */
	selected?: Value;
	/** Maximum number of option rows displayed at once. */
	maxVisible?: number;
	/** Text displayed when the current query has no matches. */
	emptyMessage?: string;
	/** Custom option renderer; output is fitted to the available width. */
	renderOption?: (option: PickerOption<Value>, context: PickerRowContext) => string;
	/** Receive the confirmed option value. */
	onSelect(value: Value): void;
	/** Close the picker without selecting. */
	onCancel(): void;
}

const MIN_WIDTH = 24;
const PANEL_ROWS = 4;

function framed(theme: Theme, content: string, innerWidth: number): string {
	const colors = tuiTheme(theme);
	return `${colors.fg("border", "│")}${fitLine(content, innerWidth)}${colors.fg("border", "│")}`;
}

function topBorder(theme: Theme, title: string, position: string, width: number): string {
	const colors = tuiTheme(theme);
	const label = `${colors.fg("border", "─ ")}${colors.fg("accent", theme.bold(title))}${colors.fg("text.muted", ` ${position}`)} `;
	const clipped = truncateToWidth(label, Math.max(0, width - 2), "");
	return `${colors.fg("border", "╭")}${clipped}${colors.fg("border", `${"─".repeat(Math.max(0, width - visibleWidth(clipped) - 2))}╮`)}`;
}

/** A domain-free, searchable single-select panel for bottom-sheet overlays. */
export class PickerPanel<Value extends string = string> implements Component, Focusable {
	private readonly maxVisible: number;
	private readonly input: SemanticInput;
	private readonly list: SelectableList<PickerOption<Value>>;
	private readonly buttons: DialogButtonBar<"cancel" | "save">;
	private filtered: readonly PickerOption<Value>[];
	private searching = false;
	private _focused = false;
	private searchRow: number | undefined;
	private listStart = 0;
	private listHeight = 0;
	private contentWidth = 0;
	private buttonRow: number | undefined;
	private searchHovered = false;
	private searchPressed = false;

	/**
	 * Create a searchable bottom-sheet picker.
	 * @param options Host, choices, theme, keybindings, and completion callbacks.
	 */
	constructor(private readonly options: PickerPanelOptions<Value>) {
		this.maxVisible = Math.max(1, options.maxVisible ?? 8);
		this.filtered = [...options.options];
		const selected = Math.max(
			0,
			options.options.findIndex((option) => option.value === options.selected),
		);
		this.input = new SemanticInput(options.theme);
		this.input.onSubmit = () => this.choose();
		this.input.onEscape = () => this.clearSearch();
		this.list = new SelectableList({
			items: this.filtered,
			selectedIndex: selected,
			maxVisible: this.maxVisible,
			wrap: false,
			activateOnClick: false,
			renderItem: (option, context) => this.renderOption(option, context),
			requestRender: () => options.tui.requestRender(),
			onActivate: (option) => this.options.onSelect(option.value),
		});
		this.buttons = new DialogButtonBar({
			theme: options.theme,
			leading: () => this.renderNavigationHint(),
			buttons: [
				{
					value: "cancel",
					label: "Cancel",
					icon: "cancel",
					foreground: "text.primary",
					background: "action.neutral",
					shortcuts: options.keybindings.getKeys("tui.select.cancel"),
				},
				{
					value: "save",
					label: "Save",
					icon: "confirm",
					foreground: "positive",
					background: "action.positive",
					shortcuts: options.keybindings.getKeys("tui.select.confirm"),
				},
			],
			requestRender: () => options.tui.requestRender(),
			onActivate: (action) => (action === "save" ? this.choose() : this.options.onCancel()),
		});
	}

	/** Whether the panel currently receives keyboard focus. */
	get focused(): boolean {
		return this._focused;
	}

	/** Update panel focus and forward it to the search field while searching. */
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.searching;
	}

	/**
	 * Handle component-local search, list, and action-button pointer input.
	 *
	 * The list and button bar receive the same rendered geometry they own for
	 * every other shared picker. The panel only translates coordinates through
	 * its frame and reserves the search row for filter activation.
	 *
	 * @param event Pointer event from pi-libtui's shared component host.
	 * @returns True when the event targets a panel region.
	 */
	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "leave") {
			this.clearPointerState(event);
			return false;
		}

		const contentColumn = event.col - 1;
		if (this.buttonRow !== undefined && event.row === this.buttonRow) {
			this.leaveSearch();
			this.leaveList(event);
			this.buttons.onMouse({ ...event, row: 0, col: contentColumn });
			return true;
		}
		this.leaveButtons(event);

		if (
			this.searchRow !== undefined &&
			event.row === this.searchRow &&
			contentColumn >= 0 &&
			contentColumn < this.contentWidth
		) {
			this.leaveList(event);
			if (!this.searchHovered) {
				this.searchHovered = true;
				this.options.tui.requestRender();
			}
			if (event.type === "press" && (event.button === undefined || event.button === 0)) this.searchPressed = true;
			if (event.type === "release" && (event.button === undefined || event.button === 0)) {
				const activate = this.searchPressed;
				this.searchPressed = false;
				if (activate) this.activateSearch();
			}
			return true;
		}
		this.leaveSearch();

		if (event.row >= this.listStart && event.row < this.listStart + this.listHeight) {
			return this.list.onMouse({ ...event, row: event.row - this.listStart, col: contentColumn });
		}
		this.leaveList(event);
		return false;
	}

	/**
	 * Handle search activation, filtering, navigation, selection, and cancellation.
	 * @param data Raw terminal input from Pi.
	 */
	handleInput(data: string): void {
		if (this.searching) {
			if (this.options.keybindings.matches(data, "tui.select.cancel")) {
				this.clearSearch();
				return;
			}
			if (this.options.keybindings.matches(data, "tui.select.confirm")) {
				this.choose();
				return;
			}
			if (
				this.options.keybindings.matches(data, "tui.select.up") ||
				this.options.keybindings.matches(data, "tui.select.down")
			) {
				this.handleListInput(data);
				return;
			}
			this.input.handleInput(data);
			this.applyFilter();
			return;
		}
		if (this.buttons.handleInput(data)) return;
		if (this.options.keybindings.matches(data, "tui.select.cancel") || data === "q") {
			this.options.onCancel();
			return;
		}
		if (data === "/" || matchesKey(data, Key.ctrl("f"))) {
			this.activateSearch();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.list.setSelectedIndex(0);
			return;
		}
		if (data === "G" || matchesKey(data, Key.end)) {
			this.list.setSelectedIndex(this.filtered.length - 1);
			return;
		}
		this.handleListInput(data);
	}

	/** Clear cached child layout and pointer geometry after external state changes. */
	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
		this.buttons.invalidate();
		this.searchRow = undefined;
		this.listStart = 0;
		this.listHeight = 0;
		this.contentWidth = 0;
		this.buttonRow = undefined;
		this.clearPointerState({
			type: "leave",
			row: -1,
			col: -1,
			screenRow: -1,
			screenCol: -1,
			button: undefined,
			wheel: undefined,
			shift: false,
			alt: false,
			ctrl: false,
		});
	}

	/**
	 * Render the bordered picker within the host terminal's current height.
	 * @param width Available width in terminal cells.
	 * @returns Rendered terminal rows, or no rows when the terminal is too small.
	 */
	render(width: number): string[] {
		const colors = tuiTheme(this.options.theme);
		const terminalRows = this.options.tui.terminal.rows;
		if (width < MIN_WIDTH || terminalRows < PANEL_ROWS + 1) {
			this.searchRow = undefined;
			this.listStart = 0;
			this.listHeight = 0;
			this.contentWidth = 0;
			this.buttonRow = undefined;
			return [];
		}
		const innerWidth = width - 2;
		this.contentWidth = innerWidth;
		const availableRows = Math.max(1, terminalRows - PANEL_ROWS);
		this.list.setMaxVisible(Math.min(this.maxVisible, availableRows));
		const options = this.filtered;
		const selectedIndex = this.list.getSelectedIndex();
		const position = options.length === 0 ? "0/0" : `${selectedIndex + 1}/${options.length}`;
		const lines = [topBorder(this.options.theme, this.options.title, position, width)];

		this.searchRow = lines.length;
		lines.push(framed(this.options.theme, this.searchLine(innerWidth), innerWidth));

		this.listStart = lines.length;
		const listLines = this.list.render(innerWidth);
		this.listHeight = Math.max(1, listLines.length);
		if (listLines.length === 0) {
			lines.push(
				framed(
					this.options.theme,
					colors.fg("text.muted", this.options.emptyMessage ?? "No matching options."),
					innerWidth,
				),
			);
		} else {
			lines.push(...listLines.map((line) => framed(this.options.theme, line, innerWidth)));
		}

		this.buttonRow = lines.length;
		const buttonLine = this.buttons.render(innerWidth)[0] ?? "";
		lines.push(framed(this.options.theme, buttonLine, innerWidth));
		lines.push(colors.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	private visibleOptions(): PickerOption<Value>[] {
		const options = [...this.options.options];
		const query = this.input.getValue();
		return query
			? fuzzyFilter(options, query, (option) => option.searchText ?? `${option.label} ${option.description ?? ""}`)
			: options;
	}

	private applyFilter(): void {
		this.filtered = this.visibleOptions();
		this.list.setItems(this.filtered, 0);
	}

	private activateSearch(): void {
		this.searching = true;
		this.input.focused = this._focused;
		this.options.tui.requestRender();
	}

	private clearSearch(): void {
		this.searching = false;
		this.input.focused = false;
		this.input.setValue("");
		this.filtered = [...this.options.options];
		const selected = this.options.options.findIndex((option) => option.value === this.options.selected);
		this.list.setItems(this.filtered, selected >= 0 ? selected : 0);
	}

	private choose(): void {
		const option = this.list.getSelectedItem();
		if (option) this.options.onSelect(option.value);
	}

	private handleListInput(data: string): void {
		if (this.options.keybindings.matches(data, "tui.select.up")) {
			this.list.handleInput("k");
			return;
		}
		if (this.options.keybindings.matches(data, "tui.select.down")) {
			this.list.handleInput("j");
			return;
		}
		this.list.handleInput(data);
	}

	private searchLine(width: number): string {
		const colors = tuiTheme(this.options.theme);
		const content = !this.searching
			? colors.fg("text.muted", "/ search")
			: (() => {
					const prefix = colors.fg("text.muted", "search ");
					const rendered = this.input.render(Math.max(1, width - visibleWidth(prefix)))[0] ?? "";
					return prefix + (rendered.startsWith("> ") ? rendered.slice(2) : rendered);
				})();
		return this.searchHovered ? colors.bg("surface.raised", fitLine(content, width)) : content;
	}

	private renderOption(option: PickerOption<Value>, context: SelectableListRenderContext): string {
		const colors = tuiTheme(this.options.theme);
		const cursor = context.selected ? colors.fg("accent", "›") : " ";
		const prefix = ` ${cursor} `;
		const contentWidth = Math.max(0, context.width - visibleWidth(prefix));
		const content = this.options.renderOption
			? this.options.renderOption(option, { width: contentWidth, theme: this.options.theme })
			: `${option.label}${option.description ? `  ${colors.fg("text.muted", option.description)}` : ""}`;
		const row = `${prefix}${fitLine(content, contentWidth)}`;
		if (context.selected) return colors.bg("surface.selected", row);
		return context.hovered ? colors.bg("surface.hover", row) : row;
	}

	private renderNavigationHint(): string {
		const colors = tuiTheme(this.options.theme);
		const keys = [
			this.options.keybindings.getKeys("tui.select.up")[0],
			this.options.keybindings.getKeys("tui.select.down")[0],
		].filter((key): key is NonNullable<typeof key> => key !== undefined);
		const hints = keys.map((key) => renderKeyHint(this.options.theme, key));
		return `${hints.join(" ")}${hints.length > 0 ? " " : ""}${colors.fg("text.muted", "move")}`;
	}

	private leaveSearch(): void {
		const changed = this.searchHovered || this.searchPressed;
		this.searchHovered = false;
		this.searchPressed = false;
		if (changed) this.options.tui.requestRender();
	}

	private leaveList(event: TuiMouseEvent): void {
		this.list.onMouse({ ...event, row: event.row - this.listStart, col: event.col - 1, type: "leave" });
	}

	private leaveButtons(event: TuiMouseEvent): void {
		this.buttons.onMouse({ ...event, type: "leave", row: 0, col: event.col - 1 });
	}

	private clearPointerState(event: TuiMouseEvent): void {
		this.leaveSearch();
		this.leaveList(event);
		this.leaveButtons(event);
	}
}
