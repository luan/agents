import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, stripTerminalSequences } from "@earendil-works/pi-tui";
import { icon, type ModalOverlayMouseEvent, tuiTheme } from "pi-libtui";
import { CommentDialog, type CommentOverlayResult } from "../src/ui/composer-overlays.ts";

// type-boundary: the component test supplies only Theme methods used by CommentDialog and DialogButtonBar.
type ThemeBoundary = unknown;
const themeBoundary: ThemeBoundary = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	getFgAnsi: () => "\x1b[38;5;1m",
};
const theme = themeBoundary as Theme;
const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} } as TUI;
const keybindings = {
	matches(data: string, action: string) {
		return (action === "tui.select.cancel" && data === "\x1b") || (action === "tui.input.submit" && data === "\r");
	},
} as KeybindingsManager;

function dialog(
	done: (result: CommentOverlayResult | undefined) => void,
	prefill = "hello",
	dialogTheme = theme,
	canDelete = true,
): CommentDialog {
	return new CommentDialog({ tui, theme: dialogTheme, keybindings, prefill, canDelete, width: 60, height: 9, done });
}

function mouse(type: ModalOverlayMouseEvent["type"], row: number, col: number): ModalOverlayMouseEvent {
	return {
		type,
		row,
		col,
		button: 0,
	};
}

describe("CommentDialog", () => {
	test("renders one Annotate frame, separator, and semantic footer actions", () => {
		const lines = dialog(() => {})
			.render(60)
			.map(stripTerminalSequences);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toStartWith("╭─ Annotate ");
		expect(lines[1]).not.toContain("────────");
		expect(lines[2]).toStartWith("├");
		expect(lines[3]).toContain(`${icon("delete")} DELETE`);
		expect(lines[3]).toContain(`${icon("cancel")} CANCEL`);
		expect(lines[3]).toContain(`${icon("submit")} ADD`);
		expect(lines[4]).toStartWith("╰");
	});

	test("keeps a libtui virtual cursor when the overlay owns focus", () => {
		const cursorTheme: ThemeBoundary = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			getFgAnsi: () => "\x1b[38;5;1m",
		};
		const view = dialog(() => {}, "", cursorTheme as Theme, false);
		view.focused = true;
		const rendered = view.render(60).join("\n");
		expect(rendered).toContain(CURSOR_MARKER);
		expect(rendered).toContain("\x1b[7m \x1b[27m");
	});

	test("hides Delete while adding a new comment", () => {
		const lines = dialog(() => {}, "", theme, false)
			.render(60)
			.map(stripTerminalSequences);
		expect(lines.join("\n")).not.toContain("DELETE");
		expect(lines.join("\n")).toContain("CANCEL");
		expect(lines.join("\n")).toContain("ADD");
	});

	test("uses dark semantic backgrounds with contrasting action foregrounds", () => {
		const backgrounds: string[] = [];
		const foregrounds: string[] = [];
		const semanticBoundary: ThemeBoundary = {
			fg: (color: string, text: string) => {
				foregrounds.push(color);
				return text;
			},
			bg: (color: string, text: string) => {
				backgrounds.push(color);
				return text;
			},
			bold: (text: string) => text,
			getFgAnsi: () => "\x1b[38;5;1m",
		};
		const semanticTheme = semanticBoundary as Theme;
		const rendered = dialog(() => {}, "edit", semanticTheme, true)
			.render(60)
			.join("\n");
		const colors = tuiTheme(semanticTheme);
		for (const token of ["badge.negative", "action.neutral", "badge.positive"] as const) {
			expect(rendered).toContain(colors.bgAnsi(token));
		}
		for (const token of ["negative", "text.primary", "positive"] as const) {
			expect(rendered).toContain(colors.fgAnsi(token));
		}
	});

	test("restores border color immediately after the accented header", () => {
		const ansiBoundary: ThemeBoundary = {
			fg: (color: string, text: string) => `${color === "accent" ? "\x1b[36m" : "\x1b[90m"}${text}\x1b[39m`,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			getFgAnsi: () => "\x1b[38;5;1m",
		};
		const theme = ansiBoundary as Theme;
		const colors = tuiTheme(theme);
		const top = dialog(() => {}, "", theme).render(60)[0]!;
		expect(top).toContain(
			`${colors.fgAnsi("border")}╭─ \x1b[39m${colors.fgAnsi("accent")}Annotate\x1b[39m${colors.fgAnsi("border")} ─`,
		);
	});

	test("Escape cancels, Enter saves, and Ctrl-D deletes", () => {
		const results: Array<CommentOverlayResult | undefined> = [];
		dialog((result) => results.push(result)).handleInput("\x1b");
		dialog((result) => results.push(result), "saved").handleInput("\r");
		dialog((result) => results.push(result)).handleInput("\x04");
		expect(results).toEqual([undefined, { action: "save", text: "saved" }, { action: "delete" }]);
	});

	test("forwards footer-local mouse press and release to Add", () => {
		let result: CommentOverlayResult | undefined;
		const view = dialog((next) => {
			result = next;
		}, "mouse save");
		view.render(60);
		const add = view.getButtonRects().find((button) => button.value === "save");
		expect(add).toBeDefined();
		const col = add!.x + Math.floor(add!.width / 2);
		expect(view.handleMouse(mouse("press", add!.y, col))).toBe(true);
		expect(view.handleMouse(mouse("release", add!.y, col))).toBe(true);
		expect(result).toEqual({ action: "save", text: "mouse save" });
	});

	test("forwards hover for every footer button using selectedBg", () => {
		const backgrounds: string[] = [];
		const hoverBoundary: ThemeBoundary = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) => {
				backgrounds.push(color);
				return text;
			},
			bold: (text: string) => text,
			getFgAnsi: () => "\x1b[38;5;1m",
		};
		const hoverTheme = hoverBoundary as Theme;
		const view = dialog(() => {}, "hover", hoverTheme);
		view.render(60);
		for (const button of view.getButtonRects()) {
			backgrounds.length = 0;
			view.handleMouse(mouse("move", button.y, button.x + Math.floor(button.width / 2)));
			const rendered = view.render(60).join("\n");
			expect(rendered).toContain(tuiTheme(hoverTheme).bgAnsi("surface.selected"));
		}
	});
});
