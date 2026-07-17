import { rgbFg, scaleRgb, shineText, type ThemeColorSource, themeRoleAnsi, themeRoleToRgb } from "../../../shared/tui";

export type AnimationTheme = ThemeColorSource & {
	bold?(text: string): string;
};

export function highlightTrickle(
	text: string,
	theme: AnimationTheme,
	elapsedMs: number | undefined,
	color = "accent",
): string {
	return shineText(theme, text, elapsedMs, {
		role: color,
		fallback: (value) => theme.fg(color, value),
	});
}

export { rgbFg, scaleRgb };
export const colorAnsi = themeRoleAnsi;
export const colorRgb = themeRoleToRgb;
