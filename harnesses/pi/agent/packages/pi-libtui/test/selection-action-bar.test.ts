import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { tuiTheme } from "../src/color/theme.ts";
import {
	mountSelectionActionBar,
	placeSelectionActionBar,
	SelectionActionBar,
} from "../src/controls/selection-action-bar.ts";
import { ensureMouseRegistry, getMouseRegistryState } from "../src/mouse/registry.ts";
import type { TuiMouseEvent } from "../src/mouse.ts";

// type-boundary: The test fixture implements only the Theme methods consumed by tuiTheme.
const theme = {
	name: "dark",
	getColorMode: () => "256color",
	getFgAnsi: () => "\x1b[38;5;255m",
	getBgAnsi: (color: string) => (color === "selectedBg" ? "\x1b[48;5;17m" : "\x1b[48;5;16m"),
} as unknown as Theme;

function mouse(type: TuiMouseEvent["type"], col: number, button?: 0 | 1 | 2): TuiMouseEvent {
	return {
		type,
		row: 0,
		col,
		screenRow: 4,
		screenCol: col + 10,
		button,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("selection action bar", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("renders the connected Nerd Font surface and activates exact pointer and key targets", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const activated: string[] = [];
		let renders = 0;
		const bar = new SelectionActionBar({
			theme,
			actions: [
				{ value: "comment", label: "comment", icon: "comment", shortcuts: ["c"] },
				{ value: "reaction", label: "react", icon: "reaction", shortcuts: ["r"] },
				{ value: "copy", label: "copy", icon: "copy", shortcuts: ["y"] },
			],
			requestRender: () => {
				renders += 1;
			},
			onActivate: (value) => activated.push(value),
		});
		const row = bar.render(80)[0]!;
		expect(stripTerminalSequences(row)).toBe("   comment 󰬊    react 󰬙    copy 󰬠 ");
		const colors = tuiTheme(theme);
		expect(row).not.toContain(colors.bgAnsi("badge.neutral"));
		expect(row).toContain(`${colors.fgAnsi("text.secondary")}󰬊`);
		const reaction = bar.getGeometry()!.actions[1]!;
		expect(bar.onMouse(mouse("move", reaction.x))).toBe(true);
		expect(renders).toBe(1);
		expect(stripTerminalSequences(bar.render(80)[0]!)).toBe("   comment 󰬊    react 󰬙    copy 󰬠 ");
		expect(bar.render(80)[0]!).not.toContain(colors.bgAnsi("badge.neutral"));
		expect(bar.onMouse(mouse("press", reaction.x, 0))).toBe(true);
		expect(bar.onMouse(mouse("release", reaction.x, 0))).toBe(true);
		expect(activated).toEqual(["reaction"]);
		expect(bar.handleInput("y")).toBe(true);
		expect(activated).toEqual(["reaction", "copy"]);
	});

	test("places above, flips below, and clamps within the transcript viewport", () => {
		expect(
			placeSelectionActionBar({
				selection: { start: { row: 5, col: 20 }, end: { row: 5, col: 25 } },
				barWidth: 12,
				screenWidth: 40,
				screenHeight: 20,
			}),
		).toEqual({ x: 17, y: 4, width: 12, height: 1 });
		expect(
			placeSelectionActionBar({
				selection: { start: { row: 2, col: 2 }, end: { row: 2, col: 4 } },
				barWidth: 12,
				screenWidth: 40,
				screenHeight: 20,
				viewport: { x: 0, y: 2, width: 40, height: 10, scrollTop: 0 },
			}),
		).toEqual({ x: 0, y: 3, width: 12, height: 1 });
	});

	test("centers on selected content when the terminal endpoint includes trailing cells", () => {
		const request = {
			selection: { start: { row: 5, col: 20 }, end: { row: 5, col: 79 } },
			barWidth: 12,
			screenWidth: 80,
			screenHeight: 20,
		};
		expect(placeSelectionActionBar({ ...request })).toEqual({ x: 44, y: 4, width: 12, height: 1 });
		expect(placeSelectionActionBar({ ...request, selectedText: "hello\n" })).toEqual({
			x: 17,
			y: 4,
			width: 12,
			height: 1,
		});
	});

	test("uses a readable semantic hover surface", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const bar = new SelectionActionBar({
			theme,
			actions: [{ value: "comment", label: "comment", icon: "comment", shortcuts: ["c"] }],
			requestRender() {},
			onActivate() {},
		});
		bar.render(80);
		const action = bar.getGeometry()!.actions[0]!;
		bar.onMouse(mouse("move", action.x));
		const hovered = bar.render(80)[0]!;
		const colors = tuiTheme(theme);
		expect(hovered).toContain(colors.bgAnsi("surface.hover"));
		expect(hovered).toContain(colors.fgAnsi(colors.contrastBackground(colors.color("surface.hover"))));
		expect(hovered).not.toContain(colors.bgAnsi(colors.contrastBackground(colors.color("action.neutral"))));
	});

	test("does not consume unused placement cells when compositing", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const bar = new SelectionActionBar({
			theme,
			actions: [{ value: "copy", label: "copy", icon: "copy", shortcuts: ["y"] }],
			requestRender() {},
			onActivate() {},
		});
		const natural = bar.render(80)[0]!;
		const naturalWidth = bar.getGeometry()!.width;
		const base = `\x1b[48;5;22m${"x".repeat(80)}\x1b[49m`;
		const rendered = bar.composite([base], { x: 3, y: 0, width: naturalWidth + 8, height: 1 })[0]!;
		const plain = stripTerminalSequences(rendered);
		const colors = tuiTheme(theme);
		expect(rendered).not.toContain(colors.bgAnsi("badge.neutral"));
		expect(rendered).toContain(colors.bgAnsi("action.neutral"));
		expect(sliceByColumn(plain, 3, naturalWidth, true)).toBe(stripTerminalSequences(natural));
		expect(sliceByColumn(plain, 3 + naturalWidth, 1, true)).toBe("x");
	});

	test("uses a subdued distinct surface over a matching user-message background", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const bar = new SelectionActionBar({
			theme,
			actions: [{ value: "copy", label: "copy", icon: "copy", shortcuts: ["y"] }],
			requestRender() {},
			onActivate() {},
		});
		bar.render(80);
		const width = bar.getGeometry()!.width;
		const destination = tuiTheme(theme).bgAnsi("action.neutral");
		const base = `${destination}${"x".repeat(80)}\x1b[49m`;
		const rendered = bar.composite([base], { x: 3, y: 0, width, height: 1 })[0]!;
		expect(rendered).toContain(tuiTheme(theme).bgAnsi("surface.raised"));
	});

	test("mounts placement, compositing, pointer routing, visibility, and disposal as one lifecycle", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
		const activated: string[] = [];
		let hidden = false;
		const mount = mountSelectionActionBar({
			registry,
			id: "test.selection-actions",
			theme,
			actions: [{ value: "copy", label: "copy", icon: "copy", shortcuts: ["y"] }],
			requestRender() {},
			onActivate: (value) => activated.push(value),
			isHidden: () => hidden,
			getTarget: () => ({
				selection: { start: { row: 2, col: 8 }, end: { row: 2, col: 11 } },
				selectedText: "copy",
			}),
		});
		const context = { width: 30, height: 5, hasOverlay: false };
		const decorated = registry.dispatchScreenDecorators(
			Array.from({ length: 5 }, () => " ".repeat(30)),
			context,
		);
		expect(stripTerminalSequences(decorated[1]!)).toContain("copy");
		const state = getMouseRegistryState(registry);
		const region = state.regions[0]!;
		const rect = region.getRect()!;
		const actionCol = stripTerminalSequences(decorated[rect.y]!).indexOf("copy") - rect.x;
		expect(region.onMouse(mouse("press", actionCol, 0))).toBe(true);
		expect(region.onMouse(mouse("release", actionCol, 0))).toBe(true);
		expect(activated).toEqual(["copy"]);
		expect(region.getRect()).toBeUndefined();

		hidden = true;
		registry.dispatchScreenDecorators(decorated, context);
		expect(region.getRect()).toBeUndefined();
		mount.dispose();
		mount.dispose();
		expect(state.screenDecorators).toHaveLength(0);
		expect(state.regions).toHaveLength(0);
	});
});
