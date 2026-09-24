import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "./color/theme.ts";

/** Geometry shared by scrollbar painting and pointer interaction. */
export function scrollbarGeometry(height: number, total: number, offset: number) {
	const thumbHeight = Math.max(1, Math.floor((height * height) / Math.max(1, total)));
	const trackHeight = Math.max(0, height - thumbHeight);
	const maxOffset = Math.max(0, total - height);
	const thumbStart = Math.min(trackHeight, Math.floor((Math.max(0, offset) * trackHeight) / Math.max(1, maxOffset)));
	return { thumbHeight, trackHeight, maxOffset, thumbStart };
}

/** Paint the compact scrollbar shared by settings and expanded tool views. */
export function applyScrollbar(
	lines: readonly string[],
	options: { theme: Theme; width: number; height: number; offset: number; total: number },
): string[] {
	const width = Math.max(0, Math.floor(options.width));
	const height = Math.max(0, Math.floor(options.height));
	if (width <= 1 || height === 0 || options.total <= height) return [...lines];
	const output = [...lines];
	const colors = tuiTheme(options.theme);
	const { thumbHeight, thumbStart } = scrollbarGeometry(height, options.total, options.offset);
	const contentWidth = Math.max(0, width - 2);
	for (let row = 0; row < height; row += 1) {
		const line = truncateToWidth(output[row] ?? "", contentWidth, "");
		const padded = `${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))}`;
		const thumb = row >= thumbStart && row < thumbStart + thumbHeight;
		output[row] = `${padded} ${thumb ? colors.fg("accent", "█") : colors.fg("text.muted", "│")}`;
	}
	return output;
}
