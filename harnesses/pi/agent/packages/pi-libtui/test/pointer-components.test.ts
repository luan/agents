import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { TabBar } from "../src/controls/tab.ts";
import type { TuiMouseEvent } from "../src/mouse.ts";
import { DialogOverlay } from "../src/overlay/dialog.ts";
import { FullscreenOverlay } from "../src/overlay/fullscreen.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => `\x1b[7m${text}\x1b[27m`,
} as Theme;

function mouse(type: TuiMouseEvent["type"], row: number, col: number, button?: 0 | 1 | 2): TuiMouseEvent {
	return {
		type,
		row,
		col,
		screenRow: row + 10,
		screenCol: col + 20,
		button,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("structural pointer components", () => {
	test("fullscreen overlay translates through its border and safely delegates to its child", () => {
		const events: TuiMouseEvent[] = [];
		const child = {
			render: () => ["content"],
			invalidate() {},
			onMouse(event: TuiMouseEvent) {
				events.push(event);
				return true;
			},
		};
		const overlay = new FullscreenOverlay(
			{ terminal: { rows: 5 }, requestRender() {} } as never,
			theme,
			child,
			"Title",
		);
		overlay.render(10);

		expect(overlay.onMouse(mouse("move", 2, 3))).toBe(true);
		expect(events[0]).toMatchObject({ row: 1, col: 2, screenRow: 12, screenCol: 23 });
		expect(overlay.onMouse(mouse("move", 0, 3))).toBe(false);
		expect(overlay.onMouse(mouse("press", 0, 3, 0))).toBe(true);
		expect(events).toHaveLength(1);
		expect(overlay.onMouse(mouse("leave", 0, 0))).toBe(true);
		expect(events[1]).toMatchObject({ type: "leave", row: -1, col: -1 });

		const brokenChild = {
			render: () => [],
			invalidate() {},
			onMouse: () => {
				throw new Error("boom");
			},
		};
		const broken = new FullscreenOverlay({ terminal: { rows: 5 }, requestRender() {} } as never, theme, brokenChild);
		broken.render(10);
		expect(broken.onMouse(mouse("move", 1, 1))).toBe(false);
		expect(broken.onMouse(mouse("press", 1, 1, 0))).toBe(true);
		overlay.dispose();
		broken.dispose();
	});

	test("dialog overlay translates pointer input through its frame", () => {
		const events: TuiMouseEvent[] = [];
		const child = {
			render: () => ["one", "two"],
			invalidate() {},
			onMouse(event: TuiMouseEvent) {
				events.push(event);
				return true;
			},
		};
		const dialog = new DialogOverlay(theme, child);
		dialog.render(12);

		expect(dialog.onMouse(mouse("move", 2, 4))).toBe(true);
		expect(events[0]).toMatchObject({ row: 1, col: 3 });
		expect(dialog.onMouse(mouse("move", 0, 4))).toBe(false);
		expect(dialog.onMouse(mouse("move", 3, 4))).toBe(false);
	});

	test("tab bar uses exact visible spans for hover and primary-button release", () => {
		const selected: string[] = [];
		const tabs = new TabBar(
			[
				{ id: "a", label: "A" },
				{ id: "b", label: "Longer" },
			],
			theme,
		);
		tabs.onChange = (tab) => selected.push(tab.id);
		const initial = tabs.render(9)[0]!;

		expect(stripTerminalSequences(initial)).toBe(" A    Lon");
		expect(tabs.onMouse(mouse("move", 0, 8))).toBe(true);
		expect(tabs.render(9)[0]).not.toBe(initial);
		expect(tabs.onMouse(mouse("release", 0, 8, 1))).toBe(true);
		expect(selected).toEqual([]);
		expect(tabs.onMouse(mouse("release", 0, 8, 0))).toBe(true);
		expect(selected).toEqual(["b"]);
		expect(tabs.onMouse(mouse("release", 0, 9, 0))).toBe(false);
		expect(selected).toEqual(["b"]);
		expect(tabs.onMouse(mouse("leave", 0, 0))).toBe(false);
	});
});
