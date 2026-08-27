import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { statusPresentationFrame } from "../src/status-presentation.ts";
import { TUI_STATUS_PRESENTATION_OPTIONS, type TuiStatusPresentationStyle } from "../src/appearance.ts";
import { tuiTheme } from "../src/color/theme.ts";

const theme = {
	name: "status-presentation-test",
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => (token === "accent" ? "\x1b[38;2;80;160;240m" : "\x1b[38;2;180;180;180m"),
	getBgAnsi: () => "\x1b[48;2;20;20;20m",
} as never as Theme;

const colors = tuiTheme(theme);
const activeStyles = TUI_STATUS_PRESENTATION_OPTIONS.map((option) => option.value).filter(
	(style): style is Exclude<TuiStatusPresentationStyle, "standard"> => style !== "standard",
);

describe("standalone status presentation", () => {
	test.each(activeStyles)("renders %s within the requested row width", (style) => {
		for (const width of [10, 24, 48]) {
			const rendered = statusPresentationFrame(colors, style, 500, width);
			expect(rendered).not.toBe("");
			expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
		}
	});

	test.each(activeStyles)("animates %s across real repaint samples", (style) => {
		const frames = [0, 180, 420, 900, 1_800].map((elapsedMs) => statusPresentationFrame(colors, style, elapsedMs, 40));
		expect(new Set(frames).size).toBeGreaterThan(1);
	});

	test.each(activeStyles)("holds %s still for reduced motion", (style) => {
		const first = statusPresentationFrame(colors, style, 0, 40, { reducedMotion: true });
		const later = statusPresentationFrame(colors, style, 4_000, 40, { reducedMotion: true });
		expect(later).toBe(first);
	});
});
