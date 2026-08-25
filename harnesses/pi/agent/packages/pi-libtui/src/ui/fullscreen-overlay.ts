import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayOptions, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function fullscreenOverlayOptions(): OverlayOptions {
	return {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
	};
}

function fitLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function topBorder(theme: Theme, title: string, width: number): string {
	const visibleTitle = truncateToWidth(title, Math.max(0, width - 5), "");
	const label = visibleTitle ? `─ ${theme.fg("accent", visibleTitle)} ` : "─";
	const used = 1 + visibleWidth(label) + 1;
	return theme.fg("border", "╭") + label + theme.fg("border", `${"─".repeat(Math.max(0, width - used))}╮`);
}

/** Covers the terminal with a bordered component while leaving the host TUI alive. */
export class FullscreenOverlay implements Component {
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly child: Component,
		private readonly title = "",
	) {}

	invalidate(): void {
		this.child.invalidate?.();
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows);
		if (width < 2 || height < 2) return [fitLine("", width)];
		const innerWidth = width - 2;
		const innerHeight = height - 2;
		const content = this.child.render(innerWidth).slice(0, innerHeight);
		while (content.length < innerHeight) content.push("");
		return [
			topBorder(this.theme, this.title, width),
			...content.map((line) => `${this.theme.fg("border", "│")}${fitLine(line, innerWidth)}${this.theme.fg("border", "│")}`),
			this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
		];
	}
}
