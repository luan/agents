import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { type Component, Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { RenderedLinesCache } from "../render-cache.ts";
import { getTuiRenderEpoch } from "../render-epoch.ts";
import { sanitizeTuiText } from "./terminal-text.ts";

/**
 * Builds the complete theme contract required by Pi's native Markdown renderer.
 * Markdown element colors resolve through pi-libtui semantic tokens. Syntax
 * parsing and language coverage remain delegated to Pi's native highlighter;
 * this function is the sole alias boundary that exposes those native syntax
 * colors to consumers.
 *
 * @param theme The active Pi theme used to derive pi-libtui colors and preserve
 * non-color text attributes such as bold, italic, and underline.
 * @returns A Markdown renderer theme whose color ownership stays behind
 * pi-libtui, including the native syntax-highlighting alias.
 */
export function semanticMarkdownTheme(theme: Theme): MarkdownTheme {
	const colors = tuiTheme(theme);
	return {
		heading: (text) => colors.fg("heading", text),
		link: (text) => colors.fg("accent", text),
		linkUrl: (text) => colors.fg("text.secondary", text),
		code: (text) => colors.fg("warning", text),
		codeBlock: (text) => colors.fg("text.primary", text),
		codeBlockBorder: (text) => colors.fg("border", text),
		quote: (text) => colors.fg("text.secondary", text),
		quoteBorder: (text) => colors.fg("border", text),
		hr: (text) => colors.fg("border", text),
		listBullet: (text) => colors.fg("accent", text),
		bold: (text) => theme.bold?.(text) ?? text,
		italic: (text) => theme.italic?.(text) ?? text,
		strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
		underline: (text) => theme.underline?.(text) ?? text,
		// Pi owns parsing and language coverage; pi-libtui owns this native-color alias.
		highlightCode,
	};
}

export interface MarkdownTextOptions {
	readonly theme: Theme;
	readonly text: string;
	readonly maxRows?: number;
	readonly maxCharacters?: number;
}

/** Bounded native Markdown rendering without a card, gutter, or padding. */
export class MarkdownText implements Component {
	private readonly markdown: Markdown;
	private readonly cache = new RenderedLinesCache();
	private renderEpoch = getTuiRenderEpoch();
	private text: string;

	constructor(private readonly options: MarkdownTextOptions) {
		this.text = typeof options.text === "string" ? sanitizeTuiText(options.text) : "";
		this.markdown = new Markdown(this.clippedText(), 0, 0, semanticMarkdownTheme(options.theme));
	}

	setText(text: string): void {
		const normalized = typeof text === "string" ? sanitizeTuiText(text) : "";
		if (normalized === this.text) return;
		this.text = normalized;
		this.markdown.setText(this.clippedText());
		this.cache.clear();
	}

	render(width: number): string[] {
		const epoch = getTuiRenderEpoch();
		if (epoch !== this.renderEpoch) {
			this.renderEpoch = epoch;
			this.markdown.invalidate();
		}
		const boundedWidth = Math.max(0, Math.floor(width));
		if (boundedWidth === 0) return [];
		return this.cache.get(boundedWidth, "current", () => {
			const rows = this.markdown.render(boundedWidth);
			const limit = finiteBound(this.options.maxRows, 500, 1);
			if (rows.length <= limit) return rows;
			return [...rows.slice(0, limit - 1), truncateToWidth("… content omitted …", boundedWidth, "…")];
		});
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.cache.clear();
	}

	private clippedText(): string {
		const maximum = finiteBound(this.options.maxCharacters, 20_000, 0);
		const clipped = this.text.length > maximum ? `${this.text.slice(0, Math.max(0, maximum - 1))}…` : this.text;
		if (clipped.length <= 4_000) return clipped;
		let delimiters = 0;
		for (let index = 0; index < clipped.length; index += 1) {
			if ("*_~`#[](){}|>".includes(clipped[index]!)) delimiters += 1;
		}
		return delimiters > clipped.length / 2 ? `${clipped.slice(0, 1_999)}\n\n… content omitted …` : clipped;
	}
}

function finiteBound(value: number | undefined, fallback: number, minimum: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}
