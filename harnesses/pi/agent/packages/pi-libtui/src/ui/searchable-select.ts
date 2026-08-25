import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, SelectList, Text } from "@earendil-works/pi-tui";

export interface SelectOption<Value extends string = string> {
	value: Value;
	label: string;
	description?: string;
}

export interface SearchableSelectOptions<Value extends string> {
	title: string;
	description?: string;
	options: readonly SelectOption<Value>[];
	selected?: Value;
	theme: Theme;
	onSelect(value: Value): void;
	onCancel(): void;
}

export class SearchableSelect<Value extends string = string> implements Component {
	private readonly input = new Input();
	private readonly select: SelectList;
	private filterActive = false;
	private readonly title: Text;
	private readonly description?: Text;
	private readonly hint: Text;

	constructor(options: SearchableSelectOptions<Value>) {
		this.title = new Text(options.theme.bold(options.theme.fg("accent", options.title)), 0, 0);
		this.description = options.description
			? new Text(options.theme.fg("muted", options.description), 0, 0)
			: undefined;
		this.hint = new Text(options.theme.fg("dim", "/ filter · j/k or ↑/↓ move · Enter select · Esc cancel"), 0, 0);
		this.select = new SelectList([...options.options], Math.min(12, options.options.length), getSelectListTheme());
		const selected = options.options.findIndex((option) => option.value === options.selected);
		if (selected >= 0) this.select.setSelectedIndex(selected);
		this.select.onSelect = (option) => options.onSelect(option.value as Value);
		this.select.onCancel = options.onCancel;
		this.input.onSubmit = () => { this.filterActive = false; };
		this.input.onEscape = () => {
			this.input.setValue("");
			this.select.setFilter("");
			this.filterActive = false;
		};
	}

	handleInput(data: string): void {
		if (this.filterActive) {
			this.input.handleInput(data);
			this.select.setFilter(this.input.getValue());
			return;
		}
		if (data === "/") {
			this.filterActive = true;
			return;
		}
		if (data === "j") this.select.handleInput("\x1b[B");
		else if (data === "k") this.select.handleInput("\x1b[A");
		else this.select.handleInput(data);
	}

	invalidate(): void {
		this.title.invalidate();
		this.description?.invalidate();
		this.input.invalidate();
		this.select.invalidate();
		this.hint.invalidate();
	}

	render(width: number): string[] {
		const lines = [...this.title.render(width)];
		if (this.description) lines.push(...this.description.render(width));
		lines.push("");
		if (this.filterActive || this.input.getValue()) lines.push(...this.input.render(width), "");
		lines.push(...this.select.render(width), "", ...this.hint.render(width));
		return lines;
	}
}
