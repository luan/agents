import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	getKeybindings,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { icon } from "../decoration/glyphs.ts";
import type { TuiMouseEvent } from "../mouse.ts";
import { applyScrollbar } from "../scrollbar.ts";
import { DialogButtonBar } from "./dialog-button-bar.ts";
import type { SelectOption } from "./searchable-select.ts";
import { SemanticInput } from "./semantic-input.ts";

/** Construction options for {@link MultiSelect}. */
export interface MultiSelectOptions<Value extends string> {
	/** Title rendered above the choices unless the surrounding frame owns it. */
	title: string;
	/** Optional supporting text rendered below the title. */
	description?: string;
	/** Render the title in the content. Disable when the dialog frame owns it. */
	showTitle?: boolean;
	/** Complete set of available choices. */
	options: readonly SelectOption<Value>[];
	/** Initially selected values, in their saved order. */
	value: readonly Value[];
	/** Allow selected values to be reordered and display their positions. */
	ordered?: boolean;
	/** Place option descriptions inline or on wrapped lines below each label. */
	descriptionLayout?: "inline" | "below";
	/** Maximum rendered rows. Dialog hosts supply this from their available height. */
	maxHeight?: number;
	/** Active Pi theme used to derive semantic libtui colors. */
	theme: Theme;
	/** Persist the selected values in their current order. */
	onSave(value: Value[]): void;
	/** Preview a changed selection without persisting it. */
	onChange?(value: Value[]): void;
	/** Close without saving, after the component's unsaved-change confirmation. */
	onCancel(): void;
	/** Require a second cancel before discarding changes. Defaults to true. */
	confirmDiscard?: boolean;
}

/** A mouseable multi-select with optional ordering and explicit Save and Cancel actions. */
export class MultiSelect<Value extends string = string> implements Component, Focusable {
	private selectedIndex = 0;
	private readonly initialValue: Value[];
	private value: Value[];
	private discardWarning = false;
	private readonly buttons: DialogButtonBar<"cancel" | "save">;
	private rows: Array<{ y: number; height: number; value: Value; index: number }> = [];
	private buttonRow: number | undefined;
	private pressedValue: Value | undefined;
	private maxHeight: number;
	private viewportStart = 0;
	private followSelection = true;
	private readonly input: SemanticInput;
	private filterActive = false;
	private searchRow: number | undefined;
	private searchHovered = false;
	private searchPressed = false;
	private _focused = false;

	/**
	 * Create a multi-select editor.
	 * @param settings Choices, initial values, appearance, and completion callbacks.
	 */
	constructor(private readonly settings: MultiSelectOptions<Value>) {
		const colors = tuiTheme(settings.theme);
		const keybindings = getKeybindings();
		this.initialValue = settings.value.filter((value) => settings.options.some((option) => option.value === value));
		this.value = [...this.initialValue];
		this.maxHeight = settings.maxHeight ?? Number.POSITIVE_INFINITY;
		this.input = new SemanticInput(settings.theme);
		this.buttons = new DialogButtonBar({
			theme: settings.theme,
			leading: () =>
				colors.fg("text.muted", settings.ordered ? "Space toggle · ↑↓ move · ←→ reorder" : "Space toggle · ↑↓ move"),
			buttons: [
				{
					value: "cancel",
					label: "Cancel",
					icon: "cancel",
					foreground: "text.primary",
					background: "action.neutral",
					shortcuts: keybindings.getKeys("tui.select.cancel"),
					align: "end",
				},
				{
					value: "save",
					label: "Save",
					icon: "confirm",
					foreground: "positive",
					background: "action.positive",
					shortcuts: keybindings.getKeys("tui.select.confirm"),
					align: "end",
				},
			],
			requestRender() {},
			onActivate: (action) => {
				if (action === "save") this.save();
				else this.cancel();
			},
		});
	}

	/** Whether the component currently receives keyboard focus. */
	get focused(): boolean {
		return this._focused;
	}

	/** Forward focus to the filter field while it is active. */
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.filterActive;
	}

	/** Limit rendered rows so a dialog can reserve its frame inside the terminal. */
	setMaxHeight(maxHeight: number): void {
		this.maxHeight = Math.max(0, Math.floor(maxHeight));
	}

	/**
	 * Handle navigation, toggling, reordering, saving, and cancellation.
	 * @param data Raw terminal input from Pi.
	 */
	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const options = this.displayOptions();
		if (this.filterActive) {
			if (keybindings.matches(data, "tui.select.cancel")) {
				this.clearFilter();
				return;
			}
			if (
				!keybindings.matches(data, "tui.select.up") &&
				!keybindings.matches(data, "tui.select.down") &&
				!keybindings.matches(data, "tui.select.confirm") &&
				!matchesKey(data, "space")
			) {
				const selected = options[this.selectedIndex]?.value;
				this.input.handleInput(data);
				this.applyFilter(selected);
				return;
			}
		}
		if (data === "/") {
			this.activateFilter();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		this.discardWarning = false;
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.save();
			return;
		}
		if (options.length === 0) return;
		if (keybindings.matches(data, "tui.select.up") || data === "k") {
			this.followSelection = true;
			this.selectedIndex = (this.selectedIndex - 1 + options.length) % options.length;
			return;
		}
		if (keybindings.matches(data, "tui.select.down") || data === "j") {
			this.followSelection = true;
			this.selectedIndex = (this.selectedIndex + 1) % options.length;
			return;
		}
		const selected = options[this.selectedIndex];
		if (!selected) return;
		if (matchesKey(data, "space")) {
			this.toggle(selected.value);
			return;
		}
		const moveLeft = matchesKey(data, "left") || data === "h";
		const moveRight = matchesKey(data, "right") || data === "l";
		if (!this.settings.ordered || (!moveLeft && !moveRight)) return;
		const index = this.value.indexOf(selected.value);
		if (index < 0) return;
		const next = moveLeft ? index - 1 : index + 1;
		if (next < 0 || next >= this.value.length) return;
		[this.value[index], this.value[next]] = [this.value[next]!, this.value[index]!];
		this.selectedIndex = this.displayOptions().findIndex((option) => option.value === selected.value);
		this.settings.onChange?.([...this.value]);
	}

	/**
	 * Handle component-local row, wheel, and action-button pointer input.
	 * @param event Pointer event from pi-libtui's shared component host.
	 * @returns True when the event targets a choice, button, or supported wheel action.
	 */
	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "leave") {
			this.pressedValue = undefined;
			this.leaveSearch();
			this.leaveButtons(event);
			return false;
		}
		if (this.buttonRow !== undefined && event.row === this.buttonRow) {
			this.buttons.onMouse({ ...event, row: 0 });
			return true;
		}
		this.leaveButtons(event);
		if (this.searchRow !== undefined && event.row === this.searchRow) {
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
		if (event.type === "wheel" && event.wheel !== undefined) {
			this.scrollViewport(event.wheel);
			return true;
		}
		const row = this.rows.find((candidate) => event.row >= candidate.y && event.row < candidate.y + candidate.height);
		if ((event.type === "enter" || event.type === "move") && row) {
			this.followSelection = true;
			this.selectedIndex = row.index;
			return true;
		}
		if (event.type === "press" && (event.button === undefined || event.button === 0)) {
			this.pressedValue = row?.value;
			if (row) {
				this.followSelection = true;
				this.selectedIndex = row.index;
			}
			return row !== undefined;
		}
		if (event.type === "release" && (event.button === undefined || event.button === 0)) {
			const pressedValue = this.pressedValue;
			this.pressedValue = undefined;
			if (row && row.value === pressedValue) this.toggle(row.value);
			return row !== undefined;
		}
		return row !== undefined;
	}

	/** Clear cached row and button geometry after external state changes. */
	invalidate(): void {
		this.rows = [];
		this.searchRow = undefined;
		this.buttonRow = undefined;
		this.input.invalidate();
		this.buttons.invalidate();
	}

	/**
	 * Render choices, optional discard warning, and the action row.
	 * @param width Available width in terminal cells.
	 * @returns Rendered terminal rows clipped to the supplied width.
	 */
	render(width: number): string[] {
		const colors = tuiTheme(this.settings.theme);
		const lines =
			this.settings.showTitle === false ? [] : [this.settings.theme.bold(colors.fg("accent", this.settings.title))];
		if (this.settings.description) {
			lines.push(...new Text(colors.fg("text.muted", this.settings.description), 0, 0).render(width));
		}
		this.searchRow = lines.length;
		lines.push(this.renderSearch(width));
		this.rows = [];
		const optionWidth = Math.max(1, width - 2);
		const makeBlocks = (options: readonly SelectOption<Value>[]) =>
			options.map((option, index) => {
				const position = this.value.indexOf(option.value);
				const marker =
					position >= 0 ? colors.fg("positive", icon("checkbox-on")) : colors.fg("text.muted", icon("checkbox-off"));
				const order = this.settings.ordered && position >= 0 ? ` ${position + 1}.` : "";
				const prefix = `${index === this.selectedIndex ? "›" : " "} ${marker}${order} `;
				const label =
					this.settings.descriptionLayout === "below"
						? option.label
						: `${option.label}${option.description ? `  ${colors.fg("text.muted", option.description)}` : ""}`;
				const row = `${prefix}${label}`;
				const block = [index === this.selectedIndex ? colors.fg("accent", row) : row];
				if (this.settings.descriptionLayout === "below" && option.description) {
					const indent = " ".repeat(visibleWidth(prefix));
					const descriptionWidth = Math.max(1, optionWidth - visibleWidth(indent));
					for (const description of new Text(colors.fg("text.muted", option.description), 0, 0).render(
						descriptionWidth,
					)) {
						block.push(`${indent}${description}`);
					}
				}
				return { lines: block, option, index };
			});
		const blocks = makeBlocks(this.displayOptions());
		const fullHeight = makeBlocks(this.orderedOptions()).reduce((height, block) => height + block.lines.length, 0);
		const footerHeight = this.discardWarning ? 4 : 2;
		const availableHeight = Number.isFinite(this.maxHeight)
			? Math.max(1, this.maxHeight - lines.length - footerHeight)
			: Math.max(1, fullHeight);
		const optionHeight = Math.min(Math.max(1, fullHeight), availableHeight);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, blocks.length - 1));
		this.viewportStart = Math.min(this.viewportStart, Math.max(0, blocks.length - 1));
		if (this.followSelection) {
			this.viewportStart = Math.min(this.viewportStart, this.selectedIndex);
			while (
				this.viewportStart < this.selectedIndex &&
				blocks
					.slice(this.viewportStart, this.selectedIndex + 1)
					.reduce((height, block) => height + block.lines.length, 0) > optionHeight
			) {
				this.viewportStart += 1;
			}
		}
		while (
			this.viewportStart > 0 &&
			blocks.slice(this.viewportStart).reduce((height, block) => height + block.lines.length, 0) < optionHeight
		) {
			this.viewportStart -= 1;
		}
		const totalHeight = blocks.reduce((height, block) => height + block.lines.length, 0);
		const startLine = blocks.slice(0, this.viewportStart).reduce((height, block) => height + block.lines.length, 0);
		let usedHeight = 0;
		for (const block of blocks.slice(this.viewportStart)) {
			const visibleLines = block.lines.slice(0, optionHeight - usedHeight);
			if (visibleLines.length === 0) break;
			const y = lines.length;
			lines.push(...visibleLines);
			usedHeight += visibleLines.length;
			this.rows.push({ y, height: visibleLines.length, value: block.option.value, index: block.index });
			if (usedHeight >= optionHeight) break;
		}
		if (blocks.length === 0) {
			lines.push(colors.fg("text.muted", "  No matching options"));
			usedHeight = 1;
		}
		while (usedHeight < optionHeight) {
			lines.push("");
			usedHeight += 1;
		}
		this.renderScrollbar(lines, lines.length - optionHeight, optionHeight, startLine, totalHeight, width);
		if (this.discardWarning) {
			lines.push("", colors.fg("warning", "Unsaved changes. Press Esc again to discard or Enter to save."));
		}
		lines.push("");
		this.buttonRow = lines.length;
		lines.push(...this.buttons.render(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private scrollViewport(delta: number): void {
		const options = this.displayOptions();
		if (options.length === 0 || delta === 0) return;
		this.viewportStart = Math.max(0, Math.min(this.viewportStart + delta, options.length - 1));
		this.followSelection = false;
	}

	private toggle(value: Value): void {
		this.discardWarning = false;
		const index = this.value.indexOf(value);
		if (index >= 0) this.value.splice(index, 1);
		else this.value.push(value);
		this.selectedIndex = this.displayOptions().findIndex((option) => option.value === value);
		this.settings.onChange?.([...this.value]);
	}

	private save(): void {
		this.settings.onSave([...this.value]);
	}

	private cancel(): void {
		if (this.settings.confirmDiscard !== false && this.hasUnsavedChanges() && !this.discardWarning) {
			this.discardWarning = true;
			return;
		}
		this.settings.onCancel();
	}

	private leaveButtons(event: TuiMouseEvent): void {
		this.buttons.onMouse({ ...event, type: "leave", row: 0 });
	}

	private renderSearch(width: number): string {
		const colors = tuiTheme(this.settings.theme);
		const prefix = `${colors.fg("text.muted", icon("search"))} `;
		const available = Math.max(0, width - visibleWidth(prefix));
		let content: string;
		if (this.filterActive) {
			const inputLine = this.input.render(available)[0] ?? "";
			content = inputLine.startsWith("> ") ? inputLine.slice(2) : inputLine;
		} else if (this.input.getValue()) content = colors.fg("text.primary", this.input.getValue());
		else content = colors.fg("text.muted", "Filter…");
		const row = truncateToWidth(`${prefix}${content}`, width, "");
		const padded = row + " ".repeat(Math.max(0, width - visibleWidth(row)));
		return this.searchHovered ? colors.bg("surface.raised", padded) : padded;
	}

	private renderScrollbar(
		lines: string[],
		start: number,
		height: number,
		offset: number,
		total: number,
		width: number,
	): void {
		const painted = applyScrollbar(lines.slice(start, start + height), {
			theme: this.settings.theme,
			width,
			height,
			offset,
			total,
		});
		for (let row = 0; row < painted.length; row += 1) lines[start + row] = painted[row]!;
	}

	private activateFilter(): void {
		this.filterActive = true;
		this.input.focused = this._focused;
	}

	private clearFilter(): void {
		const selected = this.displayOptions()[this.selectedIndex]?.value;
		this.input.setValue("");
		this.filterActive = false;
		this.input.focused = false;
		this.applyFilter(selected);
	}

	private applyFilter(selected?: Value): void {
		this.viewportStart = 0;
		this.followSelection = true;
		const options = this.displayOptions();
		const retained = selected === undefined ? -1 : options.findIndex((option) => option.value === selected);
		this.selectedIndex = retained >= 0 ? retained : 0;
	}

	private leaveSearch(): void {
		this.searchHovered = false;
		this.searchPressed = false;
	}

	private displayOptions(): SelectOption<Value>[] {
		const tokens = this.input.getValue().toLowerCase().trim().split(/\s+/u).filter(Boolean);
		return this.orderedOptions().filter((option) => {
			const searchText = `${option.value} ${option.label} ${option.description ?? ""}`.toLowerCase();
			return tokens.every((token) => searchText.includes(token));
		});
	}

	private orderedOptions(): SelectOption<Value>[] {
		if (!this.settings.ordered) return [...this.settings.options];
		const byValue = new Map(this.settings.options.map((option) => [option.value, option]));
		const selected = this.value.flatMap((value) => {
			const option = byValue.get(value);
			return option ? [option] : [];
		});
		const unselected = this.settings.options.filter((option) => !this.value.includes(option.value));
		return [...selected, ...unselected];
	}

	private hasUnsavedChanges(): boolean {
		return JSON.stringify(this.value) !== JSON.stringify(this.initialValue);
	}
}
