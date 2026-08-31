import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { icon, keyHintGlyph } from "../decoration/glyphs.ts";
import { fitLine } from "../line-layout.ts";
import type { TuiMouseEvent } from "../mouse.ts";
import type { SelectOption } from "./searchable-select.ts";
import { SelectableList, type SelectableListRenderContext } from "./selectable-list.ts";
import { SemanticInput } from "./semantic-input.ts";

export interface SelectBoxRowContext {
	width: number;
	selected: boolean;
	hovered: boolean;
	theme: Theme;
	query: string;
	highlight(text: string): string;
}

export interface SelectBoxOptions<Value extends string> {
	theme: Theme;
	options: readonly SelectOption<Value>[];
	selected?: Value;
	title?: string;
	bordered?: boolean;
	filterable?: boolean;
	showHint?: boolean;
	onSelect(value: Value): void;
	onPreview?(value: Value): void;
	onCancel(): void;
	renderOption?(option: SelectOption<Value>, context: SelectBoxRowContext): string;
	renderPreview?(option: SelectOption<Value>, width: number): readonly string[];
	requestRender?(): void;
}

/** Compact single-select surface with immediate Enter/click selection and no action buttons. */
export class SelectBox<Value extends string = string> implements Component, Focusable {
	private readonly list: SelectableList<SelectOption<Value>>;
	private readonly filterInput: SemanticInput;
	private _focused = false;
	private maxHeight: number | undefined;
	private listStart = 0;
	private listHeight = 0;
	private query = "";
	private previewedValue: Value | undefined;

	constructor(private readonly options: SelectBoxOptions<Value>) {
		this.filterInput = new SemanticInput(options.theme);
		const selected = Math.max(
			0,
			options.options.findIndex((option) => option.value === options.selected),
		);
		this.previewedValue = options.options[selected]?.value;
		this.list = new SelectableList({
			items: options.options,
			selectedIndex: selected,
			renderItem: (option, context) => this.renderOption(option, context),
			requestRender: options.requestRender ?? (() => {}),
			onSelectionChange: (option) => this.preview(option.value),
			onActivate: (option) => options.onSelect(option.value),
		});
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.filterInput.focused = value;
	}

	setMaxHeight(height: number): void {
		this.maxHeight = Math.max(1, Math.floor(height));
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		if (
			this.options.filterable !== false &&
			!keybindings.matches(data, "tui.select.up") &&
			!keybindings.matches(data, "tui.select.down") &&
			!keybindings.matches(data, "tui.select.confirm")
		) {
			this.filterInput.handleInput(data);
			this.setQuery(this.filterInput.getValue());
			return;
		}
		this.list.handleInput(data);
	}

	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "leave") return this.list.onMouse({ ...event, row: event.row - this.listStart });
		if (event.row < this.listStart || event.row >= this.listStart + this.listHeight) return false;
		const inset = this.options.bordered === false ? 0 : 1;
		return this.list.onMouse({ ...event, row: event.row - this.listStart, col: event.col - inset });
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(1, Math.floor(width));
		const bordered = this.options.bordered !== false;
		const innerWidth = Math.max(1, boundedWidth - (bordered ? 2 : 0));
		const selected = this.list.getSelectedItem();
		const preview = selected && this.options.renderPreview ? [...this.options.renderPreview(selected, innerWidth)] : [];
		const titleRows = this.options.title ? 2 : 0;
		const frameRows = bordered ? 2 : 0;
		const filterRows = this.options.filterable === false ? 0 : 1;
		const hintRows = this.options.showHint ? 1 : 0;
		const previewRows = preview.length > 0 ? preview.length + 1 : 0;
		const available = Math.max(
			1,
			(this.maxHeight ?? Number.POSITIVE_INFINITY) - titleRows - frameRows - filterRows - hintRows - previewRows,
		);
		this.list.setMaxVisible(available);
		const list = this.list.render(innerWidth);
		const colors = tuiTheme(this.options.theme);
		const lines: string[] = [];
		if (this.options.title) {
			lines.push(this.options.theme.bold(colors.fg("heading", this.options.title)));
			lines.push(colors.fg("border", "─".repeat(boundedWidth)));
		}
		if (bordered) lines.push(colors.fg("border", `╭${"─".repeat(innerWidth)}╮`));
		if (this.options.filterable !== false) {
			const prefix = `${icon("search")} `;
			const renderedInput = this.filterInput.render(Math.max(1, innerWidth - visibleWidth(prefix)) + 2)[0] ?? "";
			const input = renderedInput.startsWith("> ") ? renderedInput.slice(2) : renderedInput;
			lines.push(colors.bg("surface.editor", fitLine(`${colors.fg("text.secondary", prefix)}${input}`, innerWidth)));
		}
		this.listStart = lines.length;
		const listRows = list.length > 0 ? list : [colors.fg("text.muted", fitLine("  No matches", innerWidth))];
		this.listHeight = listRows.length;
		lines.push(
			...listRows.map((line) =>
				bordered ? `${colors.fg("border", "│")}${fitLine(line, innerWidth)}${colors.fg("border", "│")}` : line,
			),
		);
		if (bordered) lines.push(colors.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		if (preview.length > 0) lines.push("", ...preview);
		if (this.options.showHint) {
			const confirm = getKeybindings().getKeys("tui.select.confirm")[0];
			const cancel = getKeybindings().getKeys("tui.select.cancel")[0];
			const hint = `${confirm ? `${keyHintGlyph(confirm)} select` : "select"} · ${cancel ? `${keyHintGlyph(cancel)} back` : "back"}`;
			lines.push(colors.fg("text.muted", truncateToWidth(hint, boundedWidth, "")));
		}
		return lines;
	}

	private setQuery(query: string): void {
		if (query === this.query) return;
		const selectedValue = this.list.getSelectedItem()?.value;
		this.query = query;
		if (this.filterInput.getValue() !== query) this.filterInput.setValue(query);
		const normalized = query.toLocaleLowerCase();
		const filtered = normalized
			? this.options.options.filter((option) =>
					[option.label, option.description ?? "", option.value].some((value) =>
						value.toLocaleLowerCase().includes(normalized),
					),
				)
			: this.options.options;
		const retained = filtered.findIndex((option) => option.value === selectedValue);
		this.list.setItems(filtered, retained >= 0 ? retained : 0);
		const selected = this.list.getSelectedItem();
		if (selected) this.preview(selected.value);
		this.options.requestRender?.();
	}

	private preview(value: Value): void {
		if (value === this.previewedValue) return;
		this.previewedValue = value;
		this.options.onPreview?.(value);
	}

	private renderOption(option: SelectOption<Value>, context: SelectableListRenderContext): string {
		const colors = tuiTheme(this.options.theme);
		const prefix = context.selected ? `${colors.fg("accent", "›")} ` : "  ";
		const available = Math.max(0, context.width - visibleWidth(prefix));
		const content = this.options.renderOption
			? this.options.renderOption(option, {
					width: available,
					selected: context.selected,
					hovered: context.hovered,
					theme: this.options.theme,
					query: this.query,
					highlight: (text) => highlightMatches(text, this.query, this.options.theme),
				})
			: highlightMatches(option.label, this.query, this.options.theme);
		const row = fitLine(`${prefix}${truncateToWidth(content, available, "")}`, context.width);
		if (context.selected) {
			const background = colors.adjustForegroundBrightness(colors.color("surface.selected"), -0.08);
			return colors.bg(background, row);
		}
		if (context.hovered) {
			const background = colors.adjustForegroundBrightness(colors.color("surface.hover"), -0.08);
			return colors.bg(background, row);
		}
		return row;
	}
}

function highlightMatches(text: string, query: string, theme: Theme): string {
	if (!query) return text;
	const lower = text.toLocaleLowerCase();
	const needle = query.toLocaleLowerCase();
	if (!needle) return text;
	const colors = tuiTheme(theme);
	const parts: string[] = [];
	let start = 0;
	for (let index = lower.indexOf(needle, start); index >= 0; index = lower.indexOf(needle, start)) {
		parts.push(text.slice(start, index));
		parts.push(theme.bold(colors.fg("highlight", text.slice(index, index + query.length))));
		start = index + query.length;
	}
	parts.push(text.slice(start));
	return parts.join("");
}
