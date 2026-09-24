import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	isFocusable,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { QuestionGroup } from "../src/core/state.ts";
import { InlineQuestions } from "../src/ui/questions.ts";

function fixture() {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	const editor = { focused: true, render: () => ["existing chat draft"], invalidate() {} };
	let focused: Component | null = editor;
	const delivered: { answers: string[]; dismissed: boolean }[] = [];
	const group: QuestionGroup = {
		version: 1,
		id: "one",
		questions: [{ title: "Which color?", options: ["Green", "Blue"] }, { title: "What label?" }],
	};
	const card = new InlineQuestions({
		theme,
		tui: {
			requestRender() {},
			getFocusedComponent: () => focused,
			setFocus(component) {
				if (isFocusable(focused)) focused.focused = false;
				focused = component;
				if (isFocusable(component)) component.focused = true;
			},
		},
		onAnswer: (_group, answers, dismissed) => {
			delivered.push({ answers, dismissed });
			card.update([]);
		},
	});
	card.update([group]);
	const lines = () => card.render(80).map(stripTerminalSequences);
	function click(text: string) {
		const rendered = lines();
		const row = rendered.findIndex((line) => line.includes(text));
		expect(row).toBeGreaterThanOrEqual(0);
		const col = rendered[row]!.indexOf(text);
		for (const type of ["press", "release"] as const) {
			card.onMouse({
				type,
				row,
				col,
				screenRow: row,
				screenCol: col,
				button: 0,
				wheel: undefined,
				shift: false,
				alt: false,
				ctrl: false,
			});
		}
	}
	return { card, group, editor, delivered, lines, click, focused: () => focused };
}

test("inline choice and free text submit one group and restore the existing editor", () => {
	const f = fixture();
	expect(f.lines().join("\n")).toContain("Or type your own answer");
	expect(f.focused()).toBe(f.editor);
	expect(f.delivered).toEqual([]);
	f.click("Green");
	expect(f.delivered).toEqual([]);
	expect(f.lines().join("\n")).toContain("What label?");
	f.click("Type your answer");
	expect(f.focused()).toBe(f.card);
	f.card.handleInput("Ready");
	f.card.update([f.group]);
	expect(f.lines().join("\n")).toContain("Ready");
	f.card.handleInput("\r");
	expect(f.delivered).toEqual([{ answers: ["Green", "Ready"], dismissed: false }]);
	expect(f.focused()).toBe(f.editor);
	expect(f.lines().join("\n")).not.toContain("What label?");
});

test("Escape keeps the inline draft, Back permits revision, and dismissal never sends partial answers", () => {
	const f = fixture();
	f.click("Or type");
	f.card.handleInput("Purple");
	f.card.handleInput("\x1b");
	expect(f.focused()).toBe(f.editor);
	expect(f.lines().join("\n")).toContain("Purple");
	f.click("Next");
	f.click("Back");
	expect(f.lines().join("\n")).toContain("Purple");
	f.click("Blue");
	f.click("Dismiss");
	expect(f.delivered).toEqual([{ answers: [], dismissed: true }]);
});

test("keyboard selection is explicit and replacing the pending group releases focus", () => {
	const f = fixture();
	f.card.focus();
	f.card.handleInput("\x1b[B");
	expect(f.delivered).toEqual([]);
	f.card.handleInput("\r");
	f.card.handleInput("\r");
	expect(f.delivered).toEqual([]);
	f.card.update([{ ...f.group, id: "another" }]);
	expect(f.focused()).toBe(f.editor);
	expect(f.lines().join("\n")).toContain("Question 1/2");
});
