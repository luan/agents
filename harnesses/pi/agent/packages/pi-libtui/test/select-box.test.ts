import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../src/color/theme.ts";
import { SelectBox } from "../src/controls/select-box.ts";

describe("SelectBox", () => {
	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		underline: (text: string) => text,
	} as Theme;

	test("selects immediately without modal action buttons", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const selected: string[] = [];
		const previewed: string[] = [];
		const box = new SelectBox({
			theme,
			bordered: false,
			options: [
				{ value: "one", label: "One" },
				{ value: "two", label: "Two" },
			],
			selected: "one",
			onSelect: (value) => selected.push(value),
			onPreview: (value) => previewed.push(value),
			onCancel() {},
		});
		box.focused = true;

		const rendered = box.render(20).map(stripTerminalSequences).join("\n");
		const initial = box.render(20).join("\n");
		expect(initial).toContain(CURSOR_MARKER);
		const colors = tuiTheme(theme);
		const darkerSelected = colors.adjustForegroundBrightness(colors.color("surface.selected"), -0.08);
		expect(initial).toContain(colors.bgAnsi(darkerSelected));
		expect(initial).not.toContain(colors.bgAnsi("surface.selected"));
		box.onMouse({ type: "move", row: 2, col: 3 } as never);
		const darkerHover = colors.adjustForegroundBrightness(colors.color("surface.hover"), -0.08);
		expect(box.render(20).join("\n")).toContain(colors.bgAnsi(darkerHover));
		expect(rendered.split("\n")[0]).not.toContain("> ");
		expect(rendered).not.toContain("╭");
		expect(rendered).toContain("Two");
		expect(rendered).not.toContain("Save");
		expect(rendered).not.toContain("Cancel");
		box.handleInput("T");
		box.handleInput("w");
		expect(previewed).toEqual(["two"]);
		const filtered = box.render(20).join("\n");
		expect(stripTerminalSequences(filtered)).not.toContain("One");
		expect(filtered).toContain(colors.fgAnsi("highlight"));
		box.handleInput("\r");
		expect(selected).toEqual(["two"]);
	});

	test("supports a full-pane preview surface", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const box = new SelectBox({
			theme,
			title: "Composition",
			bordered: false,
			showHint: true,
			options: [{ value: "compact", label: "Compact" }],
			onSelect() {},
			onCancel() {},
			renderPreview: () => ["large preview"],
		});

		const rendered = box.render(40).map(stripTerminalSequences).join("\n");
		expect(rendered).toStartWith("Composition\n");
		expect(rendered).toContain("large preview");
		expect(rendered).toContain("select");
		expect(rendered).toContain("back");
		expect(rendered).not.toContain("╭");
	});
});
