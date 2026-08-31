import { expect, test } from "bun:test";
import { type Component, stripTerminalSequences } from "@earendil-works/pi-tui";
import { FloatingOverlay } from "../src/overlay/floating.ts";

test("floating overlays own placement and pointer translation", () => {
	const baseEvents: number[] = [];
	const overlayEvents: number[] = [];
	const base = {
		render: () => ["abcdefgh"],
		invalidate() {},
		onMouse: (event: { col: number }) => {
			baseEvents.push(event.col);
			return true;
		},
	} as Component;
	const overlay = {
		render: () => ["XY"],
		invalidate() {},
		onMouse: (event: { col: number }) => {
			overlayEvents.push(event.col);
			return true;
		},
	} as Component;
	const floating = new FloatingOverlay({ base, overlay, overlayWidth: () => 2 });

	expect(floating.render(8).map(stripTerminalSequences)).toEqual(["abcdefXY"]);
	expect(floating.onMouse({ type: "press", row: 0, col: 7, button: 0 } as never)).toBe(true);
	expect(floating.onMouse({ type: "press", row: 0, col: 2, button: 0 } as never)).toBe(true);
	expect(overlayEvents).toEqual([1]);
	expect(baseEvents).toEqual([2]);
});

test("floating overlays can consume outside presses for dismissal", () => {
	let dismissed = 0;
	let basePresses = 0;
	const component = {
		render: () => ["abcdefgh"],
		invalidate() {},
		onMouse: () => {
			basePresses += 1;
			return true;
		},
	} as Component;
	const floating = new FloatingOverlay({
		base: component,
		overlay: { render: () => ["XY"], invalidate() {} },
		overlayWidth: () => 2,
		onOutsidePress: () => {
			dismissed += 1;
		},
	});

	floating.render(8);
	expect(floating.onMouse({ type: "press", row: 0, col: 2, button: 0 } as never)).toBe(true);
	expect(dismissed).toBe(1);
	expect(basePresses).toBe(0);
});
