import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { tuiTheme } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import { DEFAULT_MODEL_ROLE_CATALOG, type ModelRoleName } from "../src/core/catalog.ts";
import { createRolePicker } from "../src/ui/role-picker.ts";

test("role picker renders role metadata and selects a fuzzy-filtered role", () => {
	const selected: Array<ModelRoleName | undefined> = [];
	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
	} as Theme;
	const picker = createRolePicker(
		{ terminal: { rows: 20 }, requestRender() {} },
		theme,
		new KeybindingsManager(TUI_KEYBINDINGS),
		(value) => selected.push(value),
		"balanced",
		DEFAULT_MODEL_ROLE_CATALOG,
	);

	const initial = picker.render(140);
	const visible = stripTerminalSequences(initial.join("\n"));
	expect(visible).toContain("Select model role 4/5");
	expect(visible).toContain("default");
	expect(visible).toContain("subagent");
	expect(visible).toContain("openai-codex/gpt-5.6-sol");
	expect(visible).toContain("medium");
	expect(visible).toContain("nuanced review");
	expect(
		initial.some((line) => line.includes(tuiTheme(theme).bgAnsi("surface.selected")) && line.includes("balanced")),
	).toBe(true);

	picker.handleInput("/");
	for (const character of "time-sensitive") picker.handleInput(character);
	picker.handleInput("\r");
	expect(selected).toEqual(["quick"]);
});

test("role picker delegates row and Save pointer behavior to pi-libtui", () => {
	const selected: Array<ModelRoleName | undefined> = [];
	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	} as Theme;
	const picker = createRolePicker(
		{ terminal: { rows: 20 }, requestRender() {} },
		theme,
		new KeybindingsManager(TUI_KEYBINDINGS),
		(value) => selected.push(value),
		"balanced",
		DEFAULT_MODEL_ROLE_CATALOG,
	);
	const mouse = (type: TuiMouseEvent["type"], row: number, col: number, button: 0 | 1 | 2 = 0): TuiMouseEvent => ({
		type,
		row,
		col,
		screenRow: row,
		screenCol: col,
		button,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	});

	const lines = picker.render(140);
	const quickRow = lines.findIndex((line) => /\bquick\s+openai-codex\/gpt/u.test(stripTerminalSequences(line)));
	const quickColumn = stripTerminalSequences(lines[quickRow]!).indexOf("quick");
	picker.onMouse(mouse("press", quickRow, quickColumn));
	picker.onMouse(mouse("release", quickRow, quickColumn));
	expect(selected).toEqual([]);

	const buttonRow = lines.length - 2;
	const saveColumn = stripTerminalSequences(lines[buttonRow]!).indexOf("Save");
	picker.onMouse(mouse("press", buttonRow, saveColumn));
	picker.onMouse(mouse("release", buttonRow, saveColumn));
	expect(selected).toEqual(["quick"]);
});
