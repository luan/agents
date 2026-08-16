import type { Component } from "@earendil-works/pi-tui";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { RenderedLineCache } from "./render-cache";
import { paintAnsiBackgroundRow, truncateToWidthCompat } from "./text";

export type CardTheme = {
	fg(color: string, text: string): string;
	// Matches `RenderTheme.getBgAnsi` (tui/types.ts:10). The `string` here was the lie: a role can have no background,
	// `darkerCardBackgroundAnsi` below already guards with `background?.match` and returns undefined, and
	// tui/render-lines.ts:17 falls back with `??`. Narrowing it cost 29 of the 65 errors `fileops` shows when typechecked.
	getBgAnsi?(color: CardBackgroundColor): string | undefined;
	bold?(text: string): string;
	styledSymbol?(name: string, color: string): string;
	spinnerFrames?: string[];
	sep?: { dot?: string };
	tree?: { branch?: string; last?: string; vertical?: string };
	checkbox?: { checked?: string; unchecked?: string };
};

interface CardSection {
	label?: string;
	lines?: readonly string[];
	component?: Component;
	separator?: boolean;
}

export type CardBackgroundColor = "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

interface CardSpec {
	header: string;
	sections?: readonly CardSection[];
	borderColor?: string;
	backgroundColor?: CardBackgroundColor;
	backgroundAnsi?: string;
	visible?: () => boolean;
	cacheKey?: () => string;
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

export function textComponent(text: string): Text {
	return new Text(text, 0, 0);
}

export function bold(theme: CardTheme, text: string): string {
	return theme.bold?.(text) ?? text;
}

export function styledSymbol(theme: CardTheme, name: string, color: string): string {
	return theme.styledSymbol?.(name, color) ?? theme.fg(color, symbols[name] ?? "•");
}

export function treeGlyphs(theme: CardTheme): { branch: string; last: string; vertical: string } {
	return {
		branch: theme.tree?.branch ?? "├─",
		last: theme.tree?.last ?? "└─",
		vertical: theme.tree?.vertical ?? "│",
	};
}

export function renderStatusLine(
	theme: CardTheme,
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

export function darkerCardBackgroundAnsi(
	theme: CardTheme,
	color: CardBackgroundColor = "toolPendingBg",
): string | undefined {
	let background: string | undefined;
	try {
		background = theme.getBgAnsi?.(color);
	} catch {
		return undefined;
	}
	const rgb = background?.match(/\u001b\[48;2;(\d+);(\d+);(\d+)m/);
	if (!rgb) return background;
	const channels = rgb.slice(1).map(Number);
	const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
	const factor = luminance >= 128 ? 0.94 : 0.65;
	return `\u001b[48;2;${channels.map((channel) => Math.round(channel * factor)).join(";")}m`;
}

function fitVisible(line: string, width: number): string {
	return truncateToWidthCompat(line, width, "…", true);
}

export class Card implements Component {
	private readonly cache = new RenderedLineCache();

	constructor(
		private readonly theme: CardTheme,
		private readonly spec: CardSpec,
	) {}

	render(width: number): string[] {
		const visible = this.spec.visible?.() ?? true;
		if (!visible) return [];
		const hasComponent = this.spec.sections?.some((section) => section.component) ?? false;
		if (hasComponent && !this.spec.cacheKey) return this.renderLines(width);
		return this.cache.get(width, this.spec.cacheKey?.() ?? "visible", () => this.renderLines(width));
	}

	private renderLines(width: number): string[] {
		if (width <= 0) return [];
		if (width < 6) return [fitVisible(this.spec.header, width)];
		const borderColor = this.spec.borderColor ?? "borderMuted";
		const border = (text: string) => this.theme.fg(borderColor, text);
		const horizontal = "─";
		const renderBar = (left: string, right: string, label?: string): string => {
			const leftGlyphs = `${left}${horizontal.repeat(3)}`;
			if (!label) {
				return `${border(leftGlyphs)}${border(horizontal.repeat(Math.max(0, width - 5)))}${border(right)}`;
			}
			const rawLabel = ` ${label} `;
			const trimmedLabel = truncateToWidthCompat(rawLabel, Math.max(0, width - 5), "…");
			const fill = horizontal.repeat(Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(trimmedLabel) - 1));
			return `${border(leftGlyphs)}${trimmedLabel}${border(fill)}${border(right)}`;
		};
		const innerWidth = width - 3;
		const lines = [renderBar("╭", "╮", this.spec.header)];
		const sections = this.spec.sections ?? [];
		for (const [sectionIndex, section] of sections.entries()) {
			if (section.label) {
				lines.push(renderBar("├", "┤", section.label));
			} else if (section.separator || sectionIndex > 0) {
				lines.push(renderBar("├", "┤"));
			}
			const sectionLines = [...(section.lines ?? []), ...(section.component?.render(innerWidth) ?? [])];
			for (const rawLine of sectionLines) {
				lines.push(`${border("│")} ${fitVisible(rawLine, innerWidth)}${border("│")}`);
			}
		}
		lines.push(renderBar("╰", "╯"));
		const backgroundAnsi =
			this.spec.backgroundAnsi ?? darkerCardBackgroundAnsi(this.theme, this.spec.backgroundColor ?? "toolPendingBg");
		return backgroundAnsi ? lines.map((line) => paintAnsiBackgroundRow(line, width, backgroundAnsi)) : lines;
	}

	invalidate(): void {
		this.cache.clear();
		for (const section of this.spec.sections ?? []) section.component?.invalidate();
	}
}

export function framedBlock(theme: CardTheme, spec: CardSpec): Card {
	return new Card(theme, spec);
}
