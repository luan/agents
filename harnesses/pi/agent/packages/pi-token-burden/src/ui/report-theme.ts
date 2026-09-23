import type { Theme } from "@earendil-works/pi-coding-agent";
import { tuiTheme } from "@luan.sh/pi-libtui";

/** The report uses a small, stable visual vocabulary instead of arbitrary colors. */
export function reportColors(theme: Theme) {
	const colors = tuiTheme(theme);
	return {
		measured: (text: string) => colors.fg("text.primary", text),
		estimated: (text: string) => colors.fg("text.secondary", text),
		cached: (text: string) => colors.fg("accent", text),
		unavailable: (text: string) => colors.fg("text.muted", text),
		action: (text: string) => colors.fg("accent", text),
		selected: (text: string) => colors.fg("accent", text),
		muted: (text: string) => colors.fg("text.muted", text),
	};
}
