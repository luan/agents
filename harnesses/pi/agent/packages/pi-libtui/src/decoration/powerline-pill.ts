import { backgroundAnsiAtColumn } from "../terminal/color-compatibility.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getTuiAppearance } from "../appearance.ts";
import {
	contrastBackgroundColor,
	type TuiBackgroundPaint,
	type TuiColor,
	type TuiForegroundPaint,
	tuiTheme,
} from "../color/theme.ts";
import { getTuiPillSeparators, type PillContent, pillIcon } from "./glyphs.ts";

/**
 * Generate a pill surface that contrasts with its destination background.
 * @param theme Active Pi theme used for semantic color generation and fallback background discovery.
 * @param surroundingBackgroundAnsi ANSI state at the destination surface.
 * @returns A resolved logical background suitable for `renderPill()`.
 */
export function contrastingPillBackground(theme: Theme, surroundingBackgroundAnsi: string): TuiColor {
	const background = backgroundAnsiAtColumn(`${surroundingBackgroundAnsi} `, 1);
	return contrastBackgroundColor(theme, background);
}

/**
 * Render a semantic label whose caps exactly match its body background.
 * @param theme Active Pi theme used to resolve semantic and explicit colors.
 * @param content Required icon decision and label; the label may contain non-background terminal styling.
 * @param background Semantic or resolved logical pill surface.
 * @param foreground Semantic foreground or generated swatch for the label.
 * @param surroundingBackground Semantic or explicit destination surface restored around the caps.
 * @param surroundingBackgroundAnsi Exact destination ANSI background; takes precedence over `surroundingBackground`.
 * @param rounded Whether to use Powerline caps; defaults to the active appearance setting.
 * @returns ANSI-styled pill text with the destination background restored after both caps.
 */
export function renderPill(
	theme: Theme,
	content: PillContent,
	background: TuiBackgroundPaint,
	foreground: TuiForegroundPaint,
	surroundingBackground?: TuiBackgroundPaint,
	surroundingBackgroundAnsi?: string,
	rounded = getTuiAppearance().powerline,
): string {
	const colors = tuiTheme(theme);
	const destinationBackground =
		surroundingBackgroundAnsi ?? (surroundingBackground ? colors.bgAnsi(surroundingBackground) : undefined);
	const restore = destinationBackground ?? "\x1b[49m";
	const capColor = colors.fgAnsi(typeof background === "string" ? colors.color(background) : background);
	const effectiveForeground =
		foreground === "text.primary"
			? colors.contrastBackground(typeof background === "string" ? colors.color(background) : background)
			: foreground;
	const [leftSeparator, rightSeparator] = getTuiPillSeparators(rounded);
	// compositeTuiLine resets the style immediately before an overlay. Restore
	// the destination background before the left cap or its transparent corner
	// is painted with the terminal default instead of the container surface.
	const left = `${destinationBackground ?? ""}${capColor}${leftSeparator}\x1b[39m${destinationBackground ?? ""}`;
	const glyph = pillIcon(content.icon);
	const bodyContent = glyph
		? content.label
			? `${colors.fg(content.iconTone ?? effectiveForeground, glyph)} ${colors.fg(effectiveForeground, content.label)}`
			: colors.fg(content.iconTone ?? effectiveForeground, glyph)
		: colors.fg(effectiveForeground, content.label);
	const body = colors.bg(background, bodyContent);
	const right = `${restore}${capColor}${rightSeparator}\x1b[39m${restore}`;
	return `${left}${body}${right}`;
}
