import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { icon } from "../decoration/glyphs.ts";
import type { TuiMouseEvent } from "../mouse.ts";
import { applyScrollbar } from "../scrollbar.ts";
import { DialogButtonBar } from "./dialog-button-bar.ts";
import { SelectableList, type SelectableListRenderContext } from "./selectable-list.ts";
import { SemanticInput } from "./semantic-input.ts";

/** One labeled value accepted by searchable and multi-select components. */
export interface SelectOption<Value extends string = string> {
	/** Stable value returned to the owning feature. */
	value: Value;
	/** Human-readable option label. */
	label: string;
	/** Optional supporting text rendered after the label. */
	description?: string;
}

/** State and available content width for a custom searchable-select row. */
export interface SearchableSelectRowContext {
	width: number;
	selected: boolean;
	hovered: boolean;
	theme: Theme;
}

/** Construction options for {@link SearchableSelect}. */
export interface SearchableSelectOptions<Value extends string> {
	/** Title rendered above the picker unless the surrounding frame owns it. */
	title: string;
	/** Optional supporting text rendered below the title. */
	description?: string;
	/** Place each option description inline or wrapped below its selectable row. */
	descriptionLayout?: "inline" | "below";
	/** Render the title in the content. Disable when the dialog frame owns it. */
	showTitle?: boolean;
	/** Complete ordered set of searchable options. */
	options: readonly SelectOption<Value>[];
	/** Initially selected value; defaults to the first option. */
	selected?: Value;
	/** Active Pi theme used to derive semantic libtui colors. */
	theme: Theme;
	/** Receive the explicitly confirmed option value. */
	onSelect(value: Value): void;
	/** Close the picker without confirming. */
	onCancel(): void;
	/** Render option content after the picker-owned cursor prefix. */
	renderOption?(option: SelectOption<Value>, context: SearchableSelectRowContext): string;
	/** Invalidate the host after pointer or externally animated state changes. */
	requestRender?(): void;
}

/** A fixed-layout searchable picker whose pointer selection is confirmed explicitly. */
export class SearchableSelect<Value extends string = string> implements Component, Focusable {
	private static readonly MAX_VISIBLE = 12;
	private readonly input: SemanticInput;
	private readonly list: SelectableList<SelectOption<Value>>;
	private filterActive = false;
	private readonly title?: Text;
	private readonly description?: Text;
	private readonly buttons: DialogButtonBar<"cancel" | "save">;
	private searchRow: number | undefined;
	private listStart = 0;
	private listHeight = 0;
	private buttonRow: number | undefined;
	private searchHovered = false;
	private searchPressed = false;
	private _focused = false;
	private maxHeight: number | undefined;
	private optionCount: number;

	/**
	 * Create a searchable single-select component.
	 * @param options Choices, appearance, initial selection, and completion callbacks.
	 */
	constructor(private readonly options: SearchableSelectOptions<Value>) {
		const colors = tuiTheme(options.theme);
		const keybindings = getKeybindings();
		this.input = new SemanticInput(options.theme);
		this.title =
			options.showTitle === false ? undefined : new Text(options.theme.bold(colors.fg("accent", options.title)), 0, 0);
		this.description = options.description ? new Text(colors.fg("text.muted", options.description), 0, 0) : undefined;
		const selected = Math.max(
			0,
			options.options.findIndex((option) => option.value === options.selected),
		);
		this.optionCount = options.options.length;
		this.list = new SelectableList({
			items: options.options,
			selectedIndex: selected,
			maxVisible: SearchableSelect.MAX_VISIBLE,
			activateOnClick: false,
			renderItem: (option, context) => this.renderOption(option, context),
			requestRender: options.requestRender ?? (() => {}),
			onActivate: (option) => options.onSelect(option.value),
		});
		this.buttons = new DialogButtonBar({
			theme: options.theme,
			leading: () => colors.fg("text.muted", "↑↓ move"),
			buttons: [
				{
					value: "cancel",
					label: "Cancel",
					icon: "cancel",
					foreground: "text.primary",
					background: "action.neutral",
					shortcuts: keybindings.getKeys("tui.select.cancel"),
				},
				{
					value: "save",
					label: "Save",
					icon: "confirm",
					foreground: "positive",
					background: "action.positive",
					shortcuts: keybindings.getKeys("tui.select.confirm"),
				},
			],
			requestRender: options.requestRender ?? (() => {}),
			onActivate: (action) => (action === "save" ? this.confirm() : options.onCancel()),
		});
	}

	/** Bound the complete picker to the rows supplied by its dialog host. */
	setMaxHeight(maxHeight: number): void {
		this.maxHeight = Math.max(0, Math.floor(maxHeight));
	}

	/** Whether the component currently receives keyboard focus. */
	get focused(): boolean {
		return this._focused;
	}
	/** Update component focus and forward it to the active filter field. */
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.filterActive;
	}

	/**
	 * Handle component-local filter, option-list, and action-button pointer input.
	 * @param event Pointer event from pi-libtui's shared component host.
	 * @returns True when the event targets an interactive region.
	 */
	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "leave") {
			this.clearPointerState(event);
			return false;
		}

		if (this.buttonRow !== undefined && event.row === this.buttonRow) {
			this.leaveSearch();
			this.leaveList(event);
			this.buttons.onMouse({ ...event, row: 0 });
			return true;
		}
		this.leaveButtons(event);

		if (this.searchRow !== undefined && event.row === this.searchRow) {
			this.leaveList(event);
			this.searchHovered = true;
			if (event.type === "press" && (event.button === undefined || event.button === 0)) this.searchPressed = true;
			if (event.type === "release" && (event.button === undefined || event.button === 0)) {
				const activate = this.searchPressed;
				this.searchPressed = false;
				if (activate) this.activateFilter();
			}
			return true;
		}
		this.leaveSearch();

		if (event.row >= this.listStart && event.row < this.listStart + this.listHeight) {
			return this.list.onMouse({ ...event, row: event.row - this.listStart });
		}
		this.leaveList(event);
		return false;
	}

	/**
	 * Handle filter activation and editing, list navigation, confirmation, and cancellation.
	 * @param data Raw terminal input from Pi.
	 */
	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (this.filterActive) {
			if (keybindings.matches(data, "tui.select.cancel")) {
				this.clearFilter();
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm")) {
				this.confirm();
				return;
			}
			if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
				this.list.handleInput(data);
				return;
			}
			this.input.handleInput(data);
			this.applyFilter();
			return;
		}
		if (data === "/") {
			this.activateFilter();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		this.list.handleInput(data);
	}

	/** Clear cached child layout and pointer geometry after external state changes. */
	invalidate(): void {
		this.title?.invalidate();
		this.description?.invalidate();
		this.input.invalidate();
		this.list.invalidate();
		this.buttons.invalidate();
		this.searchRow = undefined;
		this.buttonRow = undefined;
	}

	/**
	 * Render title content, filter field, result list, and explicit actions.
	 * @param width Available width in terminal cells.
	 * @returns Rendered terminal rows clipped to the supplied width.
	 */
	render(width: number): string[] {
		const colors = tuiTheme(this.options.theme);
		const lines = this.title ? [...this.title.render(width)] : [];
		if (this.description) lines.push(...this.description.render(width));
		this.searchRow = lines.length;
		lines.push(this.renderSearch(width));

		const buttons = this.buttons.render(width);
		const availableListRows = Math.max(
			1,
			(this.maxHeight ?? Number.POSITIVE_INFINITY) - lines.length - 1 - buttons.length,
		);
		this.list.setMaxVisible(this.maxHeight === undefined ? SearchableSelect.MAX_VISIBLE : availableListRows);
		this.listStart = lines.length;
		const listLines = this.list.render(width);
		this.listHeight = Math.max(1, listLines.length);
		if (listLines.length > 0) {
			const geometry = this.list.getGeometry();
			lines.push(
				...applyScrollbar(listLines, {
					theme: this.options.theme,
					width,
					height: listLines.length,
					offset: geometry?.startRow ?? 0,
					total: geometry?.totalRows ?? this.optionCount,
				}),
			);
		} else lines.push(colors.fg("text.muted", "  No matching options"));

		lines.push("");
		this.buttonRow = lines.length;
		lines.push(...buttons);
		return lines;
	}

	private renderSearch(width: number): string {
		const colors = tuiTheme(this.options.theme);
		const prefix = `${colors.fg("text.muted", icon("search"))} `;
		const available = Math.max(0, width - visibleWidth(prefix));
		let content: string;
		if (this.filterActive) {
			const inputLine = this.input.render(available)[0] ?? "";
			content = inputLine.startsWith("> ") ? inputLine.slice(2) : inputLine;
		} else if (this.input.getValue()) {
			content = colors.fg("text.primary", this.input.getValue());
		} else {
			content = colors.fg("text.muted", "Filter…");
		}
		const row = truncateToWidth(`${prefix}${content}`, width, "");
		const padded = row + " ".repeat(Math.max(0, width - visibleWidth(row)));
		return this.searchHovered ? colors.bg("surface.raised", padded) : padded;
	}

	private renderOption(option: SelectOption<Value>, context: SelectableListRenderContext): string | string[] {
		const colors = tuiTheme(this.options.theme);
		const prefix = context.selected ? colors.fg("accent", "→ ") : "  ";
		const contentWidth = Math.max(0, context.width - visibleWidth(prefix));
		let content: string;
		if (this.options.renderOption) {
			content = this.options.renderOption(option, {
				width: contentWidth,
				selected: context.selected,
				hovered: context.hovered,
				theme: this.options.theme,
			});
		} else {
			const renderedLabel = this.renderMatchingLabel(option.label, context.selected);
			const label = context.selected ? this.options.theme.bold(renderedLabel) : renderedLabel;
			const description = option.description ? `  ${colors.fg("text.muted", option.description)}` : "";
			content = `${label}${description}`;
		}
		const fit = (line: string): string => {
			const clipped = truncateToWidth(line, context.width, "");
			const padded = clipped + " ".repeat(Math.max(0, context.width - visibleWidth(clipped)));
			return context.hovered && !context.selected ? colors.bg("surface.selected", padded) : padded;
		};
		const row = fit(`${prefix}${content}`);
		if (this.options.descriptionLayout !== "below" || !option.description) return row;
		const indent = " ".repeat(visibleWidth(prefix));
		const descriptionWidth = Math.max(1, context.width - visibleWidth(indent));
		const description = new Text(colors.fg("text.muted", option.description), 0, 0).render(descriptionWidth);
		return [row, ...description.map((line) => fit(`${indent}${line}`))];
	}

	private renderMatchingLabel(label: string, selected: boolean): string {
		const query = this.input.getValue();
		const colors = tuiTheme(this.options.theme);
		const base = (text: string) => (selected ? colors.fg("accent", text) : text);
		if (!query) return base(label);

		const matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
		const segments: string[] = [];
		let end = 0;
		for (const match of label.matchAll(matcher)) {
			const start = match.index;
			segments.push(base(label.slice(end, start)), colors.fg("warning", match[0]));
			end = start + match[0].length;
		}
		segments.push(base(label.slice(end)));
		return segments.join("");
	}

	private activateFilter(): void {
		this.filterActive = true;
		this.input.focused = this._focused;
	}

	private clearFilter(): void {
		this.input.setValue("");
		this.filterActive = false;
		this.input.focused = false;
		this.applyFilter();
	}

	private applyFilter(): void {
		const query = this.input.getValue().toLowerCase();
		const selected = this.list.getSelectedItem()?.value;
		const filtered = this.options.options.filter(
			(option) => option.value.toLowerCase().includes(query) || option.label.toLowerCase().includes(query),
		);
		this.optionCount = filtered.length;
		const retained = selected === undefined ? -1 : filtered.findIndex((option) => option.value === selected);
		this.list.setItems(filtered, retained >= 0 ? retained : 0);
	}

	private confirm(): void {
		const selected = this.list.getSelectedItem();
		if (selected) this.options.onSelect(selected.value);
	}

	private leaveSearch(): void {
		this.searchHovered = false;
		this.searchPressed = false;
	}

	private leaveList(event: TuiMouseEvent): void {
		this.list.onMouse({
			...event,
			row: event.row - this.listStart,
			type: "leave",
		});
	}

	private leaveButtons(event: TuiMouseEvent): void {
		this.buttons.onMouse({ ...event, type: "leave", row: 0 });
	}

	private clearPointerState(event: TuiMouseEvent): void {
		this.leaveSearch();
		this.leaveList(event);
		this.leaveButtons(event);
	}
}
