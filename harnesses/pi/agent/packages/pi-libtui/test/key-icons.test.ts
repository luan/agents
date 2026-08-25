import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../src/color/theme.ts";
import { keyIcon, renderKeyHint } from "../src/decoration/glyphs.ts";

// type-boundary: The test fixture implements only the Theme methods consumed by tuiTheme.
const theme = {
	name: "dark",
	getColorMode: () => "256color",
	getFgAnsi: () => "\x1b[38;5;245m",
	getBgAnsi: () => "\x1b[48;5;16m",
} as unknown as Theme;

describe("key icons", () => {
	test("maps letters, modifiers, and named keys through Nerd Font glyphs", () => {
		expect(keyIcon("a", "nerd-fonts")).toBe("󰬈");
		expect(keyIcon("c", "nerd-fonts")).toBe("󰬊");
		expect(keyIcon("z", "nerd-fonts")).toBe("󰬡");
		expect(keyIcon("ctrl+super+alt+shift+c", "nerd-fonts")).toBe("󰘴 󰘳 󰘵 󰘶 󰬊");
		expect(keyIcon("space", "nerd-fonts")).toBe("󱁐");
		expect(keyIcon("tab", "nerd-fonts")).toBe("󰌒");
		expect(keyIcon("return", "nerd-fonts")).toBe("󰌑");
		expect(keyIcon("backspace", "nerd-fonts")).toBe("󰁮");
		expect(keyIcon("escape", "nerd-fonts")).toBe("⎋");
	});

	test("maps portable Unicode hints and keeps unsupported bases literal", () => {
		expect(keyIcon("a", "unicode")).toBe("🅰");
		expect(keyIcon("z", "unicode")).toBe("🆉");
		expect(keyIcon("ctrl+super+alt+shift+c", "unicode")).toBe("⌃ ⌘ ⌥ ⇧ 🅲");
		expect(keyIcon("space", "unicode")).toBe("␣");
		expect(keyIcon("f12", "unicode")).toBe("f12");
		expect(stripTerminalSequences(renderKeyHint(theme, "c", "unicode"))).toBe("🅲︎");
	});

	test("uses a subdued semantic keycap, contrast foreground, and destination reset", () => {
		const colors = tuiTheme(theme);
		const dark = renderKeyHint(theme, "enter", "unicode", colors.color("surface.base"));
		const light = renderKeyHint(theme, "enter", "unicode", colors.color("text.primary"));
		expect(stripTerminalSequences(dark)).toBe("⏎");
		expect(stripTerminalSequences(light)).toBe("⏎");
		expect(dark).toContain(colors.bgAnsi("badge.neutral"));
		expect(light).toContain(colors.bgAnsi("badge.neutral"));
		expect(dark).toContain(colors.bgAnsi(colors.color("surface.base")));
		expect(dark).toEndWith(colors.bgAnsi(colors.color("surface.base")));
		expect(light).toEndWith(colors.bgAnsi(colors.color("text.primary")));
		expect(visibleWidth(dark)).toBe(1);
		expect(dark).not.toBe(light);
		for (const destination of [
			"surface.selected",
			"badge.neutral",
			"diff.added",
			"diff.removed",
			"diff.hunk",
		] as const) {
			const rendered = renderKeyHint(theme, "c", "unicode", colors.color(destination));
			expect(rendered).toEndWith(colors.bgAnsi(destination));
			expect(visibleWidth(rendered)).toBe(1);
		}
	});
});
