import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bottom, frame, type PickerTheme, type PickerTui, selectedIndex } from "./picker-chrome.js";

type ChoiceOptionStyle = (option: string, selected: boolean, theme: PickerTheme) => string;

const SELECTED_BACKGROUND = "selectedBg";

export async function openChoicePicker(
	ctx: ExtensionContext,
	title: string,
	options: string[],
	initial?: string,
	optionStyle?: ChoiceOptionStyle,
): Promise<string | undefined> {
	if (!ctx.hasUI || !ctx.ui.custom) return undefined;
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => new ChoicePicker(tui, theme, done, title, options, initial, optionStyle),
		{
			overlay: true,
			overlayOptions: { width: "100%", anchor: "bottom-left" },
		},
	);
}

class ChoicePicker {
	private selected: number;

	constructor(
		private readonly tui: PickerTui,
		private readonly theme: PickerTheme,
		private readonly done: (value: string | undefined) => void,
		private readonly title: string,
		private readonly options: string[],
		initial?: string,
		private readonly optionStyle?: ChoiceOptionStyle,
	) {
		this.selected = selectedIndex(options, initial);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (data === "k" || matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.select(0);
			return;
		}
		if (data === "G" || matchesKey(data, Key.end)) {
			this.select(this.options.length - 1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
			const option = this.options[this.selected];
			if (option) this.done(option);
		}
	}

	render(width: number): string[] {
		const terminalHeight = this.tui.terminal.rows;
		if (width < 32 || terminalHeight < 8) return [];
		const innerWidth = Math.max(28, width - 2);
		const bodyHeight = Math.max(1, Math.min(8, terminalHeight - 5));
		const start = Math.max(0, Math.min(this.selected - bodyHeight + 1, this.options.length - bodyHeight));
		const position =
			this.options.length > 0 ? this.theme.fg("dim", ` ${this.selected + 1}/${this.options.length}`) : "";
		const lines = [
			frame(this.theme, `${this.theme.fg("accent", this.theme.bold(this.title))}${position}`, innerWidth),
			frame(this.theme, "", innerWidth),
		];
		for (const [offset, option] of this.options.slice(start, start + bodyHeight).entries()) {
			const selected = start + offset === this.selected;
			const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
			const currentSuffix = " (current)";
			const current = option.endsWith(currentSuffix);
			const label = current ? option.slice(0, -currentSuffix.length) : option;
			const styledLabel = this.optionStyle
				? this.optionStyle(label, selected, this.theme)
				: selected
					? this.theme.bold(label)
					: label;
			const styledCurrent = current ? this.theme.fg("muted", currentSuffix) : "";
			const raw = ` ${cursor}${styledLabel}${styledCurrent}`;
			const clipped = truncateToWidth(raw, innerWidth);
			const padded = `${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
			lines.push(frame(this.theme, selected ? this.theme.bg(SELECTED_BACKGROUND, padded) : padded, innerWidth));
		}
		lines.push(frame(this.theme, "", innerWidth));
		lines.push(frame(this.theme, this.theme.fg("dim", this.hints(innerWidth)), innerWidth));
		lines.push(bottom(this.theme, innerWidth));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {}

	private move(delta: number): void {
		if (this.options.length === 0) return;
		this.select(this.selected + delta);
	}

	private select(index: number): void {
		if (this.options.length === 0) return;
		this.selected = Math.max(0, Math.min(this.options.length - 1, index));
		this.tui.requestRender();
	}

	private hints(width: number): string {
		return truncateToWidth("↑↓/jk navigate  enter select  esc/q cancel", width);
	}
}
