import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiInputListener } from "@earendil-works/pi-tui";
import { generateColor256, rgb } from "../src/color/palette.ts";
import { parseBackgroundAnsi, tuiTheme } from "../src/color/theme.ts";
import { measureTerminalColors, terminalColorsRegistry } from "../src/terminal-colors.ts";

afterEach(() => terminalColorsRegistry().publish(undefined));

describe("generated TUI colors", () => {
	test("parses only the requested basic SGR destination", () => {
		expect(parseBackgroundAnsi("\x1b[31m\x1b[44m")).toEqual(rgb(0, 0, 128));
		expect(parseBackgroundAnsi("\x1b[91m\x1b[104m")).toEqual(rgb(0, 0, 255));
	});

	test("fills the color cube and grayscale ramp from theme anchors", () => {
		const anchors = [
			rgb(10, 20, 30),
			rgb(200, 20, 20),
			rgb(20, 200, 20),
			rgb(200, 200, 20),
			rgb(20, 20, 200),
			rgb(200, 20, 200),
			rgb(20, 200, 200),
			rgb(230, 230, 230),
		];
		const palette = generateColor256([...anchors, ...anchors], anchors[0]!, anchors[7]!);
		expect(palette).toHaveLength(256);
		expect(palette[16]).toEqual(anchors[0]);
		expect(palette[21]).toEqual(anchors[4]);
		expect(palette[46]).toEqual(anchors[2]);
		expect(palette[196]).toEqual(anchors[1]);
		expect(palette[231]).toEqual(anchors[7]);
		expect(palette[232]).not.toEqual(palette[16]);
		expect(palette[255]).not.toEqual(palette[231]);
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
		expect(colors.fgAnsi("border")).toMatch(/^\x1b\[38;(?:2|5);/);
		expect(colors.fgAnsi("heading")).toMatch(/^\x1b\[38;(?:2|5);/);
		expect(colors.fgAnsi("border")).toBe("\x1b[38;2;59;66;97m");
		expect(colors.fgAnsi("heading")).toBe("\x1b[38;2;255;158;100m");
		expect(colors.fgAnsi("accent")).toBe("\x1b[38;2;122;162;247m");
		expect(colors.fgAnsi(colors.mixForeground("text.muted", "accent", 0))).toBe(colors.fgAnsi("text.muted"));
		expect(colors.fgAnsi(colors.mixForeground("text.muted", "accent", 1))).toBe(colors.fgAnsi("accent"));
		expect(colors.fgAnsi(colors.mixForeground("text.muted", "accent", 0.5))).toBe("\x1b[38;2;91;114;172m");
		expect(colors.bgAnsi("surface.raised")).toBe("\x1b[48;2;26;27;38m");
		expect(colors.bgAnsi("surface.selected")).toBe("\x1b[48;2;41;46;66m");
		const indexedColors = tuiTheme({ ...theme, getColorMode: () => "256color" } as Theme);
		expect(indexedColors.bgAnsi("diff.hunkHover")).not.toBe(indexedColors.bgAnsi("diff.hunk"));
		expect(indexedColors.bgAnsi("diff.hunkGutterHover")).not.toBe(indexedColors.bgAnsi("diff.hunkGutter"));
		const bg = (token: Parameters<typeof colors.bgAnsi>[0]) => parseBackgroundAnsi(colors.bgAnsi(token))!;
		const base = bg("surface.base");
		const inset = bg("surface.inset");
		const added = bg("diff.added");
		const removed = bg("diff.removed");
		const addedGutter = bg("diff.addedGutter");
		const removedGutter = bg("diff.removedGutter");
		const addedEmphasis = bg("diff.addedEmphasis");
		const removedEmphasis = bg("diff.removedEmphasis");
		const hunk = bg("diff.hunk");
		const hunkGutter = bg("diff.hunkGutter");
		expect(inset.r + inset.g + inset.b).toBeLessThanOrEqual(base.r + base.g + base.b);
		expect(hunk.b - hunk.r).toBeGreaterThan(inset.b - inset.r);
		expect(hunkGutter).not.toEqual(hunk);
		const lightness = (color: { r: number; g: number; b: number }) =>
			color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
		expect(lightness(hunk)).toBeGreaterThan(lightness(bg("surface.base")));
		expect(lightness(hunk)).toBeGreaterThan(lightness(hunkGutter));
		expect(hunkGutter.b - hunkGutter.r).toBeGreaterThan(0);
		expect(hunk.b).toBeGreaterThan(hunk.r);
		expect(Math.abs(lightness(added) - lightness(base))).toBeGreaterThan(0);
		expect(Math.abs(lightness(removed) - lightness(base))).toBeGreaterThan(0);
		expect(added.g).toBeGreaterThan(added.r);
		expect(removed.r).toBeGreaterThan(removed.g);
		expect(addedGutter).not.toEqual(base);
		expect(removedGutter).not.toEqual(base);
		expect(lightness(addedGutter)).toBeLessThan(lightness(added));
		expect(lightness(removedGutter)).toBeLessThan(lightness(removed));
		expect(addedGutter.g - addedGutter.r).toBeGreaterThan(0);
		expect(removedGutter.r - removedGutter.g).toBeGreaterThan(0);
		expect(lightness(addedEmphasis) - lightness(added)).toBeGreaterThan(10);
		expect(lightness(removedEmphasis) - lightness(removed)).toBeGreaterThan(10);
		expect(addedEmphasis.g - addedEmphasis.r).toBeGreaterThan(added.g - added.r);
		expect(removedEmphasis.r - removedEmphasis.g).toBeGreaterThan(removed.r - removed.g);
		const cursor = bg("surface.cursor");
		const selected = bg("surface.selected");
		expect(cursor.b).toBeGreaterThan(cursor.r);
		expect(cursor.b).toBeGreaterThan(cursor.g);
		expect(cursor.b - cursor.r).toBeGreaterThan(selected.b - selected.r);
		expect(colors.bgAnsi("badge.positive")).toMatch(/^\x1b\[48;2;/);
		expect(colors.fg("positive", "done")).toEndWith("done\x1b[39m");
		const logical = colors.color("accent");
		expect(colors.fg(logical, "custom")).toBe(`${colors.fgAnsi("accent")}custom\x1b[39m`);
		expect(colors.bg(logical, "custom")).toBe(`${colors.bgAnsi(logical)}custom\x1b[49m`);
		expect(() => colors.bgAnsi({} as never)).toThrow("Color must come from a pi-libtui TuiTheme");
	});

	test("uses terminal indexes for the harmonious theme", () => {
		terminalColorsRegistry().publish({
			scheme: "dark",
			indexedPalette: "generated",
		});
		const theme = { name: "harmonious", getColorMode: () => "truecolor" } as Theme;
		const colors = tuiTheme(theme);
		expect(colors.fgAnsi("positive")).toBe("\x1b[38;5;46m");
		expect(colors.bgAnsi("badge.positive")).toBe("\x1b[48;5;22m");
		expect(colors.fgAnsi("border")).toBe("\x1b[38;5;67m");
		expect(colors.fgAnsi("heading")).toBe("\x1b[38;5;214m");
		expect(colors.bgAnsi("cursor.selected")).toBe("\x1b[48;5;214m");
		expect(colors.bgAnsi("surface.hover")).toBe("\x1b[48;5;18m");
		expect(colors.bgAnsi("diff.hunk")).toBe("\x1b[48;5;18m");
		expect(colors.bgAnsi("diff.hunkGutter")).toBe("\x1b[48;5;17m");
		expect(colors.bgAnsi("diff.added")).toBe("\x1b[48;5;28m");
		expect(colors.bgAnsi("diff.addedGutter")).toBe("\x1b[48;5;22m");
		expect(colors.bgAnsi("diff.removed")).toBe("\x1b[48;5;88m");
		expect(colors.bgAnsi("diff.removedGutter")).toBe("\x1b[48;5;52m");
		expect(colors.fgAnsi("positive")).toBe("\x1b[38;5;46m");
		expect(colors.fgAnsi("negative")).toBe("\x1b[38;5;196m");
		expect(colors.fg(colors.color("negative"), "semantic")).toBe("\x1b[38;5;196msemantic\x1b[39m");
		const background = colors.color("surface.base");
		const contrast = colors.contrastBackground(background);
		expect(contrast).not.toBe(background);
		expect(colors.bgAnsi(contrast)).toBe("\x1b[48;5;231m");
		const lightBackground = colors.color("text.primary");
		const lightContrast = colors.contrastBackground(lightBackground);
		expect(colors.bgAnsi(lightContrast)).toMatch(/^\x1b\[48;5;/);
	});

	test("measures contrast through the active generated palette", () => {
		const anchors = [
			rgb(245, 245, 245),
			rgb(220, 60, 60),
			rgb(50, 180, 70),
			rgb(210, 180, 50),
			rgb(70, 100, 210),
			rgb(180, 70, 200),
			rgb(50, 180, 190),
			rgb(25, 25, 25),
		];
		terminalColorsRegistry().publish({
			scheme: "light",
			indexedPalette: "generated",
			defaultBackground: anchors[0],
			defaultForeground: anchors[7],
			ansiBase16: [...anchors, ...anchors],
		});
		const colors = tuiTheme({ name: "harmonious", getColorMode: () => "truecolor" } as Theme);

		expect(colors.bgAnsi("diff.added")).toBe("\x1b[48;5;22m");
		expect(colors.bgAnsi("diff.addedGutter")).toBe("\x1b[48;5;28m");
		expect(colors.bgAnsi(colors.contrastBackground(colors.color("surface.base")))).toBe("\x1b[48;5;231m");
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

	test("generates the harmonious theme from terminal base16 colors when needed", () => {
		const base16 = Array.from({ length: 16 }, (_, index) => rgb(index * 16, index * 8, index * 4));
		terminalColorsRegistry().publish({
			scheme: "dark",
			indexedPalette: "custom",
			defaultBackground: base16[0],
			defaultForeground: base16[15],
			ansiBase16: base16,
		});
		const theme = { name: "harmonious", getColorMode: () => "truecolor" } as Theme;
		const colors = tuiTheme(theme);
		expect(colors.bgAnsi("surface.base")).toContain("0;0;0m");
		expect(colors.fgAnsi("accent")).toMatch(/^\x1b\[38;2;/);
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
		const lightness = (color: { r: number; g: number; b: number }) =>
			color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
		expect(darkCursor.r + darkCursor.g + darkCursor.b).toBeGreaterThan(darkBase.r + darkBase.g + darkBase.b);
		expect(lightCursor.r + lightCursor.g + lightCursor.b).toBeLessThan(lightBase.r + lightBase.g + lightBase.b);
		expect(lightness(lightAddedGutter)).toBeLessThan(lightness(lightAdded));
		expect(lightness(lightRemovedGutter)).toBeLessThan(lightness(lightRemoved));
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

describe("terminal color detection", () => {
	test("rejects stale or malformed cross-realm profiles", () => {
		expect(() => terminalColorsRegistry().publish({ scheme: "dark", harmonious: true } as never)).toThrow(
			"Invalid pi-libtui terminal color measurements",
		);
		expect(() =>
			terminalColorsRegistry().publish({
				defaultBackground: { r: 1.5, g: 2, b: 3 },
				indexedPalette: "custom",
				scheme: "dark",
			}),
		).toThrow("Invalid pi-libtui terminal color measurements");
	});

	test("publishes an immutable snapshot of measured colors", () => {
		const defaultBackground = { r: 10, g: 20, b: 30 };
		const ansiBase16 = Array.from({ length: 16 }, () => ({ r: 40, g: 50, b: 60 }));
		terminalColorsRegistry().publish({
			defaultBackground,
			ansiBase16,
			indexedPalette: "custom",
			scheme: "dark",
		});
		defaultBackground.r = 200;
		ansiBase16[0]!.g = 200;
		expect(terminalColorsRegistry().current()?.defaultBackground).toEqual(rgb(10, 20, 30));
		expect(terminalColorsRegistry().current()?.ansiBase16?.[0]).toEqual(rgb(40, 50, 60));
	});

	test("detects a harmonious palette without consuming ordinary input", async () => {
		let listener: TuiInputListener | undefined;
		const writes: string[] = [];
		const tui = {
			terminal: {
				write(data: string) {
					writes.push(data);
					if (!data.includes("]10;?")) return;
					listener?.("\x1b]10;rgb:ee/ee/ee\x1b\\");
					listener?.("\x1b]4;16;rgb:1111/1111/1111\x1b\\");
					listener?.("\x1b]4;231;rgb:eeee/eeee/eeee\x1b\\");
				},
			},
			addInputListener(next: TuiInputListener) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			queryTerminalBackgroundColor: async () => rgb(17, 17, 17),
			queryTerminalColorScheme: async () => "dark",
		} as never as TUI;
		const profile = await measureTerminalColors(tui, 10);
		expect(profile.scheme).toBe("dark");
		expect(writes.some((value) => value.includes("]4;231;?"))).toBe(true);
	});

	test("frames split and batched replies while preserving residual input and consuming DA1", async () => {
		let listener: TuiInputListener | undefined;
		const listenerResults: ReturnType<TuiInputListener>[] = [];
		const tui = {
			terminal: {
				write(data: string) {
					if (!data.includes("]10;?")) return;
					listenerResults.push(listener?.("\x1b]10;rgb:aaaa/") as ReturnType<TuiInputListener>);
					listenerResults.push(
						listener?.(
							"bbbb/cccc\x1b\\left\x1b]4;16;rgb:1111/2222/3333\x07\x1b]4;231;rgb:dddd/eeee/ffff\x1b\\\x1b[?1;2cright",
						) as ReturnType<TuiInputListener>,
					);
				},
			},
			addInputListener(next: TuiInputListener) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			queryTerminalBackgroundColor: async () => rgb(17, 17, 17),
			queryTerminalColorScheme: async () => "dark",
		} as never as TUI;

		const profile = await measureTerminalColors(tui, 20);
		expect(profile.defaultForeground).toEqual(rgb(170, 187, 204));
		expect(profile.indexedPalette).toBe("custom");
		expect(profile).not.toHaveProperty("indexed16");
		expect(profile).not.toHaveProperty("indexed231");
		expect(listenerResults).toEqual([{ consume: true }, { data: "leftright" }]);
		expect(listener).toBeUndefined();
	});

	test("quarantines late color replies after timeout without swallowing adjacent input", async () => {
		let listener: TuiInputListener | undefined;
		const tui = {
			terminal: { write() {} },
			addInputListener(next: TuiInputListener) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			queryTerminalBackgroundColor: async () => undefined,
			queryTerminalColorScheme: async () => undefined,
		} as never as TUI;

		await measureTerminalColors(tui, 10);
		expect(listener?.("\x1b]10;rgb:11/22/33\x1b\\typed")).toEqual({ data: "typed" });
	});
});
