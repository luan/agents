import { afterEach, describe, expect, test } from "bun:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { rgb } from "../src/color/palette.ts";
import { tuiTheme } from "../src/color/theme.ts";
import { type MeasuredTerminalColors, terminalColorsRegistry } from "../src/terminal-colors.ts";
import harmonious from "../themes/harmonious.json";

afterEach(() => terminalColorsRegistry().publish(undefined));

describe("harmonious theme", () => {
	test.each([undefined, { scheme: "dark", indexedPalette: "unknown" }] satisfies (
		| MeasuredTerminalColors
		| undefined
	)[])("uses terminal indexes when color reports are missing: %j", (measurements) => {
		terminalColorsRegistry().publish(measurements);
		const theme = new Theme(harmonious.colors, harmonious.colors, "truecolor", { name: "harmonious" });
		const colors = tuiTheme(theme);
		expect(colors.bgAnsi("surface.base")).toBe("\x1b[48;5;16m");
		expect(colors.fgAnsi("accent")).toBe("\x1b[38;5;21m");
		expect(colors.fgAnsi("positive")).toBe("\x1b[38;5;46m");
		expect(colors.bgAnsi("surface.raised")).toBe("\x1b[48;5;233m");
		expect(colors.bgAnsi("surface.editor")).toBe("\x1b[48;5;233m");
	});

	test("generates colors from a measured custom base16 palette", () => {
		const base16 = Array.from({ length: 16 }, (_, index) => rgb(index * 16, index * 8, index * 4));
		terminalColorsRegistry().publish({
			scheme: "dark",
			indexedPalette: "custom",
			defaultBackground: base16[0],
			defaultForeground: base16[15],
			ansiBase16: base16,
		});
		const colors = tuiTheme({ name: "harmonious", getColorMode: () => "truecolor" } as Theme);
		expect(colors.bgAnsi("surface.base")).toContain("0;0;0m");
		expect(colors.fgAnsi("accent")).toMatch(/^\x1b\[38;2;/);
	});
});
