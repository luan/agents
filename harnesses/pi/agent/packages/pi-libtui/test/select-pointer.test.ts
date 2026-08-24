import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { tuiTheme } from "../src/color/theme.ts";
import { MultiSelect } from "../src/controls/multi-select.ts";
import { PickerPanel } from "../src/controls/picker-panel.ts";
import { SearchableSelect } from "../src/controls/searchable-select.ts";
import type { TuiMouseEvent, TuiMouseEventType } from "../src/mouse.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	underline: (text: string) => text,
} as Theme;

function initializeTui(): void {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
}

function mouse(
	type: TuiMouseEventType,
	row: number,
	col = 0,
	properties: Partial<Pick<TuiMouseEvent, "button" | "wheel">> = {},
): TuiMouseEvent {
	return {
		type,
		row,
		col,
		screenRow: row,
		screenCol: col,
		button: undefined,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
		...properties,
	};
}

function click(component: { onMouse(event: TuiMouseEvent): boolean }, row: number, col = 0): void {
	component.onMouse(mouse("press", row, col, { button: 0 }));
	component.onMouse(mouse("release", row, col, { button: 0 }));
}

describe("shared select pointer behavior", () => {
	test("searchable select clicks select without confirming and Save confirms", () => {
		initializeTui();
		const selected: string[] = [];
		const select = new SearchableSelect({
			title: "Mode",
			description: "Choose a mode",
			options: Array.from({ length: 15 }, (_, index) => ({ value: `mode-${index}`, label: `Mode ${index}` })),
			theme,
			onSelect: (value) => selected.push(value),
			onCancel() {},
		});

		select.render(60);
		// Title, description, and the persistent search field occupy rows 0-2.
		expect(select.onMouse(mouse("move", 5))).toBe(true);
		const rendered = select.render(60);
		expect(stripTerminalSequences(rendered[3]!)).toStartWith("→ Mode 0");
		expect(stripTerminalSequences(rendered[5]!)).toStartWith("  Mode 2");
		expect(rendered[5]).toContain("\x1b[48;");
		// Clicking the last visible row must not recenter or confirm it.
		click(select, 14);
		expect(selected).toEqual([]);
		const lines = select.render(60);
		expect(stripTerminalSequences(lines[14]!)).toStartWith("→ Mode 11");
		const saveRow = lines.length - 1;
		const saveColumn = stripTerminalSequences(lines[saveRow]!).indexOf("Save");
		click(select, saveRow, saveColumn);
		expect(selected).toEqual(["mode-11"]);

		select.onMouse(mouse("wheel", 14, 0, { wheel: 1 }));
		select.handleInput("\r");
		expect(selected).toEqual(["mode-11", "mode-12"]);
	});

	test("searchable select keeps fixed pointer rows while filtering", () => {
		initializeTui();
		const selected: string[] = [];
		const select = new SearchableSelect({
			title: "Mode",
			options: [
				{ value: "default", label: "Default" },
				{ value: "minimal", label: "Minimal minimum" },
			],
			theme,
			onSelect: (value) => selected.push(value),
			onCancel() {},
		});
		select.render(40);
		click(select, 1);
		for (const character of "min") select.handleInput(character);
		const filtered = select.render(40);
		// The search field remains row 1 and the filtered option remains row 2.
		expect(stripTerminalSequences(filtered[1]!)).toContain("min");
		expect(stripTerminalSequences(filtered[1]!)).not.toContain("> ");
		expect(filtered[2]).toContain(tuiTheme(theme).fg("warning", "Min"));
		expect(filtered[2]).toContain(tuiTheme(theme).fg("warning", "min"));
		click(select, 2);
		expect(selected).toEqual([]);
		const lines = select.render(40);
		const saveRow = lines.length - 1;
		click(select, saveRow, stripTerminalSequences(lines[saveRow]!).indexOf("Save"));
		expect(selected).toEqual(["minimal"]);
	});

	test("searchable select exposes a mouseable Cancel action", () => {
		initializeTui();
		let cancelled = 0;
		const select = new SearchableSelect({
			title: "Mode",
			options: [{ value: "default", label: "Default" }],
			theme,
			onSelect() {},
			onCancel: () => {
				cancelled += 1;
			},
		});
		const lines = select.render(40);
		const buttonRow = lines.length - 1;
		const cancelColumn = stripTerminalSequences(lines[buttonRow]!).indexOf("Cancel");
		click(select, buttonRow, cancelColumn);
		expect(cancelled).toBe(1);
	});

	test("picker panel delegates clipped row geometry, hover, wheel, and explicit Save", () => {
		initializeTui();
		const selected: string[] = [];
		let cancelled = 0;
		const picker = new PickerPanel({
			tui: { terminal: { rows: 8 }, requestRender() {} },
			theme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Roles",
			options: Array.from({ length: 5 }, (_, index) => ({
				value: `role-${index}`,
				label: `Role ${index}`,
				description: `Description ${index}`,
			})),
			maxVisible: 2,
			onSelect: (value) => selected.push(value),
			onCancel: () => {
				cancelled += 1;
			},
		});

		let lines = picker.render(48);
		expect(lines).toHaveLength(6);
		expect(stripTerminalSequences(lines[2]!)).toContain("│ › Role 0  Description 0");
		expect(stripTerminalSequences(lines[3]!)).toContain("│   Role 1  Description 1");
		const normalSecondRow = lines[3]!;
		expect(picker.onMouse(mouse("move", 3, 20))).toBe(true);
		lines = picker.render(48);
		expect(lines[3]).not.toBe(normalSecondRow);

		// A secondary-button release never activates a row, and a primary click only selects it.
		picker.onMouse(mouse("press", 3, 20, { button: 1 }));
		picker.onMouse(mouse("release", 3, 20, { button: 1 }));
		expect(selected).toEqual([]);
		click(picker, 3, 20);
		expect(selected).toEqual([]);
		expect(stripTerminalSequences(picker.render(48)[3]!)).toContain("│ › Role 1  Description 1");

		// Wheel selection is clamped to the list and scrolls the rendered viewport with it.
		picker.onMouse(mouse("wheel", 3, 20, { wheel: 1 }));
		lines = picker.render(48);
		expect(stripTerminalSequences(lines[2]!)).toContain("│   Role 1  Description 1");
		expect(stripTerminalSequences(lines[3]!)).toContain("│ › Role 2  Description 2");

		const buttonRow = lines.length - 2;
		const saveColumn = stripTerminalSequences(lines[buttonRow]!).indexOf("Save");
		click(picker, buttonRow, saveColumn);
		expect(selected).toEqual(["role-2"]);

		const cancelColumn = stripTerminalSequences(lines[buttonRow]!).indexOf("Cancel");
		click(picker, buttonRow, cancelColumn);
		expect(cancelled).toBe(1);
	});

	test("picker panel keeps search geometry fixed and clears search before cancelling", () => {
		initializeTui();
		const selected: string[] = [];
		let cancelled = 0;
		const picker = new PickerPanel({
			tui: { terminal: { rows: 12 }, requestRender() {} },
			theme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Roles",
			options: [
				{ value: "default", label: "Default", description: "General purpose", searchText: "default general" },
				{ value: "quick", label: "Quick", description: "Time-sensitive", searchText: "quick time-sensitive" },
			],
			onSelect: (value) => selected.push(value),
			onCancel: () => {
				cancelled += 1;
			},
		});
		picker.focused = true;

		let lines = picker.render(48);
		click(picker, 1, 4);
		for (const character of "time-sensitive") picker.handleInput(character);
		lines = picker.render(48);
		expect(stripTerminalSequences(lines[1]!)).toContain("time-sensitive");
		expect(stripTerminalSequences(lines[2]!)).toContain("Quick");
		expect(stripTerminalSequences(lines[2]!)).not.toContain("Default");
		click(picker, 2, 20);
		expect(selected).toEqual([]);

		picker.handleInput("\x1b");
		expect(stripTerminalSequences(picker.render(48)[2]!)).toContain("Default");
		expect(cancelled).toBe(0);
		picker.handleInput("\x1b");
		expect(cancelled).toBe(1);
	});

	test("picker panel preserves keyboard parity and restores button destinations after keycaps", () => {
		initializeTui();
		const selected: string[] = [];
		const picker = new PickerPanel({
			tui: { terminal: { rows: 12 }, requestRender() {} },
			theme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Roles",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
				{ value: "c", label: "Gamma" },
			],
			onSelect: (value) => selected.push(value),
			onCancel() {},
		});

		picker.handleInput("j");
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		expect(selected).toEqual(["c"]);

		const lines = picker.render(48);
		const buttonLine = lines.at(-2)!;
		const colors = tuiTheme(theme);
		expect(buttonLine).toContain(colors.bgAnsi("action.neutral"));
		expect(buttonLine).toContain(colors.bgAnsi("action.positive"));
	});

	test("searchable select keeps help and semantic actions on one compact row", () => {
		initializeTui();
		configureTuiAppearance({ iconPack: "nerd-fonts" });
		const select = new SearchableSelect({
			title: "Mode",
			showTitle: false,
			options: [{ value: "default", label: "Default" }],
			theme,
			onSelect() {},
			onCancel() {},
		});
		const lines = select.render(48).map(stripTerminalSequences);
		expect(lines[0]).toContain(" Filter…");
		expect(lines.at(-1)).toContain("󰜺 Cancel");
		expect(lines.at(-1)).toContain(" Save");
		configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
	});

	test("multi-select hovers and toggles rendered rows, scrolls, and exposes Save", () => {
		initializeTui();
		const saved: string[][] = [];
		const select = new MultiSelect({
			title: "Models",
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
			],
			value: ["a"],
			theme,
			onSave: (value) => saved.push(value),
			onCancel() {},
		});

		let lines = select.render(50);
		const secondOptionRow = lines.findIndex((line) => stripTerminalSequences(line).includes("B"));
		expect(select.onMouse(mouse("move", secondOptionRow))).toBe(true);
		expect(stripTerminalSequences(select.render(50)[secondOptionRow]!)).toStartWith("›");
		click(select, secondOptionRow);
		select.onMouse(mouse("wheel", secondOptionRow, 0, { wheel: 1 }));
		expect(stripTerminalSequences(select.render(50)[secondOptionRow + 1]!)).toStartWith("›");

		lines = select.render(50);
		const buttonRow = lines.length - 1;
		const saveColumn = stripTerminalSequences(lines[buttonRow]!).indexOf("Save");
		click(select, buttonRow, saveColumn);
		expect(saved).toEqual([["a", "b"]]);
	});

	test("multi-select description lines share their option's pointer target", () => {
		initializeTui();
		const saved: string[][] = [];
		const select = new MultiSelect({
			title: "Tools",
			options: [
				{ value: "a", label: "Alpha", description: "First tool description." },
				{ value: "b", label: "Beta", description: "Second tool description that wraps." },
			],
			value: [],
			descriptionLayout: "below",
			theme,
			onSave: (value) => saved.push(value),
			onCancel() {},
		});

		const lines = select.render(28).map(stripTerminalSequences);
		const betaRow = lines.findIndex((line) => line.includes("Beta"));
		const descriptionRow = betaRow + 1;
		expect(descriptionRow).toBeGreaterThanOrEqual(0);
		expect(lines.slice(descriptionRow, descriptionRow + 3).join(" ")).toContain("Second tool");
		click(select, descriptionRow, 8);
		select.handleInput("\r");
		expect(saved).toEqual([["b"]]);
	});

	test("multi-select Cancel button preserves the unsaved-change warning", () => {
		initializeTui();
		let cancelled = 0;
		const select = new MultiSelect({
			title: "Models",
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
			value: ["a"],
			theme,
			onSave() {},
			onCancel: () => {
				cancelled += 1;
			},
		});
		const initial = select.render(50);
		click(
			select,
			initial.findIndex((line) => stripTerminalSequences(line).includes("B")),
		);

		let lines = select.render(50);
		let buttonRow = lines.length - 1;
		let cancelColumn = stripTerminalSequences(lines[buttonRow]!).indexOf("Cancel");
		click(select, buttonRow, cancelColumn);
		expect(cancelled).toBe(0);
		expect(stripTerminalSequences(select.render(50).join("\n"))).toContain("Unsaved changes");

		lines = select.render(50);
		buttonRow = lines.length - 1;
		cancelColumn = stripTerminalSequences(lines[buttonRow]!).indexOf("Cancel");
		click(select, buttonRow, cancelColumn);
		expect(cancelled).toBe(1);
	});
});
