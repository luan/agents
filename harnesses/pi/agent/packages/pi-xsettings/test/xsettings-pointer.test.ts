import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { icon, tuiTheme } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import type { SettingValue } from "../src/protocol/settings.ts";
import { SettingsEditor } from "../src/ui/settings-editor.ts";
import { type SettingsScreenField, XSettingsScreen } from "../src/ui/xsettings-screen.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	underline: (text: string) => text,
} as Theme;

function dispatch(
	component: object,
	event: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, "type" | "row" | "col">,
): boolean {
	const handler = Reflect.get(component, "onMouse");
	if (typeof handler !== "function") throw new Error("Expected shared structural pointer dispatch.");
	return (
		Reflect.apply(handler, component, [
			{
				screenRow: event.row,
				screenCol: event.col,
				button: undefined,
				wheel: undefined,
				shift: false,
				alt: false,
				ctrl: false,
				...event,
			},
		]) === true
	);
}

function click(component: object, row: number, col: number): void {
	dispatch(component, { type: "press", row, col, button: 0 });
	dispatch(component, { type: "release", row, col, button: 0 });
}

function lastLineContaining(lines: readonly string[], text: string): number {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index]?.includes(text)) return index;
	}
	return -1;
}

describe("xsettings shared pointer composition", () => {
	test("clicking outside a select restores its live preview", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const previews: Array<[string, SettingValue]> = [];
		const editor = new SettingsEditor(
			[
				{
					id: "pi.theme",
					section: "Style",
					label: "Theme",
					description: "Theme.",
					type: "enum",
					value: "default",
					defaultValue: "default",
					configured: false,
					options: [
						{ value: "default", label: "Default" },
						{ value: "night", label: "Night" },
					],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
			18,
			[],
			undefined,
			undefined,
			() => {},
			undefined,
			(id, value) => previews.push([id, value]),
		);

		editor.handleInput("\r");
		editor.render(80);
		editor.handleInput("n");
		editor.render(80);
		click(editor, 0, 0);

		expect(previews).toEqual([
			["pi.theme", "night"],
			["pi.theme", "default"],
		]);
		expect(editor.isEditing()).toBe(false);
	});

	test("only a setting control selects and activates its row", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const changes: Array<[string, SettingValue]> = [];
		const editor = new SettingsEditor(
			[
				{
					id: "first",
					section: "General",
					label: "First",
					description: "First.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
				{
					id: "second",
					section: "General",
					label: "Second",
					description: "Second.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
		);

		const lines = editor.render(80).map(stripTerminalSequences);
		const row = lines.findIndex((line) => line.includes("Second"));
		expect(row).toBeGreaterThanOrEqual(0);
		dispatch(editor, { type: "move", row, col: lines[row]!.indexOf("Second") });
		const labelHover = editor.render(80)[row]!;
		expect(labelHover).not.toContain(tuiTheme(theme).bgAnsi("surface.hover"));
		dispatch(editor, { type: "move", row, col: lines[row]!.lastIndexOf("off") });
		const controlHover = editor.render(80)[row]!;
		expect(controlHover).toContain(tuiTheme(theme).bgAnsi("surface.hover"));
		click(editor, row, lines[row]!.indexOf("Second"));
		expect(changes).toEqual([]);
		click(editor, row, lines[row]!.lastIndexOf("off"));
		expect(changes).toEqual([["second", true]]);
	});

	test("section headings do not activate the first setting in a section", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const changes: Array<[string, SettingValue]> = [];
		const editor = new SettingsEditor(
			[
				{
					id: "first",
					section: "UI & Display",
					label: "Theme",
					description: "Theme.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
				{
					id: "terminal",
					section: "Terminal & Images",
					label: "Terminal images",
					description: "Images.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
		);

		const lines = editor.render(100).map(stripTerminalSequences);
		const headingRow = lines.findIndex((line) => line.includes("Terminal & Images"));
		const fieldRow = lines.findIndex((line) => line.includes("Terminal images"));
		click(editor, headingRow, 3);
		expect(changes).toEqual([]);
		click(editor, fieldRow, lines[fieldRow]!.lastIndexOf("off"));
		expect(changes).toEqual([["terminal", true]]);
	});

	test("page sidebar and contextual panel hints use shared components", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const resets: string[] = [];
		let closes = 0;
		const fields: SettingsScreenField[] = [
			{
				id: "appearance",
				category: "appearance",
				storagePath: ["appearance"],
				section: "General",
				label: "Appearance field",
				description: "Appearance.",
				type: "boolean",
				value: false,
				defaultValue: false,
				configured: false,
			},
			{
				id: "behavior",
				category: "behavior",
				storagePath: ["behavior"],
				section: "General",
				label: "Behavior field",
				description: "Behavior.",
				type: "boolean",
				value: true,
				defaultValue: false,
				configured: true,
			},
		];
		const screen = new XSettingsScreen(
			fields,
			theme,
			() => {},
			(id) => resets.push(id),
			() => {
				closes += 1;
			},
			22,
		);

		let lines = screen.render(80).map(stripTerminalSequences);
		expect(lines[0]).toStartWith(`${icon("search")} Search...`);
		expect(lines.some((line) => line.startsWith(`${icon("appearance")} UI`))).toBe(true);
		expect(lines.some((line) => line.startsWith(`${icon("edit")} Editor`))).toBe(true);
		expect(lines.some((line) => line.startsWith("  ") && line.includes("General"))).toBe(true);
		expect(lines.join("\n")).not.toMatch(/[├└]/u);
		expect(lines.some((line) => line.startsWith(`${icon("behavior")} Behavior`))).toBe(true);
		const uiRow = lines.find((line) => line.startsWith(`${icon("appearance")} UI`));
		expect(uiRow?.indexOf(icon("appearance"))).toBe(0);
		const behaviorRow = lines.findIndex((line) => line.includes(`${icon("behavior")} Behavior`));
		expect(behaviorRow).toBeGreaterThan(0);
		click(screen, behaviorRow, 2);
		lines = screen.render(80).map(stripTerminalSequences);
		expect(lines.join("\n")).toContain("Behavior field");

		expect(lines.at(-1)).toContain("focus");
		expect(lines.at(-1)).toContain("reset");
		expect(lines.join("\n")).not.toContain(`${icon("reset")} Reset`);
		expect(lines.join("\n")).not.toContain(`${icon("close")} Close`);
		screen.handleInput("\x7f");
		expect(resets).toEqual(["behavior"]);

		screen.handleInput("/");
		screen.handleInput("q");
		expect(closes).toBe(0);
		expect(screen.render(80).map(stripTerminalSequences).join("\n")).toContain("q");
		screen.handleInput("\x1b");
		screen.handleInput("q");
		expect(closes).toBe(1);
	});

	test("searches settings across pages from the sidebar", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const changes: Array<[string, SettingValue]> = [];
		const screen = new XSettingsScreen(
			[
				{
					id: "appearance",
					category: "appearance",
					storagePath: ["appearance"],
					section: "General",
					label: "Theme",
					description: "Choose the interface theme.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
				{
					id: "behavior",
					category: "behavior",
					storagePath: ["behavior"],
					section: "General",
					label: "Cache diagnostics",
					description: "Show cache status.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
		);

		screen.render(80);
		screen.handleInput("/");
		for (const character of "cache") screen.handleInput(character);

		const lines = screen.render(80).map(stripTerminalSequences);
		expect(lines[0]).toContain(`${icon("search")} cache`);
		const pageColumns = Reflect.get(screen, "pageColumns") as { getBodyOffset(): number };
		expect(lines[0]!.slice(0, pageColumns.getBodyOffset() - 1)).not.toContain("›");
		expect(lines.join("\n")).toContain("Cache diagnostics");
		expect(lines.join("\n")).not.toContain("Theme");

		screen.handleInput("\r");
		screen.handleInput("\r");
		expect(changes).toEqual([["behavior", true]]);
	});

	test("uses Tab to browse the sidebar and Enter to switch back to content", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const changes: Array<[string, SettingValue]> = [];
		const screen = new XSettingsScreen(
			[
				{
					id: "ui",
					category: "appearance",
					page: "ui",
					storagePath: ["appearance", "ui"],
					section: "General",
					label: "UI field",
					description: "UI.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
				{
					id: "ux",
					category: "behavior",
					page: "ux",
					storagePath: ["behavior", "ux"],
					section: "General",
					label: "UX field",
					description: "UX.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
			24,
			[],
			undefined,
			undefined,
			() => {},
			"tab",
		);

		screen.handleInput("\x1b[Z");
		expect(screen.render(80).map(stripTerminalSequences).join("\n")).toContain("UI field");
		screen.handleInput("\t");
		screen.handleInput("j");
		expect(screen.render(80).map(stripTerminalSequences).join("\n")).toContain("UI field");
		screen.handleInput("j");
		expect(screen.render(80).map(stripTerminalSequences).join("\n")).toContain("UI field");
		screen.handleInput("j");
		expect(screen.render(80).map(stripTerminalSequences).join("\n")).toContain("UX field");
		screen.handleInput("\r");
		screen.handleInput("\r");
		expect(changes).toEqual([["ux", true]]);
	});

	test("moves the active pane surface when focus changes", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const screen = new XSettingsScreen(
			[
				{
					id: "ui",
					category: "appearance",
					storagePath: ["appearance", "ui"],
					section: "General",
					label: "UI field",
					description: "UI.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
				{
					id: "ux",
					category: "behavior",
					page: "ux",
					storagePath: ["behavior", "ux"],
					section: "UX settings",
					label: "UX field",
					description: "UX.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
			18,
			[],
			undefined,
			undefined,
			() => {},
			"tab",
		);
		const colors = tuiTheme(theme);
		const focusedSurface = colors.mixForeground(colors.color("surface.inset"), colors.color("surface.selected"), 0.5);
		const subcategoryText = colors.mixForeground(colors.color("text.secondary"), colors.color("text.primary"), 0.55);
		const focusedBackground = colors.bgAnsi(focusedSurface);

		const initial = screen.render(80);
		expect(initial.map(stripTerminalSequences).join("\n")).not.toContain("│");
		const inactiveSection = initial.find((line) => stripTerminalSequences(line).includes("UX settings"));
		expect(inactiveSection).toContain(colors.fgAnsi(subcategoryText));
		const contentFocused = initial.at(-1) ?? "";
		expect(contentFocused.startsWith(colors.bgAnsi("surface.inset"))).toBe(true);
		expect(contentFocused.lastIndexOf(focusedBackground)).toBeGreaterThan(0);
		expect(stripTerminalSequences(contentFocused)).toContain("focus");
		expect(stripTerminalSequences(contentFocused)).toContain("change");

		screen.handleInput("\t");
		const sidebarFocused = screen.render(80).at(-1) ?? "";
		expect(sidebarFocused.startsWith(focusedBackground)).toBe(true);
		expect(sidebarFocused.lastIndexOf(colors.bgAnsi("surface.inset"))).toBeGreaterThan(0);
		expect(stripTerminalSequences(sidebarFocused)).toContain("switch");
	});

	test("activates subcategories while the sidebar cursor moves", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const field = (id: string, section: string): SettingsScreenField => ({
			id,
			category: "appearance",
			storagePath: ["appearance", id],
			section,
			label: id,
			description: `${id}.`,
			type: "boolean",
			value: false,
			defaultValue: false,
			configured: false,
		});
		const screen = new XSettingsScreen(
			[field("Theme", "Style"), field("Icon pack", "Style"), field("Editor padding", "Layout")],
			theme,
			() => {},
			() => {},
			() => {},
			18,
			[],
			undefined,
			undefined,
			() => {},
			"tab",
		);
		const colors = tuiTheme(theme);

		screen.handleInput("j");
		screen.handleInput("\t");
		screen.handleInput("j");
		const rendered = screen.render(80);
		const style = rendered.find((line) => stripTerminalSequences(line).includes("Style"));
		const layout = rendered.find((line) => stripTerminalSequences(line).includes("Layout"));
		expect(style).not.toContain(colors.bgAnsi("surface.selected"));
		expect(layout).toContain(colors.bgAnsi("surface.selected"));
		expect(stripTerminalSequences(rendered.join("\n"))).toContain("Editor padding");
	});

	test("keeps setting help text with its control instead of moving it into the footer", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const screen = new XSettingsScreen(
			[
				{
					id: "cache",
					category: "appearance",
					storagePath: ["appearance"],
					section: "UI & Display",
					label: "Cache miss notices",
					description: "Show significant prompt-cache misses.",
					type: "boolean",
					value: true,
					defaultValue: false,
					configured: true,
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
			22,
		);

		const lines = screen.render(64).map(stripTerminalSequences);
		const labelRow = lines.findIndex((line) => line.includes("Cache miss notices"));
		expect(labelRow).toBeGreaterThanOrEqual(0);
		const contentColumn = lines[labelRow]!.indexOf("Cache miss notices") - 2;
		const description = lines
			.slice(labelRow + 1)
			.map((line) => line.slice(contentColumn))
			.join(" ")
			.replace(/\s+/gu, " ");
		expect(description).toContain("Show significant prompt-cache misses.");
	});

	test("keeps keyboard selection visible after the terminal becomes shorter", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		let height = 14;
		const fields: SettingsScreenField[] = Array.from({ length: 12 }, (_, index) => ({
			id: `field-${index}`,
			category: "appearance",
			storagePath: ["appearance", `field-${index}`],
			section: "General",
			label: `Field ${index}`,
			description: `Field ${index} setting.`,
			type: "boolean",
			value: false,
			defaultValue: false,
			configured: false,
		}));
		const screen = new XSettingsScreen(
			fields,
			theme,
			() => {},
			() => {},
			() => {},
			() => height,
		);

		screen.render(80);
		height = 8;
		for (let index = 0; index < 11; index += 1) screen.handleInput("j");
		const lines = screen.render(80).map(stripTerminalSequences);

		expect(lines).toHaveLength(8);
		expect(lines.join("\n")).toContain("Field 11");
		expect(lines.at(-1)).toContain("change");
		expect(lines.at(-1)).not.toContain("close");
	});

	test("inline string fields expose shared Save and Cancel actions", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const changes: Array<[string, SettingValue]> = [];
		const editor = new SettingsEditor(
			[
				{
					id: "label",
					section: "General",
					label: "Label",
					description: "A label.",
					type: "string",
					value: "old",
					defaultValue: "",
					configured: true,
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
		);

		let lines = editor.render(60).map(stripTerminalSequences);
		const labelRow = lines.findIndex((line) => line.includes("Label"));
		click(editor, labelRow, lines[labelRow]!.lastIndexOf("old"));
		editor.handleInput("\x0b");
		editor.handleInput("new");
		lines = editor.render(60).map(stripTerminalSequences);
		const saveRow = lastLineContaining(lines, "Save");
		click(editor, saveRow, lines[saveRow]!.indexOf("Save"));
		expect(changes).toEqual([["label", "new"]]);
	});
});
