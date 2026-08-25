import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { SelectOption } from "./searchable-select.ts";

export interface MultiSelectOptions<Value extends string> {
	title: string;
	description?: string;
	options: readonly SelectOption<Value>[];
	value: readonly Value[];
	ordered?: boolean;
	theme: Theme;
	onSave(value: Value[]): void;
	onCancel(): void;
}

export class MultiSelect<Value extends string = string> implements Component {
	private selectedIndex = 0;
	private readonly initialValue: Value[];
	private value: Value[];
	private discardWarning = false;

	constructor(private readonly settings: MultiSelectOptions<Value>) {
		this.initialValue = settings.value.filter((value) => settings.options.some((option) => option.value === value));
		this.value = [...this.initialValue];
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const options = this.displayOptions();
		if (keybindings.matches(data, "tui.select.cancel")) {
			if (this.hasUnsavedChanges() && !this.discardWarning) {
				this.discardWarning = true;
				return;
			}
			this.settings.onCancel();
			return;
		}
		this.discardWarning = false;
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.settings.onSave([...this.value]);
			return;
		}
		if (options.length === 0) return;
		if (keybindings.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = (this.selectedIndex - 1 + options.length) % options.length;
			return;
		}
		if (keybindings.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % options.length;
			return;
		}
		const selected = options[this.selectedIndex];
		if (!selected) return;
		if (matchesKey(data, "space")) {
			const index = this.value.indexOf(selected.value);
			if (index >= 0) this.value.splice(index, 1);
			else this.value.push(selected.value);
			this.selectedIndex = this.displayOptions().findIndex((option) => option.value === selected.value);
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
		this.selectedIndex = next;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [this.settings.theme.bold(this.settings.theme.fg("accent", this.settings.title))];
		if (this.settings.description) lines.push(this.settings.theme.fg("muted", this.settings.description));
		lines.push("");
		for (const [index, option] of this.displayOptions().entries()) {
			const position = this.value.indexOf(option.value);
			const marker = position >= 0
				? this.settings.theme.fg("success", "󰱒")
				: this.settings.theme.fg("muted", "󰄱");
			const order = this.settings.ordered && position >= 0 ? ` ${position + 1}.` : "";
			const label = `${option.label}${option.description ? `  ${this.settings.theme.fg("muted", option.description)}` : ""}`;
			const row = `${index === this.selectedIndex ? "›" : " "} ${marker}${order} ${label}`;
			lines.push(index === this.selectedIndex ? this.settings.theme.fg("accent", row) : row);
		}
		if (this.discardWarning) {
			lines.push("", this.settings.theme.fg("warning", "Unsaved changes. Press Esc again to discard or Enter to save."));
		}
		lines.push("", this.settings.theme.fg("dim", "Space toggle · Enter save · Esc cancel · h/l or ←/→ reorder"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private displayOptions(): SelectOption<Value>[] {
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
