import { expect, test } from "bun:test";
import { type Component, stripTerminalSequences } from "@earendil-works/pi-tui";
import { FloatingOverlay } from "../src/overlay/floating.ts";

test("floating overlays own placement and pointer translation", () => {
	const baseEvents: number[] = [];
	const overlayEvents: number[] = [];
	const base = {
		render: () => ["abcdefgh"],
		invalidate() {},
		onMouse: (event: { col: number }) => (baseEvents.push(event.col), true),
	} as Component;
	const overlay = {
		render: () => ["XY"],
		invalidate() {},
		onMouse: (event: { col: number }) => (overlayEvents.push(event.col), true),
	} as Component;
	const floating = new FloatingOverlay({ base, overlay, overlayWidth: () => 2 });

	expect(floating.render(8).map(stripTerminalSequences)).toEqual(["abcdefXY"]);
	expect(floating.onMouse({ type: "press", row: 0, col: 7, button: 0 } as never)).toBe(true);
	expect(floating.onMouse({ type: "press", row: 0, col: 2, button: 0 } as never)).toBe(true);
	expect(overlayEvents).toEqual([1]);
	expect(baseEvents).toEqual([2]);
});
