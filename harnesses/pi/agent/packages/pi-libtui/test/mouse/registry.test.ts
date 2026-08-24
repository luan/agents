import { expect, test } from "bun:test";
import { getMouseRegistryState } from "../../src/mouse/registry.ts";
import { ensureMouseRegistry, MOUSE_PROTOCOL, registerModalPointerShield } from "../../src/mouse.ts";

test("the overlay registry is load-order independent and disposes by identity", () => {
	const scope = Object.create(null) as typeof globalThis;
	const registry = ensureMouseRegistry(scope);
	const first = { id: "same-id", getRect: () => ({ x: 0, y: 0, width: 1, height: 1 }), onMouse: () => false };
	const second = { ...first };
	const removeFirst = registry.registerOverlayRegion(first);
	registry.registerOverlayRegion(second);
	expect(ensureMouseRegistry(scope)).toBe(registry);
	expect(registry.protocol).toBe(MOUSE_PROTOCOL);
	removeFirst();
	expect(getMouseRegistryState(registry).regions).toEqual([second]);
});

test("modal pointer shields consume selection gestures but leave wheel and hover available", () => {
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const remove = registerModalPointerShield(registry, {
		id: "dialog.shield",
		getRect: () => ({ x: 0, y: 0, width: 80, height: 24 }),
	});
	const shield = getMouseRegistryState(registry).regions[0]!;
	const event = {
		row: 0,
		col: 0,
		screenRow: 0,
		screenCol: 0,
		button: undefined,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(shield.onMouse({ ...event, type: "press", button: 0 })).toBe(true);
	expect(shield.onMouse({ ...event, type: "drag", button: 0 })).toBe(true);
	expect(shield.onMouse({ ...event, type: "release", button: 0 })).toBe(true);
	expect(shield.onMouse({ ...event, type: "wheel", wheel: -1 })).toBe(false);
	remove();
	expect(getMouseRegistryState(registry).regions).toEqual([]);
});

test("viewport input handlers are prioritized, composable, isolated, and disposable", () => {
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const calls: string[] = [];
	registry.registerViewportInputHandler({
		id: "low",
		handle(data) {
			calls.push(`low:${data}`);
			return undefined;
		},
	});
	registry.registerViewportInputHandler({
		id: "broken",
		priority: 5,
		handle() {
			throw new Error("optional");
		},
	});
	const removeHigh = registry.registerViewportInputHandler({
		id: "high",
		priority: 10,
		handle(data) {
			calls.push(`high:${data}`);
			return { data: `${data}!` };
		},
	});
	expect(registry.dispatchViewportInput("key")).toEqual({ data: "key!", consumed: false });
	expect(calls).toEqual(["high:key", "low:key!"]);
	removeHigh();
	calls.length = 0;
	const removeConsumer = registry.registerViewportInputHandler({
		id: "consume",
		priority: 20,
		handle: () => ({ consume: true, data: "handled" }),
	});
	expect(registry.dispatchViewportInput("key")).toEqual({ data: "handled", consumed: true });
	expect(calls).toEqual([]);
	removeConsumer();
});

test("native copy deferrers isolate failures", () => {
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	registry.registerNativeCopyDeferrer(() => {
		throw new Error("optional");
	});
	registry.registerNativeCopyDeferrer(() => false);
	expect(registry.shouldDeferNativeCopy()).toBe(false);
	const remove = registry.registerNativeCopyDeferrer(() => true);
	expect(registry.shouldDeferNativeCopy()).toBe(true);
	remove();
	expect(registry.shouldDeferNativeCopy()).toBe(false);
});

test("screen decorators compose by priority and isolate failures", () => {
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const calls: string[] = [];
	const transcriptLines = ["logical zero", "logical one"];
	let observedTranscriptLines: readonly string[] | undefined;
	registry.registerScreenDecorator({
		id: "low",
		decorate(screen, context) {
			observedTranscriptLines = context.transcriptLines;
			calls.push(`low:${context.width}:${screen[0]}`);
			return [...screen, "low"];
		},
	});
	registry.registerScreenDecorator({
		id: "broken",
		priority: 5,
		decorate() {
			throw new Error("optional");
		},
	});
	const removeHigh = registry.registerScreenDecorator({
		id: "high",
		priority: 10,
		decorate(screen) {
			calls.push(`high:${screen[0]}`);
			return screen.map((line) => `${line}!`);
		},
	});
	expect(
		registry.dispatchScreenDecorators(["native"], {
			width: 80,
			height: 24,
			hasOverlay: false,
			transcriptLines,
		}),
	).toEqual(["native!", "low"]);
	expect(observedTranscriptLines).toBe(transcriptLines);
	expect(calls).toEqual(["high:native", "low:80:native!"]);
	removeHigh();
	calls.length = 0;
	expect(registry.dispatchScreenDecorators(["native"], { width: 80, height: 24, hasOverlay: false })).toEqual([
		"native",
		"low",
	]);
});
