import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type DiffsHighlighter,
	getFiletypeFromFileName,
	getHighlighterIfLoaded,
	getSharedHighlighter,
	type SupportedLanguages,
	type ThemedDiffResult,
} from "@pierre/diffs";
import type { TuiForegroundColor } from "./color/theme.ts";
import { tuiTheme } from "./color/theme.ts";
import { sanitizeTuiText } from "./content/terminal-text.ts";
import { RenderedLinesCache } from "./render-cache.ts";

const SHIKI_THEME = "github-dark";
const SYNTAX_LANGUAGES = [
	"c",
	"cpp",
	"csharp",
	"css",
	"dockerfile",
	"elixir",
	"fish",
	"go",
	"graphql",
	"haskell",
	"hcl",
	"html",
	"java",
	"javascript",
	"json",
	"jsx",
	"kotlin",
	"lua",
	"makefile",
	"markdown",
	"ocaml",
	"perl",
	"php",
	"protobuf",
	"python",
	"r",
	"ruby",
	"rust",
	"scss",
	"sql",
	"swift",
	"toml",
	"tsx",
	"typescript",
	"xml",
	"yaml",
	"zsh",
] as const satisfies readonly SupportedLanguages[];
const supportedLanguages = new Set<SupportedLanguages>(SYNTAX_LANGUAGES);
let highlighterReady: Promise<DiffsHighlighter | undefined> | undefined;

export interface SyntaxHighlightSpan {
	readonly text: string;
	readonly foreground?: TuiForegroundColor;
	readonly emphasized?: boolean;
}

export interface SyntaxTextOptions {
	theme: Theme;
	text: string;
	path?: string;
	maxRows?: number;
	maxCharacters?: number;
	requestRender?: () => void;
}

/** Bounded, cached syntax-highlighted source or structured text without a container. */
export class SyntaxText implements Component {
	private readonly cache = new RenderedLinesCache();
	private text: string;
	private syntaxReadyRequested = false;

	constructor(private readonly options: SyntaxTextOptions) {
		// Restored tool details may predate a newly-added presentation field.
		this.text = typeof options.text === "string" ? sanitizeTuiText(options.text) : "";
	}

	setText(text: string): void {
		const normalized = typeof text === "string" ? sanitizeTuiText(text) : "";
		if (normalized === this.text) return;
		this.text = normalized;
		this.cache.clear();
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(0, Math.floor(width));
		if (boundedWidth === 0) return [];
		this.requestSyntaxReady();
		const maximum = finiteBound(this.options.maxCharacters, 200_000, 0);
		const clipped = this.text.length > maximum ? `${this.text.slice(0, Math.max(0, maximum - 1))}…` : this.text;
		const highlighterState = getHighlighterIfLoaded() ? "highlighted" : "plain";
		return this.cache.get(boundedWidth, highlighterState, () => {
			const colors = tuiTheme(this.options.theme);
			const limit = finiteBound(this.options.maxRows, 500, 1);
			const rows: string[] = [];
			let omitted = false;
			const sourceLines = clipped.split("\n");
			const highlightedLines = highlightSyntaxBlock(clipped, this.options.path);
			for (const [lineIndex, line] of sourceLines.entries()) {
				const remainingRows = Math.max(1, limit - rows.length);
				const lineBudget = Math.max(1_024, Math.min(20_000, boundedWidth * remainingRows * 2));
				const lineClipped = line.length > lineBudget;
				const sourceSpans = highlightedLines[lineIndex] ?? [];
				const spans = sourceSpans.map((span) => span.text).join("") === line ? sourceSpans : [{ text: line }];
				const visibleSpans = lineClipped ? [...truncateSyntaxSpans(spans, lineBudget - 1), { text: "…" }] : spans;
				const styled = visibleSpans.map((span) => colors.fg(span.foreground ?? "text.primary", span.text)).join("");
				for (const row of wrapTextWithAnsi(styled, boundedWidth)) {
					rows.push(row);
					if (rows.length > limit) {
						omitted = true;
						break;
					}
				}
				if (lineClipped) omitted = true;
				if (omitted) break;
			}
			if (!omitted) return rows;
			return [
				...rows.slice(0, limit - 1),
				colors.fg("text.muted", truncateToWidth("… output omitted …", boundedWidth, "…")),
			];
		});
	}

	invalidate(): void {
		this.cache.clear();
	}

	private requestSyntaxReady(): void {
		if (this.syntaxReadyRequested || getHighlighterIfLoaded()) return;
		this.syntaxReadyRequested = true;
		void ensureSyntaxHighlighter().then((highlighter) => {
			if (!highlighter) return;
			this.cache.clear();
			this.options.requestRender?.();
		});
	}
}

export function highlightSyntaxBlock(
	text: string,
	path: string | undefined,
): readonly (readonly SyntaxHighlightSpan[])[] {
	const plainLines = plainSyntaxLines(text);
	const highlighter = getHighlighterIfLoaded();
	if (!highlighter) return plainLines;
	const language = languageForPath(path);
	try {
		const root = highlighter.codeToHast(text, {
			lang: language,
			theme: SHIKI_THEME,
			defaultColor: false,
			tokenizeTimeLimit: 0,
		});
		const lines = syntaxSpansFromLines(root);
		while (lines.length < plainLines.length) lines.push([]);
		return lines.slice(0, plainLines.length);
	} catch {
		return plainLines;
	}
}

export function loadedDiffHighlighter(): DiffsHighlighter | undefined {
	return getHighlighterIfLoaded();
}

export function whenSyntaxReady(callback: () => void): void {
	void ensureSyntaxHighlighter().then(callback);
}

function ensureSyntaxHighlighter(): Promise<DiffsHighlighter | undefined> {
	if (highlighterReady) return highlighterReady;
	highlighterReady = getSharedHighlighter({ themes: [SHIKI_THEME], langs: [...SYNTAX_LANGUAGES] }).catch(
		() => undefined,
	);
	return highlighterReady;
}

export function syntaxSpansFromPierreLine(
	node: ThemedDiffResult["code"]["additionLines"][number],
): readonly SyntaxHighlightSpan[] {
	return syntaxSpansFromNode(node);
}

export function syntaxLanguage(path: string | undefined): SupportedLanguages {
	return languageForPath(path);
}

function languageForPath(path: string | undefined): SupportedLanguages {
	if (!path) return "text";
	const language = getFiletypeFromFileName(path);
	return supportedLanguages.has(language) ? language : "text";
}

type PierreSyntaxNode =
	| ReturnType<DiffsHighlighter["codeToHast"]>
	| ReturnType<DiffsHighlighter["codeToHast"]>["children"][number];

function plainSyntaxLines(text: string): readonly (readonly SyntaxHighlightSpan[])[] {
	return text.split("\n").map((line) => (line ? [{ text: line }] : []));
}

function syntaxSpansFromNode(node: PierreSyntaxNode): readonly SyntaxHighlightSpan[] {
	const spans: SyntaxHighlightSpan[] = [];
	collectSyntaxSpans(node, undefined, false, spans);
	return spans;
}

function syntaxSpansFromLines(node: PierreSyntaxNode): SyntaxHighlightSpan[][] {
	const lines: SyntaxHighlightSpan[][] = [[]];
	for (const span of syntaxSpansFromNode(node)) {
		const values = span.text.split("\n");
		for (const [index, value] of values.entries()) {
			pushSpan(lines.at(-1)!, { ...span, text: value });
			if (index < values.length - 1) lines.push([]);
		}
	}
	return lines;
}

function truncateSyntaxSpans(
	spans: readonly SyntaxHighlightSpan[],
	maximumCharacters: number,
): readonly SyntaxHighlightSpan[] {
	let remaining = Math.max(0, maximumCharacters);
	const truncated: SyntaxHighlightSpan[] = [];
	for (const span of spans) {
		if (remaining === 0) break;
		const text = span.text.slice(0, remaining);
		if (!text) continue;
		truncated.push({ ...span, text });
		remaining -= text.length;
	}
	return truncated;
}

function collectSyntaxSpans(
	node: PierreSyntaxNode,
	foreground: TuiForegroundColor | undefined,
	emphasized: boolean,
	spans: SyntaxHighlightSpan[],
): void {
	if (node.type === "text") {
		pushSpan(spans, { text: node.value, foreground, emphasized });
		return;
	}
	if (node.type !== "root" && node.type !== "element") return;
	const properties = node.type === "element" ? node.properties : undefined;
	const nextForeground =
		foregroundFromStyle(typeof properties?.style === "string" ? properties.style : undefined) ?? foreground;
	const nextEmphasized = emphasized || (properties !== undefined && "data-diff-span" in properties);
	for (const child of node.children) collectSyntaxSpans(child, nextForeground, nextEmphasized, spans);
}

function pushSpan(spans: SyntaxHighlightSpan[], span: SyntaxHighlightSpan): void {
	if (!span.text) return;
	const previous = spans.at(-1);
	if (previous && sameForeground(previous.foreground, span.foreground) && previous.emphasized === span.emphasized) {
		spans[spans.length - 1] = { ...previous, text: previous.text + span.text };
		return;
	}
	spans.push(span);
}

function sameForeground(left: TuiForegroundColor | undefined, right: TuiForegroundColor | undefined): boolean {
	if (left === right) return true;
	if (typeof left === "string" || typeof right === "string" || !left || !right) return false;
	return left.hue === right.hue && left.shade === right.shade;
}

function foregroundFromStyle(style: string | undefined): TuiForegroundColor | undefined {
	const match = /(?:^|;)color:\s*#([0-9a-f]{6})(?:;|$)/iu.exec(style ?? "");
	if (!match) return undefined;
	const value = match[1]!;
	const red = Number.parseInt(value.slice(0, 2), 16) / 255;
	const green = Number.parseInt(value.slice(2, 4), 16) / 255;
	const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
	const maximum = Math.max(red, green, blue);
	const minimum = Math.min(red, green, blue);
	const lightness = (maximum + minimum) / 2;
	const delta = maximum - minimum;
	if (delta < 0.08) return { hue: "gray", shade: shade(lightness) };
	let hue = 0;
	if (maximum === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
	else if (maximum === green) hue = ((blue - red) / delta + 2) / 6;
	else hue = ((red - green) / delta + 4) / 6;
	const semanticHue =
		hue < 1 / 24 || hue >= 23 / 24
			? "red"
			: hue < 5 / 24
				? "yellow"
				: hue < 10 / 24
					? "green"
					: hue < 14 / 24
						? "cyan"
						: hue < 19 / 24
							? "blue"
							: "magenta";
	return { hue: semanticHue, shade: shade(lightness) };
}

function shade(lightness: number): 0 | 1 | 2 | 3 | 4 | 5 {
	return Math.max(0, Math.min(5, Math.round(lightness * 5))) as 0 | 1 | 2 | 3 | 4 | 5;
}

function finiteBound(value: number | undefined, fallback: number, minimum: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}
