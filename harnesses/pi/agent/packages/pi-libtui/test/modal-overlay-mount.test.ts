import { expect, test } from "bun:test";
import type { ModalOverlayComponent, ModalOverlayMouseEvent } from "../src/index.ts";
import { ensureMouseRegistry, getMouseRegistryState } from "../src/mouse/registry.ts";
import { mountModalOverlay } from "../src/overlay/modal-mount.ts";

test("modal mounts route local component input and own registration disposal", () => {
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const pointerEvents: ModalOverlayMouseEvent[] = [];
	const inputs: string[] = [];
	let invalidations = 0;
	let disposals = 0;
	const component: ModalOverlayComponent = {
		focused: false,
		render: (width) => [`width:${width}`],
		invalidate: () => invalidations++,
		handleInput: (data) => inputs.push(data),
		handleMouse: (event) => {
			pointerEvents.push(event);
			return true;
		},
		dispose: () => disposals++,
	};
	const mounted = mountModalOverlay(component, {
		registry,
		id: "test.dialog",
		getRect: () => ({ x: 12, y: 4, width: 20, height: 6 }),
		getShieldRect: () => ({ x: 0, y: 0, width: 80, height: 24 }),
	});

	expect(getMouseRegistryState(registry).regions.map(({ id, priority }) => ({ id, priority }))).toEqual([
		{ id: "test.dialog", priority: 10_000 },
		{ id: "test.dialog.shield", priority: 9_999 },
	]);
	const region = getMouseRegistryState(registry).regions[0]!;
	expect(
		region.onMouse({
			type: "press",
			row: 2,
			col: 3,
			screenRow: 6,
			screenCol: 15,
			button: 0,
			wheel: undefined,
			shift: false,
			alt: false,
			ctrl: false,
		}),
	).toBe(true);
	expect(pointerEvents).toEqual([{ type: "press", row: 2, col: 3, button: 0 }]);

	mounted.focused = true;
	mounted.handleInput("x");
	expect(component.focused).toBe(true);
	expect(mounted.render(17)).toEqual(["width:17"]);
	mounted.invalidate();
	expect(inputs).toEqual(["x"]);
	expect(invalidations).toBe(1);

	mounted.dispose();
	mounted.dispose();
	expect(getMouseRegistryState(registry).regions).toEqual([]);
	expect(disposals).toBe(1);
});

test("modal mounts leave unsupported pointer phases to the shield", () => {
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const component: ModalOverlayComponent = {
		focused: false,
		render: () => [],
		invalidate() {},
		handleInput() {},
		handleMouse: () => true,
	};
	mountModalOverlay(component, {
		registry,
		id: "test.dialog",
		getRect: () => ({ x: 10, y: 5, width: 20, height: 6 }),
		getShieldRect: () => ({ x: 0, y: 0, width: 80, height: 24 }),
	});
	const [region, shield] = getMouseRegistryState(registry).regions;
	const event = {
		row: 1,
		col: 1,
		screenRow: 6,
		screenCol: 11,
		button: 0 as const,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(region!.onMouse({ ...event, type: "drag" })).toBe(false);
	expect(shield!.onMouse({ ...event, type: "drag" })).toBe(true);
});
