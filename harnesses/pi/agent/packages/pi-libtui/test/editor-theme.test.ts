import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { semanticEditorTheme } from "../src/editor.ts";
import { tuiTheme } from "../src/index.ts";

describe("semantic editor theme", () => {
	test("maps every native editor role through pi-libtui tokens", () => {
		// type-boundary: the test fixture supplies the Pi Theme methods read by tuiTheme.
		type ThemeFixture = unknown;
		const theme = {
			name: "editor-test",
			getColorMode: () => "truecolor",
			getFgAnsi: (token: string) =>
				({
					accent: "\x1b[38;2;80;120;240m",
					border: "\x1b[38;2;70;80;100m",
					dim: "\x1b[38;2;60;65;75m",
					muted: "\x1b[38;2;90;95;105m",
					text: "\x1b[38;2;230;230;235m",
				})[token] ?? "\x1b[39m",
			getBgAnsi: () => "\x1b[48;2;20;22;28m",
		} as ThemeFixture as Theme;
		const colors = tuiTheme(theme);
		const editor = semanticEditorTheme(theme);

		expect(editor.borderColor("border")).toBe(colors.fg("border", "border"));
		expect(editor.selectList.selectedPrefix("prefix")).toBe(colors.fg("accent", "prefix"));
		expect(editor.selectList.selectedText("selected")).toBe(colors.fg("accent", "selected"));
		expect(editor.selectList.description("description")).toBe(colors.fg("text.muted", "description"));
		expect(editor.selectList.scrollInfo("scroll")).toBe(colors.fg("text.muted", "scroll"));
		expect(editor.selectList.noMatch("empty")).toBe(colors.fg("text.muted", "empty"));
	});
});
