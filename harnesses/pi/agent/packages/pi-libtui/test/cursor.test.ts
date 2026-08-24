import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { tuiTheme } from "../src/color/theme.ts";
import { SemanticInput } from "../src/controls/semantic-input.ts";
import {
	findCursorRole,
	markEditorCursor,
	removeUnmarkedEditorCursor,
	renderSemanticCursor,
	renderVirtualCursor,
} from "../src/cursor.ts";

describe("TUI cursor cleanup", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("removes the unfocused editor cursor without removing native selection", () => {
		expect(removeUnmarkedEditorCursor("prompt \x1b[7m界\x1b[0m rest")).toBe("prompt 界 rest");
		expect(removeUnmarkedEditorCursor("prompt \x1b[7m界\x1b[27m rest")).toBe("prompt \x1b[7m界\x1b[27m rest");
		expect(removeUnmarkedEditorCursor("prompt \x1b_pi:c\x07\x1b[7m界\x1b[0m rest")).toBe(
			"prompt \x1b_pi:c\x07\x1b[7m界\x1b[0m rest",
		);
	});

	test("leaves multi-grapheme inverse styling alone", () => {
		const line = "prompt \x1b[7mtext\x1b[0m rest";
		expect(removeUnmarkedEditorCursor(line)).toBe(line);
	});

	test("marks a focused wrapped editor cursor when Pi omitted its marker", () => {
		expect(markEditorCursor("prompt \x1b[7m界\x1b[0m rest")).toBe("prompt \x1b_pi:c\x07\x1b[7m界\x1b[0m rest");
		expect(markEditorCursor("prompt \x1b_pi:c\x07\x1b[7m界\x1b[0m rest")).toContain("\x1b_pi:c\x07");
	});

	test("preserves Pi's native cursor styling when Pi already emitted its marker", () => {
		const line = markEditorCursor("before \x1b_pi:c\x07\x1b[7m界\x1b[0m after");
		expect(line).toBe("before \x1b_pi:c\x07\x1b[7m界\x1b[0m after");
	});

	test("renders a virtual cursor through libtui's semantic surface and text colors", () => {
		const theme = {
			name: "harmonious",
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			getFgAnsi: () => "",
			getBgAnsi: () => "",
		} as unknown as Theme;
		const rendered = renderVirtualCursor(theme, " ");
		expect(rendered).toContain("\x1b[7m \x1b[27m");
	});

	test("can render a softer virtual cursor from a semantic surface", () => {
		const theme = {
			name: "harmonious",
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			getFgAnsi: () => "",
			getBgAnsi: () => "",
		} as unknown as Theme;
		configureTuiAppearance({ softCursor: true });
		const rendered = renderVirtualCursor(theme, " ");
		const colors = tuiTheme(theme);
		expect(rendered).toBe(colors.bg("surface.cursor", colors.fg("text.primary", " ")));
		expect(rendered).not.toContain("\x1b[7m");
	});

	test("renders an active copy cursor with the high-contrast amber cursor", () => {
		const theme = {
			name: "harmonious",
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			getFgAnsi: () => "",
			getBgAnsi: () => "",
		} as unknown as Theme;
		const colors = tuiTheme(theme);
		expect(renderVirtualCursor(theme, "x", { selected: true })).toBe(
			`\x1b[1m${colors.fgAnsi("cursor.selectedText")}${colors.bgAnsi("cursor.selected")}x\x1b[0m`,
		);
	});

	test("lets copy mode opt into the softer cursor surface", () => {
		const theme = {
			name: "harmonious",
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			getFgAnsi: () => "",
			getBgAnsi: () => "",
		} as unknown as Theme;
		configureTuiAppearance({ softCursor: true });
		const colors = tuiTheme(theme);
		expect(renderVirtualCursor(theme, "x", { mode: "copy" })).toBe(
			`\x1b[1m${colors.fgAnsi("text.primary")}${colors.bgAnsi("surface.cursor")}x\x1b[0m`,
		);
	});

	test("keeps an IME marker for virtual insertion but not virtual navigation", () => {
		const theme = {
			name: "harmonious",
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			getFgAnsi: () => "",
			getBgAnsi: () => "",
		} as unknown as Theme;
		expect(renderSemanticCursor(theme, "x", { role: "insertion" })).toContain("\x1b_pi:c\x07");
		expect(renderSemanticCursor(theme, "x", { role: "navigation" })).not.toContain("\x1b_pi:c\x07");
	});

	test("pairs a role only with Pi's selected cursor marker", () => {
		configureTuiAppearance({ insertionCursor: "blinking-bar", navigationCursor: "steady-bar" });
		const insertion = renderSemanticCursor({} as Theme, "x", { role: "insertion" });
		const navigation = renderSemanticCursor({} as Theme, "y", { role: "navigation" });
		expect(findCursorRole([`${insertion}${navigation}`], 1)).toBe("insertion");
		expect(findCursorRole([`\x1b_pi:c\x07x${navigation}`], 1)).toBeUndefined();
		expect(findCursorRole([navigation], 1)).toBe("navigation");
		expect(findCursorRole([navigation, "stale \x1b_pi-libtui:cursor:insertion\x07"], 2)).toBe("navigation");
	});

	test("does not invent a semantic cursor for an unfocused editor", () => {
		const rendered = markEditorCursor("prompt \x1b[7m界\x1b[0m rest", { theme: {} as Theme, role: "insertion" });
		expect(rendered).toBe("prompt 界 rest");
		expect(rendered).not.toContain("\x1b_pi:c\x07");
	});

	test("restyles Pi Input's SGR 27 cursor and removes it when unfocused", () => {
		configureTuiAppearance({ insertionCursor: "blinking-bar" });
		const input = new SemanticInput({} as Theme);
		input.setValue("abc");
		input.focused = true;
		const focused = input.render(20).join("\n");
		expect(focused).toContain("\x1b_pi:c\x07\x1b_pi-libtui:cursor:insertion\x07");
		expect(focused).not.toContain("\x1b[7m");
		input.focused = false;
		const unfocused = input.render(20).join("\n");
		expect(unfocused).not.toContain("\x1b_pi:c\x07");
		expect(unfocused).not.toContain("\x1b[7m");
	});
});
