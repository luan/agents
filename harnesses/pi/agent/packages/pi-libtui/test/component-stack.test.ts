import { describe, expect, test } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import { ComponentStack } from "../src/component-stack.ts";
import type { TuiMouseEvent } from "../src/mouse.ts";

class TestComponent implements Component {
	readonly inputs: string[] = [];
	invalidations = 0;

	constructor(readonly lines: string[]) {}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {
		this.invalidations += 1;
	}

	render(): string[] {
		return [...this.lines];
	}
}

class MouseComponent extends TestComponent {
	readonly events: TuiMouseEvent[] = [];

	onMouse(event: TuiMouseEvent): boolean {
		this.events.push(event);
		return true;
	}
}

class FocusableComponent extends TestComponent {
	focused = false;
}

class ViewportComponent extends TestComponent {
	constructor(
		lines: string[],
		private readonly handled: boolean,
	) {
		super(lines);
	}

	handleViewportInput(data: string): boolean {
		this.inputs.push(data);
		return this.handled;
	}
}

function mouseEvent(row: number, col = 0): TuiMouseEvent {
	return {
		type: "press",
		row,
		col,
		screenRow: row,
		screenCol: col,
		button: 0,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("ComponentStack", () => {
	test("renders children vertically and records exact spans", () => {
		const first = new TestComponent(["one", "two"]);
		const second = new TestComponent(["three"]);
		const stack = new ComponentStack([first, second]);

		expect(stack.render(20)).toEqual(["one", "two", "three"]);
		expect(stack.getSpans()).toEqual([
			{ component: first, index: 0, row: 0, height: 2, width: 20 },
			{ component: second, index: 1, row: 2, height: 1, width: 20 },
		]);
	});

	test("routes input to the active child and keeps its identity across replacement", () => {
		const first = new TestComponent(["one"]);
		const active = new TestComponent(["active"]);
		const stack = new ComponentStack([first, active], { activeChild: 1 });

		stack.handleInput("a");
		stack.setChildren([active, first]);
		stack.handleInput("b");

		expect(first.inputs).toEqual([]);
		expect(active.inputs).toEqual(["a", "b"]);
		expect(stack.getActiveChild()).toBe(active);
	});

	test("propagates overlay focus to the active child", () => {
		const first = new FocusableComponent(["first"]);
		const second = new FocusableComponent(["second"]);
		const stack = new ComponentStack([first, second]);

		stack.focused = true;
		expect([first.focused, second.focused]).toEqual([true, false]);
		stack.setActiveChild(second);
		expect([first.focused, second.focused]).toEqual([false, true]);
		stack.focused = false;
		expect(second.focused).toBe(false);
	});

	test("can route input to every child in display order", () => {
		const order: string[] = [];
		const child = (name: string): Component => ({
			render: () => [],
			invalidate() {},
			handleInput: (data) => order.push(`${name}:${data}`),
		});
		const stack = new ComponentStack([child("first"), child("second")], { inputMode: "all" });

		stack.handleInput("x");

		expect(order).toEqual(["first:x", "second:x"]);
	});

	test("routes viewport input to the active child and falls back to legacy input", () => {
		const viewport = new ViewportComponent(["viewport"], true);
		const legacy = new TestComponent(["legacy"]);
		const stack = new ComponentStack([viewport, legacy]);

		expect(stack.handleViewportInput("right")).toBe(true);
		stack.setActiveChild(legacy);
		expect(stack.handleViewportInput("down")).toBe(false);

		expect(viewport.inputs).toEqual(["right"]);
		expect(legacy.inputs).toEqual(["down"]);
	});

	test("anchors the final child and dispatches translated pointer input", () => {
		const body = new MouseComponent(["body", "body"]);
		const footer = new MouseComponent(["footer"]);
		const stack = new ComponentStack([body, footer], { height: 6, anchorLastChild: true });

		expect(stack.render(12)).toEqual(["body", "body", "", "", "", "footer"]);
		expect(stack.getSpans().map(({ index, row, height }) => ({ index, row, height }))).toEqual([
			{ index: 0, row: 0, height: 2 },
			{ index: 1, row: 5, height: 1 },
		]);
		expect(stack.onMouse(mouseEvent(5, 4))).toBe(true);
		expect(footer.events[0]).toMatchObject({ row: 0, col: 4, screenRow: 5, screenCol: 4 });
		expect(body.events).toEqual([]);
	});

	test("dispatches recursively to the deepest nested stack child", () => {
		const leaf = new MouseComponent(["leaf"]);
		const inner = new ComponentStack([new TestComponent(["label"]), leaf]);
		const outer = new ComponentStack([new TestComponent(["title"]), inner]);
		outer.render(10);

		expect(outer.onMouse(mouseEvent(2, 3))).toBe(true);
		expect(leaf.events[0]).toMatchObject({ row: 0, col: 3, screenRow: 2, screenCol: 3 });
	});

	test("owns hover transitions and capture across nested children", () => {
		const first = new MouseComponent(["first"]);
		const second = new MouseComponent(["second"]);
		const stack = new ComponentStack([first, second]);
		stack.render(12);
		stack.onMouse({ ...mouseEvent(0), type: "move" });
		stack.onMouse({ ...mouseEvent(1), type: "move" });
		stack.onMouse(mouseEvent(0));
		stack.onMouse({ ...mouseEvent(9), type: "release" });

		expect(first.events.map((event) => event.type)).toEqual(["enter", "move", "leave", "press", "release"]);
		expect(second.events.map((event) => event.type)).toEqual(["enter", "move", "leave"]);
		expect(first.events.at(-1)).toMatchObject({ row: 9 });
	});

	test("preserves a handled hover when its redraw invalidates nested geometry", () => {
		let stack: ComponentStack;
		const child = new MouseComponent(["child"]);
		const original = child.onMouse.bind(child);
		child.onMouse = (event) => {
			const handled = original(event);
			if (event.type === "enter") stack.invalidate();
			return handled;
		};
		stack = new ComponentStack([child]);
		stack.render(12);

		expect(stack.onMouse({ ...mouseEvent(0), type: "move" })).toBe(true);
		stack.render(12);
		expect(stack.onMouse(mouseEvent(0))).toBe(true);
		expect(stack.onMouse({ ...mouseEvent(0), type: "release" })).toBe(true);
	});

	test("clips spans to a fixed height and invalidates every current child", () => {
		const first = new TestComponent(["one", "two"]);
		const second = new TestComponent(["three", "four"]);
		const stack = new ComponentStack([first, second], { height: 3 });

		expect(stack.render(8)).toEqual(["one", "two", "three"]);
		expect(stack.getSpans().map(({ row, height }) => ({ row, height }))).toEqual([
			{ row: 0, height: 2 },
			{ row: 2, height: 1 },
		]);
		stack.invalidate();
		expect([first.invalidations, second.invalidations]).toEqual([1, 1]);
		expect(stack.getSpans()).toEqual([]);
	});
});
