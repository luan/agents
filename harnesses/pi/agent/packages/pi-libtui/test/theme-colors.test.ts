import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgb } from "../src/color/palette.ts";
import { createTuiThemeVariation, parseBackgroundAnsi, tuiTheme, tuiThemeAppearance } from "../src/color/theme.ts";
import { terminalColorsRegistry } from "../src/terminal-colors.ts";

afterEach(() => terminalColorsRegistry().publish(undefined));

describe("TUI theme colors", () => {
	test("derives an adjacent TUI theme by shifting surfaces and accent", () => {
		const theme = {
			name: "parent",
			getFgAnsi: (token: string) => (token === "mdHeading" ? "\x1b[38;2;220;120;40m" : "\x1b[38;2;120;160;220m"),
			getBgAnsi: (token: string) => (token === "toolPendingBg" ? "\x1b[48;2;10;20;30m" : "\x1b[48;2;40;50;60m"),
		} as never as Theme;
		const variation = createTuiThemeVariation(theme, "side");

		expect(variation.name).toBe("side");
		expect(variation.colors.accent).toBe("#dc7828");
		expect(variation.colors.borderAccent).toBe("#dc7828");
		expect(variation.colors.userMessageBg).toBe("#0a141e");
		expect(variation.colors.toolPendingBg).toBe("#28323c");
		expect(variation.colors.syntaxString).toBe("#78a0dc");
	});

	test("derives adjacent application appearance from the active Pi surface", () => {
		const themed = (background: string) =>
			({
				name: "surface",
				getBgAnsi: () => background,
			}) as never as Theme;

		expect(tuiThemeAppearance(themed("\x1b[48;2;20;24;30m"))).toBe("dark");
		expect(tuiThemeAppearance(themed("\x1b[48;2;238;240;245m"))).toBe("light");
	});

	test("exposes generated semantic roles and stable hue swatches", () => {
		const theme = {
			name: "tokyo-night",
			getColorMode: () => "truecolor",
			getFgAnsi: (token: string) =>
				({
					error: "\x1b[38;2;247;118;142m",
					success: "\x1b[38;2;158;206;106m",
					warning: "\x1b[38;2;224;175;104m",
					accent: "\x1b[38;2;122;162;247m",
					border: "\x1b[38;2;59;66;97m",
					mdHeading: "\x1b[38;2;255;158;100m",
					syntaxKeyword: "\x1b[38;2;187;154;247m",
					mdLink: "\x1b[38;2;125;207;255m",
					muted: "\x1b[38;2;86;95;137m",
					dim: "\x1b[38;2;59;66;97m",
					text: "\x1b[39m",
				})[token] ?? "\x1b[39m",
			getBgAnsi: (token: string) => (token === "selectedBg" ? "\x1b[48;2;41;46;66m" : "\x1b[48;2;26;27;38m"),
		} as never as Theme;
		const colors = tuiTheme(theme);
		const green = colors.color({ hue: "green", shade: 5 });
		expect(green).toBe(colors.color({ hue: "green", shade: 5 }));
		expect(colors.bgAnsi(green)).toBe("\x1b[48;2;158;206;106m");
		expect(colors.fgAnsi("border")).toBe("\x1b[38;2;59;66;97m");
		expect(colors.fgAnsi("heading")).toBe("\x1b[38;2;255;158;100m");
		expect(colors.fgAnsi("accent")).toBe("\x1b[38;2;122;162;247m");
		expect(colors.fgAnsi(colors.mixForeground("text.muted", "accent", 0))).toBe(colors.fgAnsi("text.muted"));
		expect(colors.fgAnsi(colors.mixForeground("text.muted", "accent", 1))).toBe(colors.fgAnsi("accent"));
		expect(colors.fgAnsi(colors.adjustForegroundBrightness("accent", 0))).toBe(colors.fgAnsi("accent"));
		const indexedColors = tuiTheme({ ...theme, getColorMode: () => "256color" } as Theme);
		expect(indexedColors.bgAnsi("diff.hunkHover")).not.toBe(indexedColors.bgAnsi("diff.hunk"));
		expect(indexedColors.bgAnsi("diff.hunkGutterHover")).not.toBe(indexedColors.bgAnsi("diff.hunkGutter"));
		const bg = (token: Parameters<typeof colors.bgAnsi>[0]) => parseBackgroundAnsi(colors.bgAnsi(token))!;
		const added = bg("diff.added");
		const removed = bg("diff.removed");
		const addedGutter = bg("diff.addedGutter");
		const removedGutter = bg("diff.removedGutter");
		expect(added.g).toBeGreaterThan(added.r);
		expect(removed.r).toBeGreaterThan(removed.g);
		expect(addedGutter).not.toEqual(added);
		expect(removedGutter).not.toEqual(removed);
		expect(colors.bgAnsi("badge.positive")).toMatch(/^\x1b\[48;2;/);
		expect(colors.fg("positive", "done")).toEndWith("done\x1b[39m");
		const logical = colors.color("accent");
		expect(colors.fg(logical, "custom")).toBe(`${colors.fgAnsi("accent")}custom\x1b[39m`);
		expect(colors.bg(logical, "custom")).toBe(`${colors.bgAnsi(logical)}custom\x1b[49m`);
		expect(() => colors.bgAnsi({} as never)).toThrow("Color must come from a pi-libtui TuiTheme");
	});

	test("re-resolves semantic color handles in the consuming theme", () => {
		const hostTheme = (accent: string): Theme =>
			({
				name: `host-${accent}`,
				getColorMode: () => "truecolor",
				getFgAnsi: (token: string) =>
					token === "accent"
						? accent
						: token === "border" || token === "mdHeading"
							? "\x1b[38;2;70;80;90m"
							: "\x1b[39m",
				getBgAnsi: () => "\x1b[49m",
			}) as never as Theme;
		const first = tuiTheme(hostTheme("\x1b[38;2;10;20;30m"));
		const accent = first.color("accent");
		expect(first.color("border")).not.toBe(first.color("heading"));
		const second = tuiTheme(hostTheme("\x1b[38;2;40;50;60m"));
		expect(second.fg(accent, "accent")).toBe("\x1b[38;2;40;50;60maccent\x1b[39m");
	});

	test("reinterprets indexed opaque colors through the current terminal palette", () => {
		const firstPalette = Array.from({ length: 16 }, (_, index) => rgb(index * 12, index * 6, index * 3));
		const secondPalette = Array.from({ length: 16 }, (_, index) =>
			rgb(255 - index * 12, 255 - index * 6, 255 - index * 3),
		);
		const theme = { name: "harmonious", getColorMode: () => "truecolor" } as Theme;
		terminalColorsRegistry().publish({
			scheme: "dark",
			indexedPalette: "custom",
			defaultBackground: firstPalette[0],
			defaultForeground: firstPalette[15],
			ansiBase16: firstPalette,
		});
		const first = tuiTheme(theme);
		const accent = first.color("accent");
		const firstAnsi = first.fgAnsi("accent");

		terminalColorsRegistry().publish({
			scheme: "light",
			indexedPalette: "custom",
			defaultBackground: secondPalette[0],
			defaultForeground: secondPalette[15],
			ansiBase16: secondPalette,
		});
		const second = tuiTheme(theme);
		expect(second.fgAnsi("accent")).not.toBe(firstAnsi);
		expect(second.fg(accent, "accent")).toBe(`${second.fgAnsi("accent")}accent\x1b[39m`);
	});

	test("derives cursor surfaces away from both dark and light backgrounds", () => {
		const darkTheme = {
			name: "dark-test",
			getColorMode: () => "truecolor",
			getFgAnsi: (token: string) => (token === "text" ? "\x1b[38;2;240;240;240m" : "\x1b[38;2;100;120;140m"),
			getBgAnsi: () => "\x1b[48;2;24;28;36m",
		} as never as Theme;
		const lightTheme = {
			name: "light-test",
			getColorMode: () => "truecolor",
			getFgAnsi: (token: string) => (token === "text" ? "\x1b[38;2;25;25;25m" : "\x1b[38;2;100;120;140m"),
			getBgAnsi: (token: string) => (token === "selectedBg" ? "\x1b[48;2;210;215;225m" : "\x1b[48;2;235;238;242m"),
		} as never as Theme;
		const darkBase = parseBackgroundAnsi(tuiTheme(darkTheme).bgAnsi("surface.base"))!;
		const darkCursor = parseBackgroundAnsi(tuiTheme(darkTheme).bgAnsi("surface.cursor"))!;
		const lightBase = parseBackgroundAnsi(tuiTheme(lightTheme).bgAnsi("surface.base"))!;
		const lightCursor = parseBackgroundAnsi(tuiTheme(lightTheme).bgAnsi("surface.cursor"))!;
		const lightAdded = parseBackgroundAnsi(tuiTheme(lightTheme).bgAnsi("diff.added"))!;
		const lightAddedGutter = parseBackgroundAnsi(tuiTheme(lightTheme).bgAnsi("diff.addedGutter"))!;
		const lightRemoved = parseBackgroundAnsi(tuiTheme(lightTheme).bgAnsi("diff.removed"))!;
		const lightRemovedGutter = parseBackgroundAnsi(tuiTheme(lightTheme).bgAnsi("diff.removedGutter"))!;
		const lightHunk = parseBackgroundAnsi(tuiTheme(lightTheme).bgAnsi("diff.hunk"))!;
		const lightHunkGutter = parseBackgroundAnsi(tuiTheme(lightTheme).bgAnsi("diff.hunkGutter"))!;
		expect(darkCursor.r + darkCursor.g + darkCursor.b).toBeGreaterThan(darkBase.r + darkBase.g + darkBase.b);
		expect(lightCursor.r + lightCursor.g + lightCursor.b).toBeLessThan(lightBase.r + lightBase.g + lightBase.b);
		expect(lightAddedGutter).not.toEqual(lightAdded);
		expect(lightRemovedGutter).not.toEqual(lightRemoved);
		expect(lightHunk.b - Math.max(lightHunk.r, lightHunk.g)).toBeGreaterThan(0);
		expect(lightHunkGutter.b - Math.max(lightHunkGutter.r, lightHunkGutter.g)).toBeGreaterThan(0);
		expect(tuiTheme(lightTheme).fgAnsi("border")).toBe("\x1b[38;2;100;120;140m");
		expect(tuiTheme(lightTheme).bgAnsi("surface.raised")).toBe("\x1b[48;2;235;238;242m");
		expect(tuiTheme(lightTheme).bgAnsi("surface.selected")).toBe("\x1b[48;2;210;215;225m");
		expect(tuiTheme(lightTheme).bgAnsi("surface.inset")).toMatch(/^\x1b\[48;2;/);
		expect(tuiTheme(lightTheme).bgAnsi("surface.inset")).not.toBe("\x1b[48;5;0m");
		const semanticAccent = tuiTheme(darkTheme).color("accent");
		expect(tuiTheme(lightTheme).fg(semanticAccent, "accent")).toBe("\x1b[38;2;100;120;140maccent\x1b[39m");
	});
});
