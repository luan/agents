import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type MeasuredTerminalColors, terminalColorsRegistry } from "../terminal-colors.ts";
import {
	color256Index,
	generateColor256,
	gray256Index,
	type RgbColor,
	rgb,
	swatch,
	type TuiSwatch,
	xtermColor,
	yiqLuminance,
} from "./palette.ts";
import { type ColorValue, createColorResolver } from "./resolver.ts";

export type { TuiHue, TuiShade, TuiSwatch } from "./palette.ts";

export type TuiForegroundToken =
	| "text.primary"
	| "text.secondary"
	| "text.muted"
	| "border"
	| "heading"
	| "cursor.idleText"
	| "cursor.selectedText"
	| "accent"
	| "info"
	| "positive"
	| "highlight"
	| "warning"
	| "negative";

export type TuiBackgroundToken =
	| "surface.base"
	| "surface.editor"
	| "surface.accent"
	| "surface.raised"
	| "surface.inset"
	| "surface.cursor"
	| "surface.selected"
	| "surface.hover"
	| "cursor.idle"
	| "cursor.selected"
	| "action.neutral"
	| "action.positive"
	| "action.warning"
	| "action.negative"
	| "badge.neutral"
	| "badge.positive"
	| "badge.warning"
	| "badge.negative"
	| "diff.hunk"
	| "diff.hunkGutter"
	| "diff.hunkHover"
	| "diff.hunkGutterHover"
	| "diff.added"
	| "diff.removed"
	| "diff.addedGutter"
	| "diff.removedGutter"
	| "diff.addedEmphasis"
	| "diff.removedEmphasis";

export type TuiForegroundColor = TuiForegroundToken | TuiSwatch;

const TUI_COLOR_REF: unique symbol = Symbol("pi-libtui-color-ref");

/** Opaque color produced by a TuiTheme. Callers can pass it back but cannot forge palette indexes. */
export interface TuiColor {
	readonly [TUI_COLOR_REF]: ColorRef;
}

export type TuiForegroundPaint = TuiForegroundColor | TuiColor;
export type TuiBackgroundPaint = TuiBackgroundToken | TuiColor;

/** The component-facing semantic color facade. */
export interface TuiTheme {
	color(token: TuiForegroundColor | TuiBackgroundToken): TuiColor;
	mixForeground(from: TuiForegroundPaint, to: TuiForegroundPaint, amount: number): TuiColor;
	adjustForegroundBrightness(paint: TuiForegroundPaint, amount: number): TuiColor;
	fg(paint: TuiForegroundPaint, text: string): string;
	bg(paint: TuiBackgroundPaint, text: string): string;
	fgAnsi(paint: TuiForegroundPaint): string;
	bgAnsi(paint: TuiBackgroundPaint): string;
	contrastBackground(color: TuiColor): TuiColor;
	strongestForegroundContrast(base: TuiForegroundPaint, candidates: readonly TuiForegroundPaint[]): TuiColor;
}

/** Complete Pi theme document derived from a host theme with shifted surfaces for an adjacent TUI. */
export interface TuiThemeVariation {
	readonly $schema: string;
	readonly name: string;
	readonly colors: Readonly<Record<string, string>>;
}

/** Light/dark appearance derived from the surface behind the active Pi theme. */
export type TuiThemeAppearance = "dark" | "light";

type SemanticToken = TuiForegroundToken | TuiBackgroundToken;
type PiThemeBackground = Parameters<Theme["bg"]>[0];
type ColorRef = SemanticToken | ColorValue;
type ColorResolver = ReturnType<typeof createColorResolver>;

interface ThemeAliases {
	readonly secondary?: RgbColor;
	readonly muted?: RgbColor;
	readonly border?: RgbColor;
	readonly heading?: RgbColor;
	readonly raised?: RgbColor;
	readonly editor?: RgbColor;
	readonly selected?: RgbColor;
	readonly accent?: RgbColor;
}

interface CachedTheme {
	readonly fingerprint: string;
	readonly measurements: MeasuredTerminalColors | undefined;
	readonly facade: TuiTheme;
	readonly resolver: ColorResolver;
}

const themeCache = new WeakMap<Theme, CachedTheme>();

export function tuiTheme(theme: Theme): TuiTheme {
	return ensureCachedTheme(theme).facade;
}

/** Resolve the active Pi surface appearance for adjacent applications that cannot query the outer terminal. */
export function tuiThemeAppearance(theme: Theme): TuiThemeAppearance {
	const background =
		terminalColorsRegistry().current()?.defaultBackground ??
		hostBackgroundColor(theme, "toolPendingBg") ??
		rgb(24, 24, 24);
	return yiqLuminance(background) > 127 ? "light" : "dark";
}

const VARIATION_FOREGROUND_TOKENS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"searchMatchText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
] as const satisfies readonly ThemeColor[];

const VARIATION_BACKGROUND_TOKENS = [
	"selectedBg",
	"scrollbarThumb",
	"searchMatchBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
] as const satisfies readonly PiThemeBackground[];

/** Derive a complete non-persisted Pi theme that remains related to, but distinct from, its host. */
export function createTuiThemeVariation(theme: Theme, name: string): TuiThemeVariation {
	const colors: Record<string, string> = {};
	for (const token of VARIATION_FOREGROUND_TOKENS) colors[token] = cssColor(hostForegroundColor(theme, token));
	for (const token of VARIATION_BACKGROUND_TOKENS) colors[token] = cssColor(hostBackgroundColor(theme, token));

	const selected = colors.selectedBg ?? "";
	const inset = colors.toolPendingBg ?? selected;
	colors.selectedBg = inset;
	colors.scrollbarThumb = inset;
	colors.searchMatchBg = inset;
	colors.userMessageBg = inset;
	colors.toolPendingBg = selected;
	colors.accent = colors.mdHeading || colors.accent || "";
	colors.borderAccent = colors.accent;
	colors.customMessageLabel = colors.accent;
	colors.toolTitle = colors.accent;

	return {
		$schema:
			"https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
		name,
		colors,
	};
}

function ensureCachedTheme(theme: Theme): CachedTheme {
	const measurements = terminalColorsRegistry().current();
	const fingerprint = themeFingerprint(theme);
	const cached = themeCache.get(theme);
	if (cached && cached.measurements === measurements && cached.fingerprint === fingerprint) return cached;
	const created = createTuiTheme(theme, measurements);
	const entry = { fingerprint, measurements, ...created };
	themeCache.set(theme, entry);
	return entry;
}

function createTuiTheme(
	theme: Theme,
	measurements: MeasuredTerminalColors | undefined,
): { facade: TuiTheme; resolver: ColorResolver } {
	let resolver: ColorResolver;
	let aliases: ThemeAliases = { editor: hostBackgroundColor(theme, "customMessageBg") };
	if (theme.name === "harmonious" && measurements?.indexedPalette === "generated") {
		const resolvedPalette = measurements.ansiBase16
			? generateColor256(
					measurements.ansiBase16,
					measurements.defaultBackground ?? measurements.ansiBase16[0]!,
					measurements.defaultForeground ?? measurements.ansiBase16[15]!,
				)
			: undefined;
		resolver = createColorResolver({ resolvedPalette, output: "direct-indexed" });
	} else if (theme.name === "harmonious" && measurements?.ansiBase16) {
		const background = measurements.defaultBackground ?? measurements.ansiBase16[0]!;
		const foreground = measurements.defaultForeground ?? measurements.ansiBase16[15]!;
		const resolvedPalette = generateColor256(measurements.ansiBase16, background, foreground);
		resolver = createColorResolver({
			resolvedPalette,
			output: theme.getColorMode?.() === "256color" ? "quantized-indexed" : "truecolor",
		});
	} else {
		const background =
			hostBackgroundColor(theme, "toolPendingBg") ?? measurements?.defaultBackground ?? rgb(24, 24, 24);
		const foreground =
			hostForegroundColor(theme, "text") ?? measurements?.defaultForeground ?? contrastingText(background);
		const anchors = [
			background,
			hostForegroundColor(theme, "error") ?? rgb(204, 4, 3),
			hostForegroundColor(theme, "success") ?? rgb(25, 203, 0),
			hostForegroundColor(theme, "warning") ?? rgb(206, 203, 0),
			hostForegroundColor(theme, "accent") ?? rgb(13, 115, 204),
			hostForegroundColor(theme, "syntaxKeyword") ?? rgb(203, 30, 209),
			hostForegroundColor(theme, "mdLink") ?? rgb(13, 205, 205),
			foreground,
		] as const;
		// Keep the measured theme anchors as the complete ANSI base. Extended colors
		// are generated from these anchors; no post-hoc RGB brightening is applied.
		const base16 = [...anchors, ...anchors];
		const resolvedPalette = generateColor256(base16, background, foreground);
		resolver = createColorResolver({
			resolvedPalette,
			output: theme.getColorMode?.() === "256color" ? "quantized-indexed" : "truecolor",
		});
		aliases = {
			...aliases,
			secondary: hostForegroundColor(theme, "muted"),
			muted: hostForegroundColor(theme, "dim"),
			border: hostForegroundColor(theme, "border"),
			heading: hostForegroundColor(theme, "mdHeading"),
			raised: hostBackgroundColor(theme, "toolPendingBg"),
			selected: hostBackgroundColor(theme, "selectedBg"),
			accent: hostForegroundColor(theme, "accent"),
		};
	}
	return { facade: buildTheme(resolver, aliases), resolver };
}

function buildTheme(resolver: ColorResolver, aliases: ThemeAliases): TuiTheme {
	const background = color256Index(0, 0, 0);
	const foreground = color256Index(5, 5, 5);
	const selected = aliases.selected ?? swatch("blue", 1);
	const selectedCursor = color256Index(5, 3, 0);
	const lightSurface = yiqLuminance(resolver.rgb(background)) > yiqLuminance(resolver.rgb(foreground));
	const editorBase = aliases.editor ?? aliases.raised ?? gray256Index(1);
	const editorRgb = resolver.rgb(editorBase);
	const editorSurface =
		yiqLuminance(editorRgb) > 127 ? editorBase : rgb(editorRgb.r * 0.78, editorRgb.g * 0.78, editorRgb.b * 0.78);
	const backgroundRgb = resolver.rgb(background);
	const accentRgb = resolver.rgb(aliases.accent ?? swatch("blue", 5));
	const accentSurface = rgb(
		Math.round(backgroundRgb.r * 0.82 + accentRgb.r * 0.18),
		Math.round(backgroundRgb.g * 0.82 + accentRgb.g * 0.18),
		Math.round(backgroundRgb.b * 0.82 + accentRgb.b * 0.18),
	);
	const added = lightSurface ? swatch("green", 2) : swatch("green", 1);
	const removed = lightSurface ? swatch("red", 2) : swatch("red", 1);
	const addedGutter = lightSurface ? swatch("green", 1) : swatch("green", 2);
	const removedGutter = lightSurface ? swatch("red", 1) : swatch("red", 2);
	const semantic = {
		"text.primary": foreground,
		"text.secondary": aliases.secondary ?? gray256Index(12),
		"text.muted": aliases.muted ?? gray256Index(8),
		border: aliases.border ?? color256Index(1, 2, 3),
		heading: aliases.heading ?? color256Index(5, 3, 0),
		"cursor.idleText": background,
		"cursor.selectedText": readableForeground(selectedCursor, background, foreground, resolver),
		accent: aliases.accent ?? swatch("blue", 5),
		info: swatch("cyan", 5),
		positive: swatch("green", 5),
		highlight: color256Index(5, 5, 1),
		warning: swatch("yellow", 5),
		negative: swatch("red", 5),
		"surface.base": background,
		"surface.editor": editorSurface,
		"surface.accent": accentSurface,
		"surface.raised": aliases.raised ?? gray256Index(1),
		"surface.inset": background,
		"surface.cursor": color256Index(0, 1, 2),
		"surface.selected": selected,
		"surface.hover": swatch("blue", 2),
		"cursor.idle": selectedCursor,
		"cursor.selected": selectedCursor,
		"action.neutral": selected,
		"action.positive": swatch("green", 1),
		"action.warning": swatch("yellow", 1),
		"action.negative": swatch("red", 1),
		"badge.neutral": aliases.raised ?? gray256Index(2),
		"badge.positive": swatch("green", 1),
		"badge.warning": swatch("yellow", 1),
		"badge.negative": swatch("red", 1),
		// Hunk headers are structural separators, not selected rows. Keep the
		// narrow fold cell one blue step brighter than the full header surface.
		"diff.hunk": swatch("blue", 1),
		"diff.hunkGutter": swatch("blue", 2),
		"diff.hunkHover": swatch("blue", 2),
		"diff.hunkGutterHover": swatch("blue", 3),
		"diff.added": added,
		"diff.removed": removed,
		"diff.addedGutter": addedGutter,
		"diff.removedGutter": removedGutter,
		"diff.addedEmphasis": swatch("green", 3),
		"diff.removedEmphasis": swatch("red", 3),
	} as const satisfies Record<SemanticToken, ColorValue>;
	const publicColors = new Map<ColorRef, TuiColor>();
	const publicColor = (ref: ColorRef): TuiColor => {
		const cached = publicColors.get(ref);
		if (cached) return cached;
		const color = createColor(ref);
		publicColors.set(ref, color);
		return color;
	};
	const refForPaint = (paint: TuiForegroundPaint | TuiBackgroundPaint): ColorRef => {
		if (typeof paint === "string") return paint;
		if ("hue" in paint) return swatch(paint.hue, paint.shade);
		return requireColorRef(paint);
	};
	const resolve = (ref: ColorRef): ColorValue => {
		if (typeof ref !== "string") return ref;
		const value = semantic[ref];
		if (value === undefined) throw new Error(`Unknown pi-libtui semantic color: ${ref}`);
		return value;
	};
	const ansi = (ref: ColorRef, background: boolean): string => resolver.ansi(resolve(ref), background);
	const paint = (ref: ColorRef, text: string, backgroundColor: boolean): string =>
		`${ansi(ref, backgroundColor)}${text}${backgroundColor ? "\x1b[49m" : "\x1b[39m"}`;
	const facade: TuiTheme = {
		color: (color) => publicColor(typeof color === "string" ? color : swatch(color.hue, color.shade)),
		mixForeground(from, to, amount) {
			const left = resolver.rgb(resolve(refForPaint(from)));
			const right = resolver.rgb(resolve(refForPaint(to)));
			const position = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
			return createColor(
				rgb(
					left.r + (right.r - left.r) * position,
					left.g + (right.g - left.g) * position,
					left.b + (right.b - left.b) * position,
				),
			);
		},
		adjustForegroundBrightness(paint, amount) {
			const source = resolver.rgb(resolve(refForPaint(paint)));
			const position = Math.max(-1, Math.min(1, Number.isFinite(amount) ? amount : 0));
			const adjust =
				position < 0
					? (channel: number) => channel * (1 + position)
					: (channel: number) => channel + (255 - channel) * position;
			return createColor(rgb(adjust(source.r), adjust(source.g), adjust(source.b)));
		},
		fg(paintColor, text) {
			return paint(refForPaint(paintColor), text, false);
		},
		bg(paintColor, text) {
			return paint(refForPaint(paintColor), text, true);
		},
		fgAnsi(paintColor) {
			return ansi(refForPaint(paintColor), false);
		},
		bgAnsi(paintColor) {
			return ansi(refForPaint(paintColor), true);
		},
		contrastBackground(color) {
			return createColor(resolver.contrast(resolve(requireColorRef(color))));
		},
		strongestForegroundContrast(base, candidates) {
			const baseValue = resolve(refForPaint(base));
			let strongest = baseValue;
			let ratio = 1;
			for (const candidate of candidates) {
				const value = resolve(refForPaint(candidate));
				const next = resolver.contrastRatio(baseValue, value);
				if (next <= ratio) continue;
				strongest = value;
				ratio = next;
			}
			return createColor(strongest);
		},
	};
	return Object.freeze(facade);
}

/** Parse an external SGR background at an ANSI boundary. Internal colors never round-trip through ANSI. */
export function parseBackgroundAnsi(ansi: string): RgbColor | undefined {
	return parseAnsiColor(ansi, "background");
}

/** Derive a contrast color for content embedded in a caller-supplied ANSI background. */
export function contrastBackgroundColor(theme: Theme, surroundingBackgroundAnsi: string): TuiColor {
	const resolver = ensureCachedTheme(theme).resolver;
	const background =
		parseBackgroundAnsi(surroundingBackgroundAnsi) ??
		terminalColorsRegistry().current()?.defaultBackground ??
		hostBackgroundColor(theme, "toolPendingBg") ??
		rgb(24, 24, 24);
	return createColor(resolver.contrast(background));
}

function createColor(ref: ColorRef): TuiColor {
	return Object.freeze({ [TUI_COLOR_REF]: ref });
}

function requireColorRef(color: TuiColor): ColorRef {
	const ref = color[TUI_COLOR_REF];
	if (ref === undefined) throw new TypeError("Color must come from a pi-libtui TuiTheme");
	return ref;
}

function readableForeground(
	background: ColorValue,
	left: ColorValue,
	right: ColorValue,
	resolver: ColorResolver,
): ColorValue {
	const source = resolver.rgb(background);
	const distance = (candidate: ColorValue) => Math.abs(yiqLuminance(source) - yiqLuminance(resolver.rgb(candidate)));
	return distance(left) >= distance(right) ? left : right;
}

function hostForegroundColor(theme: Theme, token: ThemeColor): RgbColor | undefined {
	return typeof theme.getFgAnsi === "function" ? parseAnsiColor(theme.getFgAnsi(token), "foreground") : undefined;
}

function hostBackgroundColor(theme: Theme, token: PiThemeBackground): RgbColor | undefined {
	return typeof theme.getBgAnsi === "function" ? parseAnsiColor(theme.getBgAnsi(token), "background") : undefined;
}

function parseAnsiColor(ansi: string, kind: "foreground" | "background"): RgbColor | undefined {
	const prefix = kind === "foreground" ? 38 : 48;
	const truecolor = new RegExp(`\\x1b\\[${prefix};2;(\\d+);(\\d+);(\\d+)m`, "u").exec(ansi);
	if (truecolor) return rgb(Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3]));
	const indexed = new RegExp(`\\x1b\\[${prefix};5;(\\d+)m`, "u").exec(ansi);
	if (indexed) return xtermColor(Number(indexed[1]));
	const basic = new RegExp(kind === "foreground" ? "\\x1b\\[(3[0-7]|9[0-7])m" : "\\x1b\\[(4[0-7]|10[0-7])m", "u").exec(
		ansi,
	);
	if (!basic) return undefined;
	const code = Number(basic[1]);
	const index = code >= 100 ? code - 92 : code >= 90 ? code - 82 : code >= 40 ? code - 40 : code - 30;
	return xtermColor(index);
}

function cssColor(color: RgbColor | undefined): string {
	if (!color) return "";
	const channel = (value: number) =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function themeFingerprint(theme: Theme): string {
	const colors = [
		"error",
		"success",
		"warning",
		"accent",
		"border",
		"mdHeading",
		"syntaxKeyword",
		"mdLink",
		"text",
		"muted",
		"dim",
	] as const satisfies readonly ThemeColor[];
	const foregrounds = typeof theme.getFgAnsi === "function" ? colors.map((color) => theme.getFgAnsi(color)) : [];
	const backgrounds =
		typeof theme.getBgAnsi === "function"
			? [theme.getBgAnsi("toolPendingBg"), theme.getBgAnsi("customMessageBg"), theme.getBgAnsi("selectedBg")]
			: [];
	const colorMode = typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	return [theme.name ?? "", colorMode, ...backgrounds, ...foregrounds].join("|");
}

function contrastingText(background: RgbColor): RgbColor {
	return yiqLuminance(background) > 127 ? rgb(24, 24, 24) : rgb(232, 232, 232);
}
