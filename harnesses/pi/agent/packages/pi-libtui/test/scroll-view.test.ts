import { describe, expect, test } from "bun:test";
import { ScrollView } from "../src/controls/scroll-view.ts";
import type { TuiMouseEvent } from "../src/mouse.ts";

const event = (part: Partial<TuiMouseEvent>): TuiMouseEvent => ({
	type: "move",
	row: 0,
	col: 0,
	screenRow: 0,
	screenCol: 0,
	button: undefined,
	wheel: undefined,
	shift: false,
	alt: false,
	ctrl: false,
	...part,
});

describe("ScrollView", () => {
	test("keeps a bounded viewport and a truthful scrollbar", () => {
		const view = new ScrollView({ height: 3, renderContent: () => ["one", "two", "three", "four", "five"] });
		expect(view.render(8)).toEqual(["one    █", "two    │", "three  │"]);
		expect(view.getGeometry()).toEqual({ width: 8, height: 3, contentHeight: 5, offset: 0, maxOffset: 2 });
		view.handleInput("G");
		expect(view.render(8)).toEqual(["three  │", "four   │", "five   █"]);
		expect(view.getOffset()).toBe(2);
	});

	test("supports page, home, end, wheel, and pointer focus", () => {
		let renders = 0;
		const view = new ScrollView({
			height: 2,
			renderContent: (width) => Array.from({ length: 8 }, (_, i) => `${i}:${width}`),
			requestRender: () => renders++,
		});
		view.render(12);
		expect(view.handleViewportInput("\u001b[6~")).toBe(true);
		expect(view.getOffset()).toBe(2);
		expect(view.onMouse(event({ type: "wheel", wheel: 1, row: 1, col: 3 }))).toBe(true);
		expect(view.getOffset()).toBe(3);
		expect(view.onMouse(event({ type: "press", button: 0, row: 0, col: 3 }))).toBe(true);
		expect(view.focused).toBe(true);
		view.handleInput("g");
		expect(view.getOffset()).toBe(0);
		view.handleInput("G");
		expect(view.getOffset()).toBe(6);
		expect(renders).toBeGreaterThan(0);
	});

	test("clamps resize and zero dimensions", () => {
		const view = new ScrollView({ height: () => 2, renderContent: () => ["a", "b", "c", "d"] });
		view.render(4);
		view.handleInput("G");
		view.render(10);
		expect(view.getGeometry()?.maxOffset).toBe(2);
		expect(view.render(0)).toEqual(["", ""]);
	});
});
