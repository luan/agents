import { expect, test } from "bun:test";
import { installScreenDecoration } from "../../src/host/mouse-bridge.ts";
import { ensureMouseRegistry, type ScreenDecorationContext } from "../../src/mouse.ts";

interface DecorationRenderer {
	terminal: { columns: number; rows: number };
	currentLayout: object;
	selectionAnchor?: object;
	selectionFocus?: object;
	hasOverlay(): boolean;
	applySelection(screen: string[], layout?: object): string[];
}

function rendererWith(prototype: object, hasOverlay = false, selectionActive = false): DecorationRenderer {
	const renderer = {
		terminal: { columns: 90, rows: 30 },
		currentLayout: { identity: "fallback" },
		selectionAnchor: selectionActive ? {} : undefined,
		selectionFocus: selectionActive ? {} : undefined,
		hasOverlay: () => hasOverlay,
	} as DecorationRenderer;
	Object.setPrototypeOf(renderer, prototype);
	return renderer;
}

test("screen decoration runs after native selection with the exact current layout and ref-counts", () => {
	const nativeCalls: string[][] = [];
	const prototype = {
		applySelection(screen: string[]): string[] {
			nativeCalls.push(screen);
			return [...screen, "native-selection"];
		},
	};
	const original = prototype.applySelection;
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const contexts: object[] = [];
	registry.registerScreenDecorator({
		id: "copy-mode",
		decorate(screen, context) {
			contexts.push(context);
			return [...screen, "decorated"];
		},
	});
	const firstDispose = installScreenDecoration(prototype, registry);
	const patched = prototype.applySelection;
	const secondDispose = installScreenDecoration(prototype, registry);
	const renderer = rendererWith(prototype, true);
	const replacementRenderer = rendererWith(prototype, false);
	expect(renderer.applySelection(["screen"], { identity: "passed-layout" })).toEqual([
		"screen",
		"native-selection",
		"decorated",
	]);
	expect(replacementRenderer.applySelection(["replacement"], { identity: "passed-layout" })).toEqual([
		"replacement",
		"native-selection",
		"decorated",
	]);
	expect(nativeCalls).toEqual([["screen"], ["replacement"]]);
	expect(contexts).toEqual([
		{ width: 90, height: 30, hasOverlay: true, selectionActive: false, viewport: undefined },
		{ width: 90, height: 30, hasOverlay: false, selectionActive: false, viewport: undefined },
	]);
	firstDispose();
	expect(prototype.applySelection).toBe(patched);
	secondDispose();
	expect(prototype.applySelection).toBe(original);
});

test("screen decoration reports native selection state", () => {
	const prototype = { applySelection: (screen: string[]) => screen };
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	let selectionActive = false;
	registry.registerScreenDecorator({
		id: "selection-state",
		decorate(screen, context) {
			selectionActive = context.selectionActive === true;
			return screen;
		},
	});
	const dispose = installScreenDecoration(prototype, registry);
	rendererWith(prototype, false, true).applySelection(["screen"]);
	expect(selectionActive).toBe(true);
	dispose();
});

test("screen decoration exposes current logical transcript lines with their viewport", () => {
	const prototype = { applySelection: (screen: string[]) => screen };
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const lines = ["zero", "one", "two", "three"];
	const scrollView = { scrollTop: 1, viewportHeight: 2, scrollTo() {} };
	const component = { render: () => lines, invalidate() {} };
	const renderer = rendererWith(prototype);
	renderer.currentLayout = {
		root: {
			component,
			rect: { x: 3, y: 4, width: 20, height: 2 },
			clip: { x: 3, y: 4, width: 20, height: 2 },
			children: [],
			scrollView,
			scrollContentLines: lines,
		},
		primaryScrollView: scrollView,
	};
	let context: ScreenDecorationContext | undefined;
	registry.registerScreenDecorator({
		id: "transcript",
		decorate(screen, current) {
			context = current;
			return screen;
		},
	});
	const dispose = installScreenDecoration(prototype, registry);
	renderer.applySelection(["screen"]);

	expect(context?.viewport).toEqual({ x: 3, y: 4, width: 20, height: 2, scrollTop: 1 });
	expect(context?.transcriptLines).toBe(lines);
	dispose();
});

test("no decorators preserve the exact native return", () => {
	const native = ["same-array"];
	const prototype = { applySelection: () => native };
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const dispose = installScreenDecoration(prototype, registry);
	const renderer = rendererWith(prototype);

	expect(renderer.applySelection(["input"])).toBe(native);
	dispose();
});

test("screen decoration lease survives a later delegating wrapper without stacking", () => {
	const prototype = {
		applySelection(screen: string[]): string[] {
			return [...screen, "native"];
		},
	};
	const original = prototype.applySelection;
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	let decorations = 0;
	registry.registerScreenDecorator({
		id: "count",
		decorate(screen) {
			decorations += 1;
			return [...screen, "decorated"];
		},
	});
	const firstDispose = installScreenDecoration(prototype, registry);
	const decorationBridge = prototype.applySelection;
	const wrapper = function (this: DecorationRenderer, screen: string[], layout?: object): string[] {
		return Reflect.apply(decorationBridge, this, [screen, layout]);
	};
	prototype.applySelection = wrapper;
	const renderer = rendererWith(prototype);
	firstDispose();
	expect(renderer.applySelection(["screen"])).toEqual(["screen", "native"]);
	expect(decorations).toBe(0);

	const secondDispose = installScreenDecoration(prototype, registry);
	expect(prototype.applySelection).toBe(wrapper);
	expect(renderer.applySelection(["screen"])).toEqual(["screen", "native", "decorated"]);
	expect(decorations).toBe(1);

	prototype.applySelection = decorationBridge;
	secondDispose();
	expect(prototype.applySelection).toBe(original);
});
