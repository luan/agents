import { describe, expect, test } from "bun:test";
import { PointerInteractionController } from "../src/decoration/pointer-interaction.ts";
import type { TuiMouseEvent, TuiMouseEventType } from "../src/mouse.ts";

interface Target {
	id: string;
	text: string;
	box: { x: number; y: number; width: number; height: number };
}

function mouse(type: TuiMouseEventType, row: number, col: number, button?: 0 | 1 | 2): TuiMouseEvent {
	return {
		type,
		row,
		col,
		screenRow: row,
		screenCol: col,
		button,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("PointerInteractionController", () => {
	test("tracks current targets and computes their union bounds", () => {
		const controller = new PointerInteractionController<Target>({
			key: (target) => target.id,
			rect: (target) => target.box,
		});
		const targets: Target[] = [
			{ id: "one", text: "one", box: { x: 2, y: 1, width: 3, height: 1 } },
			{ id: "two", text: "two", box: { x: 8, y: 2, width: 2, height: 2 } },
		];
		controller.setTargets(targets);

		expect(controller.targetAt(3, 1)).toBe(targets[0]);
		expect(controller.targetAt(7, 1)).toBeUndefined();
		expect(controller.getBounds()).toEqual({ x: 2, y: 1, width: 8, height: 3 });
	});

	test("activates only a primary click that stays on the pressed target", () => {
		const controller = new PointerInteractionController<Target>({
			key: (target) => target.id,
			rect: (target) => target.box,
		});
		const targets: Target[] = [
			{ id: "one", text: "one", box: { x: 0, y: 0, width: 3, height: 1 } },
			{ id: "two", text: "two", box: { x: 4, y: 0, width: 3, height: 1 } },
		];
		controller.setTargets(targets);
		const activated: string[] = [];
		const hover: string[] = [];
		const handlers = {
			onHoverChange: (target: Target | undefined) => hover.push(target?.id ?? "none"),
			onActivate: (target: Target) => activated.push(target.id),
		};

		expect(controller.handleMouse(mouse("enter", 0, 1), handlers)).toBe(true);
		controller.handleMouse(mouse("press", 0, 1, 0), handlers);
		controller.handleMouse(mouse("release", 0, 5, 0), handlers);
		controller.handleMouse(mouse("press", 0, 1, 1), handlers);
		controller.handleMouse(mouse("release", 0, 1, 1), handlers);
		controller.handleMouse(mouse("press", 0, 1, 0), handlers);
		controller.handleMouse(mouse("release", 0, 1, 0), handlers);

		expect(hover).toEqual(["one"]);
		expect(activated).toEqual(["one"]);
	});

	test("clears hover and captured presses when targets leave the frame", () => {
		const controller = new PointerInteractionController<Target>({
			key: (target) => target.id,
			rect: (target) => target.box,
		});
		const target: Target = { id: "one", text: "one", box: { x: 0, y: 0, width: 3, height: 1 } };
		controller.setTargets([target]);
		controller.handleMouse(mouse("enter", 0, 1));
		controller.handleMouse(mouse("press", 0, 1, 0));
		controller.setTargets([]);

		expect(controller.hoveredTarget()).toBeUndefined();
		expect(controller.getBounds()).toBeUndefined();
		const activated: string[] = [];
		controller.handleMouse(mouse("release", 0, 1, 0), { onActivate: (value) => activated.push(value.id) });
		expect(activated).toEqual([]);
	});

	test("activates with the target geometry captured on press", () => {
		const controller = new PointerInteractionController<Target>({
			key: (target) => target.id,
			rect: (target) => target.box,
		});
		const pressed: Target = { id: "one", text: "pressed", box: { x: 2, y: 1, width: 3, height: 1 } };
		controller.setTargets([pressed]);
		controller.handleMouse(mouse("press", 1, 3, 0));
		controller.setTargets([{ id: "one", text: "rerendered", box: { x: 4, y: 1, width: 3, height: 1 } }]);
		const activated: Target[] = [];
		controller.handleMouse(mouse("release", 1, 5, 0), { onActivate: (target) => activated.push(target) });

		expect(activated).toEqual([pressed]);
	});
});
