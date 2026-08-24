import { afterEach, describe, expect, test } from "bun:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, tuiTheme } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import { composerPillContent, plainPill } from "../src/core/pills.ts";
import { AnnotationStore } from "../src/core/store.ts";
import type { AnnotationSelection } from "../src/core/types.ts";
import { AnnotationEditor } from "../src/ui/editor.ts";

const selection: AnnotationSelection = {
	messageId: "m",
	messageIdStability: "stable",
	text: "selected",
	shape: "character",
	start: { row: 0, col: 0 },
	end: { row: 0, col: 8 },
	screenStart: { row: 0, col: 0 },
	screenEnd: { row: 0, col: 8 },
};
// type-boundary: the editor test supplies only the TUI/theme/keybinding methods exercised by AnnotationEditor.
type UiBoundary = unknown;
const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} } as UiBoundary as TUI;
const keys = { matches: () => false } as UiBoundary as KeybindingsManager;
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	getBgAnsi: () => "\x1b[48;5;8m",
} as UiBoundary as Theme;

function mouse(
	row: number,
	col: number,
	screenRow: number,
	screenCol: number,
	type: TuiMouseEvent["type"] = "move",
): TuiMouseEvent {
	return {
		type,
		row,
		col,
		screenRow,
		screenCol,
		button: undefined,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("AnnotationEditor pills", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("records exact rendered token geometry and reports a fixed pill-start screen anchor", () => {
		const store = new AnnotationStore();
		const draft = store.add(selection, "note");
		const hovers: Array<{ draftId: string | undefined; anchor?: { row: number; col: number } }> = [];
		const editor = new AnnotationEditor(tui, theme, keys, store, (draftId, anchor) =>
			hovers.push({ draftId, ...(anchor ? { anchor } : {}) }),
		);
		editor.setText(draft.token);
		const rendered = editor.render(30).map(stripTerminalSequences).join("\n");
		expect(rendered).toContain(plainPill(composerPillContent(draft)));
		const hit = editor.getTokenHits()[0]!;
		expect(hit.width).toBeGreaterThan(1);
		editor.onMouse(mouse(hit.y, hit.x + 1, 20, 30));
		expect(hovers).toEqual([{ draftId: draft.id, anchor: { row: 20, col: 29 } }]);
		editor.onMouse(mouse(hit.y, hit.x + 1, 20, 30, "leave"));
		expect(hovers.at(-1)).toEqual({ draftId: undefined });
	});

	test("matching pill press and release activates edit at the cached pill anchor", () => {
		const store = new AnnotationStore();
		const draft = store.add(selection, "note");
		const activations: Array<{ draftId: string; anchor: { row: number; col: number } }> = [];
		const editor = new AnnotationEditor(tui, theme, keys, store, undefined, (draftId, anchor) =>
			activations.push({ draftId, anchor }),
		);
		editor.setText(draft.token);
		editor.render(30);
		const hit = editor.getTokenHits()[0]!;
		editor.onMouse(mouse(hit.y, hit.x + 1, 20, 30, "press"));
		editor.onMouse(mouse(hit.y, hit.x + 2, 20, 31, "release"));
		expect(activations).toEqual([{ draftId: draft.id, anchor: { row: 20, col: 29 } }]);
	});

	test("keeps geometry and hit ownership for multiple draft tokens", () => {
		const store = new AnnotationStore();
		const first = store.add(selection, "first");
		const second = store.add(selection, "second");
		const editor = new AnnotationEditor(tui, theme, keys, store);
		editor.setText(`${first.token} ${second.token}`);
		editor.render(40);
		const hits = editor.getTokenHits();
		expect(hits).toHaveLength(2);
		expect(hits.map((hit) => hit.draftId)).toEqual([first.id, second.id]);
		expect(hits[1]!.x).toBeGreaterThan(hits[0]!.x);
	});

	test("clips the rendered row and hit width to available columns", () => {
		const store = new AnnotationStore();
		const draft = store.add(selection, "long pill");
		const editor = new AnnotationEditor(tui, theme, keys, store);
		editor.setText(`123${draft.token}`);
		const rendered = editor.render(6)[0]!;
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(6);
		const hit = editor.getTokenHits()[0]!;
		expect(hit.x).toBe(3);
		expect(hit.width).toBe(3);
	});

	test("renders native paste markers as gray pills without changing editor text", () => {
		const store = new AnnotationStore();
		const editor = new AnnotationEditor(tui, theme, keys, store);
		const marker = "[paste #1 +12 lines]";
		editor.setText(marker);
		expect(editor.render(40).map(stripTerminalSequences).join("\n")).toContain("paste #1 +12 lines");
		expect(editor.getText()).toBe(marker);
	});

	test("renders an alternate atomic cursor pill while preserving CURSOR_MARKER", () => {
		const backgrounds: string[] = [];
		const bold: string[] = [];
		const cursorTheme = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) => {
				backgrounds.push(color);
				return text;
			},
			getBgAnsi: () => "\x1b[48;5;8m",
			bold: (text: string) => {
				bold.push(text);
				return text;
			},
		} as UiBoundary as Theme;
		const store = new AnnotationStore();
		const draft = store.add(selection, "note");
		const editor = new AnnotationEditor(tui, cursorTheme, keys, store);
		editor.setText(draft.token);
		editor.handleInput("\x1b[D");
		editor.focused = true;
		const rendered = editor.render(30).join("\n");
		expect(rendered).toContain(CURSOR_MARKER);
		expect(rendered).toContain(tuiTheme(cursorTheme).bgAnsi("surface.raised"));
		expect(bold).toContain("#1");
	});

	test("keeps the native insertion role on an atomic cursor pill", () => {
		const backgrounds: string[] = [];
		const cursorTheme = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) => {
				backgrounds.push(color);
				return text;
			},
			getBgAnsi: () => "\x1b[48;5;8m",
			bold: (text: string) => text,
		} as UiBoundary as Theme;
		const store = new AnnotationStore();
		const draft = store.add(selection, "note");
		const editor = new AnnotationEditor(tui, cursorTheme, keys, store);
		editor.setText(draft.token);
		editor.handleInput("\x1b[D");
		editor.focused = true;
		configureTuiAppearance({ insertionCursor: "blinking-bar" });

		const rendered = editor.render(30).join("\n");
		expect(rendered).toContain(`${CURSOR_MARKER}\x1b_pi-libtui:cursor:insertion\x07`);
		expect(backgrounds).not.toContain("surface.hover");
	});

	test("uses the shared softer cursor for ordinary composer text", () => {
		const store = new AnnotationStore();
		const editor = new AnnotationEditor(tui, theme, keys, store);
		editor.setText("hello");
		editor.focused = true;
		configureTuiAppearance({ softCursor: true });
		const rendered = editor.render(30).join("\n");
		expect(rendered).toContain(tuiTheme(theme).bgAnsi("surface.cursor"));
		expect(rendered).not.toContain("\x1b[7m");
	});
});
