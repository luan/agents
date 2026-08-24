import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { renderSemanticCursor } from "../src/cursor.ts";
import { installCursorBridge } from "../src/host/cursor-bridge.ts";

// type-boundary: The cursor bridge fixture implements only the TUI surface used by the compatibility patch.
type TuiBoundary = unknown;
// type-boundary: The cursor renderer fixture implements only the theme methods used by semantic colors.
type ThemeBoundary = unknown;

const theme = {
	name: "dark",
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
} as ThemeBoundary as Theme;

class CursorTuiFixture {
	readonly mode = "fullscreen";
	readonly writes: string[] = [];
	readonly terminal = { write: (data: string) => this.writes.push(data) };
	visible: boolean;

	constructor(visible = false) {
		this.visible = visible;
	}

	getShowHardwareCursor(): boolean {
		return this.visible;
	}
	setShowHardwareCursor(enabled: boolean): void {
		this.visible = enabled;
	}

	extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		const top = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= top; row -= 1) {
			const marker = lines[row]?.indexOf(CURSOR_MARKER) ?? -1;
			if (marker < 0) continue;
			const line = lines[row] ?? "";
			const col = visibleWidth(line.slice(0, marker));
			lines[row] = line.slice(0, marker) + line.slice(marker + CURSOR_MARKER.length);
			return { row, col };
		}
		return null;
	}
}

describe("semantic hardware cursor bridge", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("positions a native cursor, applies its DEC shape, and removes private markers", () => {
		configureTuiAppearance({ insertionCursor: "blinking-bar" });
		const fixture = new CursorTuiFixture();
		const dispose = installCursorBridge(fixture as TuiBoundary as TUI);
		const lines = [`before ${renderSemanticCursor(theme, "\x1b[31mx\x1b[0m", { role: "insertion" })} after`];

		expect(fixture.extractCursorPosition(lines, 20)).toEqual({ row: 0, col: 7 });
		expect(fixture.visible).toBe(true);
		expect(fixture.writes).toEqual(["\x1b[5 q"]);
		expect(lines[0]).toBe("before \x1b[31mx\x1b[0m after");
		dispose();
		expect(fixture.visible).toBe(false);
		expect(fixture.writes.at(-1)).toBe("\x1b[0 q");
	});

	test("restores a live hardware-cursor preference after a native role", () => {
		configureTuiAppearance({ navigationCursor: "steady-block" });
		const fixture = new CursorTuiFixture(true);
		const dispose = installCursorBridge(fixture as TuiBoundary as TUI);
		const native = [renderSemanticCursor(theme, "x", { role: "navigation" })];
		fixture.extractCursorPosition(native, 1);
		expect(fixture.visible).toBe(true);

		fixture.setShowHardwareCursor(false);
		expect(fixture.visible).toBe(true);
		configureTuiAppearance({ navigationCursor: "virtual" });
		const virtual = [renderSemanticCursor(theme, "x", { role: "navigation" })];
		expect(fixture.extractCursorPosition(virtual, 1)).toBeNull();
		expect(fixture.visible).toBe(false);
		expect(fixture.writes).toEqual(["\x1b[2 q", "\x1b[0 q"]);
		dispose();
	});

	test("uses the DEC parameter for every configured native cursor name", () => {
		const cases = [
			["terminal-default", 0],
			["blinking-block", 1],
			["steady-block", 2],
			["blinking-underline", 3],
			["steady-underline", 4],
			["blinking-bar", 5],
			["steady-bar", 6],
		] as const;
		for (const [style, parameter] of cases) {
			configureTuiAppearance({ selectionCursor: style });
			const fixture = new CursorTuiFixture();
			const dispose = installCursorBridge(fixture as TuiBoundary as TUI);
			const lines = [renderSemanticCursor(theme, "x", { role: "selection" })];
			fixture.extractCursorPosition(lines, 1);
			expect(fixture.writes[0]).toBe(`\x1b[${parameter} q`);
			dispose();
		}
	});

	test("keeps one renderer active until its final bridge lease is released", () => {
		configureTuiAppearance({ insertionCursor: "steady-bar" });
		const fixture = new CursorTuiFixture();
		const tui = fixture as TuiBoundary as TUI;
		const disposeFirst = installCursorBridge(tui);
		const disposeSecond = installCursorBridge(tui);
		fixture.extractCursorPosition([renderSemanticCursor(theme, "x", { role: "insertion" })], 1);

		disposeFirst();
		expect(fixture.visible).toBe(true);
		expect(fixture.writes).toEqual(["\x1b[6 q"]);
		disposeSecond();
		expect(fixture.visible).toBe(false);
		expect(fixture.writes).toEqual(["\x1b[6 q", "\x1b[0 q"]);
	});

	test("carries the baseline preference across a renderer replacement", () => {
		configureTuiAppearance({ insertionCursor: "blinking-bar" });
		const previous = new CursorTuiFixture(false);
		const dispose = installCursorBridge(previous as TuiBoundary as TUI);
		previous.extractCursorPosition([renderSemanticCursor(theme, "x", { role: "insertion" })], 1);
		expect(previous.getShowHardwareCursor()).toBe(true);

		// Pi seeds the replacement with the previous renderer's effective value.
		const next = new CursorTuiFixture(previous.getShowHardwareCursor());
		next.extractCursorPosition(["plain"], 1);
		expect(next.visible).toBe(false);
		dispose();
		expect(previous.visible).toBe(false);
	});
});
