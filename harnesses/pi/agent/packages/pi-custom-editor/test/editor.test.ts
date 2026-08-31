import { describe, expect, test } from "bun:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "pi-libtui";
import { TuiState } from "../src/runtime/state.ts";
import { PiCustomEditor } from "../src/ui/pi-custom-editor.ts";

const theme = {
	name: "custom-editor-test",
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => {
		if (token === "text") return "\x1b[38;2;240;240;240m";
		if (token === "accent") return "\x1b[38;2;80;150;240m";
		if (token === "border") return "\x1b[38;2;59;66;97m";
		return "\x1b[38;2;100;140;200m";
	},
	getBgAnsi: (token: string) => (token === "selectedBg" ? "\x1b[48;2;60;70;90m" : "\x1b[48;2;24;28;36m"),
} as never as Theme;

// type-boundary: the editor tests provide only the Pi TUI and keybinding methods used by CustomEditor.
type EditorHostBoundary = unknown;

const tui = { terminal: { rows: 30, columns: 100 }, requestRender() {} } as EditorHostBoundary as never;
const keybindings = { matches: () => false } as EditorHostBoundary as KeybindingsManager;

const ctx = {
	cwd: "/Users/luan/src/agents",
	model: { name: "GPT-5.6 Sol", provider: "forge", reasoning: true },
	getContextUsage: () => ({ tokens: 8_000, contextWindow: 272_000, percent: 2.8 }),
	sessionManager: {
		getEntries: () => [],
		getSessionName: () => "agents",
		getSessionId: () => "01a058a6",
	},
} as EditorHostBoundary as never;

function editor(
	width = 80,
	configure: (state: TuiState) => void = () => {},
): { instance: PiCustomEditor; render(): string[] } {
	const state = new TuiState();
	state.branch = "next";
	configure(state);
	const instance = new PiCustomEditor(tui, {} as never, keybindings, {
		ctx,
		theme,
		state,
		getThinkingLabel: () => "xhigh",
		layout: { reconcile() {}, dispose() {} },
	});
	instance.focused = true;
	return { instance, render: () => instance.render(width) };
}

describe("PiCustomEditor", () => {
	test("keeps typed text and cursor visible on the semantic editor surface", () => {
		const { instance, render } = editor();
		instance.setText("visible draft");
		const lines = render();
		const input = lines.find((line) => stripTerminalSequences(line).includes("visible draft"));

		expect(input).toBeDefined();
		expect(input).toContain(tuiTheme(theme).bgAnsi("surface.editor"));
		expect(stripTerminalSequences(input ?? "")).toContain("GPT-5.6 Sol");
		expect(stripTerminalSequences(lines[0] ?? "")).not.toContain("GPT-5.6 Sol");
		expect(lines.slice(-2).every((line) => visibleWidth(line) === 80)).toBe(true);
	});

	test("moves chrome to the transition row instead of truncating a long draft", () => {
		const { instance, render } = editor(48);
		const draft = `draft-start ${"x".repeat(48)} draft-end`;
		instance.setText(draft);
		const lines = render();
		const plain = lines.map(stripTerminalSequences);
		const firstDraftRow = plain.findIndex((line) => line.includes("draft-start"));

		expect(firstDraftRow).toBeGreaterThan(0);
		expect(plain[0]?.trim()).not.toBe("");
		expect(plain.slice(firstDraftRow).join("\n")).toContain("draft-end");
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
	});

	test("preserves every native multiline editor row", () => {
		const { instance, render } = editor();
		instance.setText("first line\nsecond line");
		const plain = render().map(stripTerminalSequences).join("\n");

		expect(plain).toContain("first line");
		expect(plain).toContain("second line");
	});

	test("renders role, thinking level, and fast mode in the responsive model status", () => {
		const { render } = editor(120, (state) => {
			state.roleStatus = "builder";
			state.contextStatus = "Enhanced (400k)";
			state.fastMode = true;
		});
		const plain = render().map(stripTerminalSequences).join("\n");

		expect(plain).toContain("builder > GPT-5.6 Sol > xhigh > fast");
		expect(plain).not.toContain("Enhanced (400k)");
	});

	test("renders independently enabled left and right rails at rest", () => {
		const { instance, render } = editor();
		instance.setText("rails");
		const input = render().find((line) => stripTerminalSequences(line).includes("rails"));

		expect(input).toContain(tuiTheme(theme).fg("accent", "┃"));
		expect(stripTerminalSequences(input ?? "").trimEnd()).toEndWith("┃");
	});

	test("keeps every editor chrome row exact at a wide terminal width", () => {
		const { instance, render } = editor(256);
		instance.setText("wide editor");

		expect(render().every((line) => visibleWidth(line) === 256)).toBe(true);
	});
});
