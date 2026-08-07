import { describe, expect, spyOn, test } from "bun:test";

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

import { ModalEditor } from "./index";

describe("vim cursor", () => {
	test("disables hardware cursor and keeps the native software block", () => {
		const baseRender = spyOn(CustomEditor.prototype, "render").mockImplementation(() => [
			`${CURSOR_MARKER}\x1b[7mx\x1b[0m`,
		]);
		const hardwareStates: boolean[] = [];
		const writes: string[] = [];
		const editor = new ModalEditor(
			{
				terminal: { write: (sequence: string) => writes.push(sequence) },
				setShowHardwareCursor: (enabled: boolean) => hardwareStates.push(enabled),
			} as never,
			{} as never,
			{} as never,
			null,
			"normal",
		);

		try {
			expect(editor.render(80)).toEqual([`${CURSOR_MARKER}\x1b[7mx\x1b[0m`]);

			editor.handleInput("i");

			expect(editor.render(80)).toEqual([`${CURSOR_MARKER}\x1b[7mx\x1b[0m`]);
			expect(hardwareStates).toEqual([false]);
			expect(writes).toEqual([]);
		} finally {
			baseRender.mockRestore();
		}
	});

	test("keeps a block in visual mode and renders one ex cursor in the footer", () => {
		const baseRender = spyOn(CustomEditor.prototype, "render").mockImplementation(() => [
			`${CURSOR_MARKER}\x1b[7mx\x1b[0m`,
		]);
		const editor = new ModalEditor(
			{ terminal: { write() {} }, setShowHardwareCursor() {} } as never,
			{} as never,
			{} as never,
			null,
			"normal",
		);

		try {
			editor.handleInput("v");
			expect(editor.render(80)).toEqual([`${CURSOR_MARKER}\x1b[7mx\x1b[0m`]);
			expect(editor.getMode()).toBe("visual");

			editor.handleInput("\x1b");
			editor.handleInput(":");
			expect(editor.render(80)).toEqual([`${CURSOR_MARKER}x`]);
			expect(editor.getFooterModeLabel(80)).toBe(" EX :▏ ");
		} finally {
			baseRender.mockRestore();
		}
	});

	test("exposes the mode label for the footer instead of drawing it over the editor", () => {
		const editor = new ModalEditor({ terminal: { write() {} } } as never, {} as never, {} as never);
		(editor as unknown as { borderColor: (text: string) => string }).borderColor = (text: string) => text;
		(editor as unknown as { focused: boolean }).focused = true;

		expect(editor.render(80).join("\n")).not.toContain("INSERT");
		expect(editor.getFooterModeLabel(80)).toContain("INSERT");
	});
});
