import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type ModalOverlayMouseEvent, tuiTheme } from "pi-libtui";
import { ReactionDialog, type ReactionOverlayResult } from "../src/ui/composer-overlays.ts";

// type-boundary: the component test supplies only Theme methods used by the shared panel and button bar.
type ThemeBoundary = unknown;
function testTheme(backgrounds: string[] = [], foregrounds: string[] = []): Theme {
	const boundary: ThemeBoundary = {
		fg: (color: string, text: string) => {
			foregrounds.push(color);
			return text;
		},
		bg: (color: string, text: string) => {
			backgrounds.push(color);
			return text;
		},
		bold: (text: string) => text,
	};
	return boundary as Theme;
}
const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} } as TUI;
const keybindings = {
	matches(data: string, action: string) {
		return (
			(action === "tui.select.cancel" && data === "\x1b") ||
			(action === "tui.input.submit" && data === "\r") ||
			(action === "tui.select.confirm" && data === "\r")
		);
	},
} as KeybindingsManager;
const reactions = ["👍 Looks good", "🚫 Rejected", "✅ Approved"];

function dialog(done: (result: ReactionOverlayResult | undefined) => void, theme = testTheme()): ReactionDialog {
	return new ReactionDialog({ tui, theme, keybindings, reactions, width: 44, height: 8, done });
}
function mouse(type: ModalOverlayMouseEvent["type"], row: number, col: number): ModalOverlayMouseEvent {
	return {
		type,
		row,
		col,
		button: 0,
	};
}

describe("ReactionDialog", () => {
	test("add mode omits Delete and hint while using contrasting Cancel/Add colors", () => {
		const backgrounds: string[] = [];
		const foregrounds: string[] = [];
		const theme = testTheme(backgrounds, foregrounds);
		const rendered = dialog(() => {}, theme).render(44);
		const lines = rendered.map(stripTerminalSequences);
		expect(lines[0]).toContain("React");
		expect(lines.join("\n")).not.toContain("navigate");
		expect(lines.join("\n")).not.toContain("DELETE");
		expect(lines.join("\n")).toContain("CANCEL");
		expect(lines.join("\n")).toContain("ADD");
		expect(rendered.join("\n")).toContain(tuiTheme(theme).bgAnsi("surface.selected"));
		expect(rendered.join("\n")).toContain(tuiTheme(theme).bgAnsi("badge.positive"));
		expect(rendered.join("\n")).not.toContain(tuiTheme(theme).bgAnsi("badge.negative"));
		expect(rendered.join("\n")).toContain(tuiTheme(theme).fgAnsi("text.primary"));
		expect(rendered.join("\n")).toContain(tuiTheme(theme).fgAnsi("positive"));
		expect(lines.join("\n")).toContain("›1 👍 Looks good");
	});

	test("row click immediately confirms", () => {
		let result: ReactionOverlayResult | undefined;
		const view = dialog((next) => {
			result = next;
		});
		view.render(44);
		const row = view.getOptionRects()[1]!;
		const rowCol = row.x + 2;
		view.handleMouse(mouse("press", row.y, rowCol));
		view.handleMouse(mouse("release", row.y, rowCol));
		expect(result).toEqual({ action: "save", text: "🚫 Rejected" });
	});

	test("footer Add remains available after keyboard selection", () => {
		let result: ReactionOverlayResult | undefined;
		const view = dialog((next) => {
			result = next;
		});
		view.handleInput("j");
		view.render(44);
		const add = view.getButtonRects().find((button) => button.value === "save")!;
		const addCol = add.x + Math.floor(add.width / 2);
		view.handleMouse(mouse("press", add.y, addCol));
		view.handleMouse(mouse("release", add.y, addCol));
		expect(result).toEqual({ action: "save", text: "🚫 Rejected" });
	});

	test("number shortcut still quick-confirms", () => {
		let result: ReactionOverlayResult | undefined;
		dialog((next) => {
			result = next;
		}).handleInput("1");
		expect(result).toEqual({ action: "save", text: "👍 Looks good" });
	});
});
