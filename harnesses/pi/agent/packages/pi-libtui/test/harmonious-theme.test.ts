import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgb } from "../src/color/palette.ts";
import { tuiTheme } from "../src/color/theme.ts";
import { terminalColorsRegistry } from "../src/terminal-colors.ts";

afterEach(() => terminalColorsRegistry().publish(undefined));

describe("harmonious theme", () => {
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
