import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { icon } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import type { SettingValue } from "../src/protocol/settings.ts";
import { SettingsEditor } from "../src/ui/settings-editor.ts";
import { XSettingsScreen, type SettingsScreenField } from "../src/ui/xsettings-screen.ts";

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
	test("clicking a rendered setting selects and activates it without xsettings mouse code", () => {
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
		click(editor, row, 40);
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
		click(editor, fieldRow, 3);
		expect(changes).toEqual([["terminal", true]]);
	});

	test("page sidebar and footer actions are mouseable through shared components", () => {
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
		expect(lines.slice(0, 7).map((line) => line.split("│")[0]?.trim())).toEqual([
			`› ${icon("appearance")} UI`,
			`${icon("ux")} UX`,
			`${icon("animations")} Animations`,
			`${icon("code-mode")} Terminal`,
			`${icon("behavior")} Behavior`,
			`${icon("interaction")} Interaction`,
			`${icon("tools")} Tools`,
		]);
		click(screen, 4, 2);
		lines = screen.render(80).map(stripTerminalSequences);
		expect(lines.join("\n")).toContain("Behavior field");

		const resetRow = lastLineContaining(lines, "Reset");
		const resetCol = lines[resetRow]!.lastIndexOf("Reset");
		expect(lines[resetRow]).toContain("h/l pages");
		expect(lines[resetRow]).toContain(`${icon("reset")} Reset`);
		expect(lines[resetRow]).toContain(`${icon("close")} Close`);
		click(screen, resetRow, resetCol);
		expect(resets).toEqual(["behavior"]);

		screen.handleInput("/");
		screen.handleInput("q");
		expect(closes).toBe(0);
		expect(screen.render(80).map(stripTerminalSequences).join("\n")).toContain("q");
		screen.handleInput("\x1b");
		screen.handleInput("q");
		expect(closes).toBe(1);

		lines = screen.render(80).map(stripTerminalSequences);
		const closeRow = lastLineContaining(lines, "Close");
		const closeCol = lines[closeRow]!.indexOf("Close");
		click(screen, closeRow, closeCol);
		expect(closes).toBe(2);
	});

	test("places a narrow setting description directly above the fixed footer", () => {
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
		const footerDivider = lastLineContaining(lines, "─");
		expect(lines[footerDivider - 1]).toContain("Show significant prompt-cache misses.");
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
		expect(lines.join("\n")).toContain("› Field 11");
		expect(lines.at(-1)).toContain("Close");
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
		click(
			editor,
			lines.findIndex((line) => line.includes("Label")),
			30,
		);
		editor.handleInput("\x0b");
		editor.handleInput("new");
		lines = editor.render(60).map(stripTerminalSequences);
		const saveRow = lastLineContaining(lines, "Save");
		click(editor, saveRow, lines[saveRow]!.indexOf("Save"));
		expect(changes).toEqual([["label", "new"]]);
	});
});
