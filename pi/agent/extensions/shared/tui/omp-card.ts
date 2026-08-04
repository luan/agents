import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth as truncateToWidthRaw } from "@earendil-works/pi-tui";
import { RenderedLineCache } from "./render-cache";

export type OmpTheme = {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	styledSymbol?(name: string, color: string): string;
	spinnerFrames?: string[];
	sep?: { dot?: string };
	tree?: { branch?: string; last?: string; vertical?: string };
	checkbox?: { checked?: string; unchecked?: string };
};

interface OmpSection {
	label?: string;
	lines: readonly string[];
	separator?: boolean;
}

interface OmpCardSpec {
	header: string;
	sections?: readonly OmpSection[];
	borderColor?: string;
}

const symbols: Record<string, string> = {
	"status.success": "✓",
	"status.done": "●",
	"status.error": "✗",
	"status.warning": "⚠",
	"status.pending": "○",
	"status.running": "●",
	"status.aborted": "✗",
	"tool.todo": "☑",
	"tool.task": "◉",
};

let stringEllipsisSupported: boolean | undefined;

function truncateCompat(text: string, width: number, pad = false): string {
	if (stringEllipsisSupported === false) return truncateToWidthRaw(text, width, undefined, pad);
	try {
		const result = truncateToWidthRaw(text, width, "…", pad);
		stringEllipsisSupported = true;
		return result;
	} catch {
		stringEllipsisSupported = false;
		return truncateToWidthRaw(text, width, undefined, pad);
	}
}

export function textComponent(text: string): Text {
	return new Text(text, 0, 0);
}

export function bold(theme: OmpTheme, text: string): string {
	return theme.bold?.(text) ?? text;
}

export function styledSymbol(theme: OmpTheme, name: string, color: string): string {
	return theme.styledSymbol?.(name, color) ?? theme.fg(color, symbols[name] ?? "•");
}

export function treeGlyphs(theme: OmpTheme): { branch: string; last: string; vertical: string } {
	return {
		branch: theme.tree?.branch ?? "├─",
		last: theme.tree?.last ?? "└─",
		vertical: theme.tree?.vertical ?? "│",
	};
}

export function renderStatusLine(
	theme: OmpTheme,
	input: { icon?: string; iconOverride?: string; title: string; description?: string; meta?: string[] },
): string {
	const icon =
		input.iconOverride ??
		(input.icon ? styledSymbol(theme, `status.${input.icon}`, input.icon === "error" ? "error" : "accent") : "");
	const parts = [icon, theme.fg("toolTitle", bold(theme, input.title))].filter(Boolean);
	let line = parts.join(" ");
	if (input.description) line += ` ${theme.fg("muted", input.description)}`;
	if (input.meta?.length) line += ` ${theme.fg("dim", input.meta.join(theme.sep?.dot ?? " · "))}`;
	return line;
}

function fitVisible(line: string, width: number): string {
	return truncateCompat(line, width, true);
}

export class OmpCard implements Component {
	private readonly cache = new RenderedLineCache();

	constructor(
		private readonly theme: OmpTheme,
		private readonly spec: OmpCardSpec,
	) {}

	render(width: number): string[] {
		return this.cache.get(width, "", () => this.renderLines(width));
	}

	private renderLines(width: number): string[] {
		if (width <= 0) return [];
		if (width < 4) return [fitVisible(this.spec.header, width)];
		const safeWidth = width;
		const innerWidth = safeWidth - 4;
		const borderColor = this.spec.borderColor ?? "borderMuted";
		const top = `${this.theme.fg(borderColor, "╭─")} ${fitVisible(this.spec.header, innerWidth)}${this.theme.fg(borderColor, "╮")}`;
		const lines = [top];
		const sections = this.spec.sections ?? [];
		for (const [sectionIndex, section] of sections.entries()) {
			if (section.separator || sectionIndex > 0) {
				lines.push(
					`${this.theme.fg(borderColor, "│")} ${this.theme.fg("dim", "─".repeat(innerWidth))} ${this.theme.fg(borderColor, "│")}`,
				);
			}
			if (section.label) {
				lines.push(
					`${this.theme.fg(borderColor, "│")} ${fitVisible(this.theme.fg("dim", section.label), innerWidth)} ${this.theme.fg(borderColor, "│")}`,
				);
			}
			for (const rawLine of section.lines) {
				lines.push(
					`${this.theme.fg(borderColor, "│")} ${fitVisible(rawLine, innerWidth)} ${this.theme.fg(borderColor, "│")}`,
				);
			}
		}
		lines.push(
			`${this.theme.fg(borderColor, "╰")}${this.theme.fg(borderColor, "─".repeat(safeWidth - 2))}${this.theme.fg(borderColor, "╯")}`,
		);
		return lines;
	}

	invalidate(): void {
		this.cache.clear();
	}
}

export function framedBlock(theme: OmpTheme, spec: OmpCardSpec): OmpCard {
	return new OmpCard(theme, spec);
}
