import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn } from "@earendil-works/pi-tui";
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
 * Resolve the effective ANSI background at a visible terminal column.
 * @param line Styled terminal line to inspect.
 * @param column Zero-based visible column whose active background is needed.
 * @returns The last applicable background SGR sequence, or the default-background reset.
 */
export function backgroundAnsiAtColumn(line: string, column: number): string {
	const prefix = sliceByColumn(line, 0, Math.max(0, column) + 1, true);
	let background = "\x1b[49m";
	const sgr = /\x1b\[([0-9;]*)m/gu;
	for (const match of prefix.matchAll(sgr)) {
		const params = match[1] === "" ? [0] : match[1]!.split(";").map(Number);
		for (let index = 0; index < params.length; index += 1) {
			const code = params[index];
			if (code === undefined) continue;
			if (code === 0 || code === 49) {
				background = "\x1b[49m";
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				background = `\x1b[${code}m`;
			} else if (code === 48 && params[index + 1] === 5 && params[index + 2] !== undefined) {
				background = `\x1b[48;5;${params[index + 2]}m`;
				index += 2;
			} else if (code === 48 && params[index + 1] === 2 && params[index + 4] !== undefined) {
				background = `\x1b[48;2;${params[index + 2]};${params[index + 3]};${params[index + 4]}m`;
				index += 4;
			} else if (code === 38) {
				// Skip extended foreground parameters. Their RGB/index values can
				// otherwise look like basic background codes in this scan (for
				// example `38;2;45;45;45m` contains the background code 45).
				if (params[index + 1] === 5 && params[index + 2] !== undefined) index += 2;
				else if (params[index + 1] === 2 && params[index + 4] !== undefined) index += 4;
			}
		}
	}
	return background;
}

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
