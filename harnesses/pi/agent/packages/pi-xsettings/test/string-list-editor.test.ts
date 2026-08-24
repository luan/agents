import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import type { DialogHost, TuiTitleSource } from "pi-libtui";
import { StringListEditor } from "../src/ui/string-list-editor.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
} as Theme;

function create(
	value: string[],
	minItems: number,
	onSave: (value: string[]) => void,
	dialogHost?: DialogHost,
): StringListEditor {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	return new StringListEditor({
		label: "Reactions",
		description: "Ordered reaction presets.",
		value,
		minItems,
		theme,
		onSave,
		onCancel() {},
		dialogHost,
	});
}

interface PointerEvent {
	type: "move" | "press" | "release" | "wheel";
	row: number;
	col: number;
	screenRow: number;
	screenCol: number;
	button?: number;
	wheel?: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

function dispatch(
	editor: StringListEditor,
	event: Partial<PointerEvent> & Pick<PointerEvent, "type" | "row" | "col">,
): void {
	const handler = Reflect.get(editor, "onMouse");
	if (typeof handler !== "function") throw new Error("Expected shared structural pointer dispatch.");
	Reflect.apply(handler, editor, [
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
	]);
}

function clickLabel(editor: StringListEditor, label: string, width = 100): void {
	const lines = editor.render(width).map(stripTerminalSequences);
	let row = lines.length - 1;
	while (row >= 0 && !lines[row]!.includes(label)) row -= 1;
	if (row < 0) throw new Error(`Missing button: ${label}`);
	const col = lines[row]!.indexOf(label);
	dispatch(editor, { type: "press", row, col, button: 0 });
	dispatch(editor, { type: "release", row, col, button: 0 });
}

test("adds, edits, reorders, deletes, and saves strings", () => {
	const saved: string[][] = [];
	const editor = create(["one", "two"], 1, (value) => saved.push(value));

	editor.handleInput("a");
	editor.handleInput("three");
	editor.handleInput("\r");
	editor.handleInput("\x0b");
	editor.handleInput("\r");
	editor.handleInput("\x0b");
	editor.handleInput("THREE");
	editor.handleInput("\r");
	editor.handleInput("j");
	editor.handleInput("d");
	editor.handleInput("d");
	editor.handleInput("\x13");

	expect(saved).toEqual([["one", "THREE"]]);
});

test("keeps list navigation bounded while activating the selected item", () => {
	const saved: string[][] = [];
	const editor = create(["one", "two"], 1, (value) => saved.push(value));

	editor.handleInput("k");
	editor.handleInput("\r");
	editor.handleInput("\x0b");
	editor.handleInput("updated");
	editor.handleInput("\r");
	editor.handleInput("\x13");

	expect(saved).toEqual([["updated", "two"]]);
});

test("enforces minItems and warns before discarding changes", () => {
	const editor = create(["only"], 1, () => {});
	editor.handleInput("d");
	editor.handleInput("d");
	expect(stripTerminalSequences(editor.render(80).join("\n"))).toContain("Keep at least 1 item.");

	editor.handleInput("a");
	editor.handleInput("new");
	editor.handleInput("\r");
	editor.handleInput("\x1b");
	expect(stripTerminalSequences(editor.render(80).join("\n"))).toContain("Unsaved changes");
});

test("opens item editing as a nested shared dialog without replacing the list", () => {
	let dialog: Component | undefined;
	let title: TuiTitleSource | undefined;
	let closes = 0;
	const dialogs: DialogHost = {
		open(component, options) {
			dialog = component;
			title = options?.title;
			return () => {
				closes += 1;
				dialog = undefined;
			};
		},
	};
	const editor = create(["one"], 1, () => {}, dialogs);

	editor.handleInput("a");
	expect(stripTerminalSequences(editor.render(80).join("\n"))).toContain("one");
	expect(title).toBe("Add Reactions");
	expect(stripTerminalSequences(dialog!.render(50).join("\n"))).not.toContain("Add Reactions");
	dialog!.handleInput?.("two");
	dialog!.handleInput?.("\r");
	expect(closes).toBe(1);
	expect(stripTerminalSequences(editor.render(80).join("\n"))).toContain("two");
});

test("composed list and buttons provide viewport scrolling, keyboard selection, editing, and actions", () => {
	const saved: string[][] = [];
	const editor = create(["one", "two", "three"], 1, (value) => saved.push(value));

	editor.render(100);
	dispatch(editor, { type: "wheel", row: 3, col: 4, wheel: 1 });
	editor.handleInput("j");
	clickLabel(editor, "Move Down");
	clickLabel(editor, "Move Up");
	clickLabel(editor, "Delete");
	clickLabel(editor, "Add");
	editor.handleInput("four");
	clickLabel(editor, "Save");

	editor.render(100);
	dispatch(editor, { type: "press", row: 3, col: 4, button: 0 });
	dispatch(editor, { type: "release", row: 3, col: 4, button: 0 });
	clickLabel(editor, "Cancel");
	clickLabel(editor, "Save");

	expect(saved).toEqual([["one", "three", "four"]]);
});
