import { expect, test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import { FULLSCREEN_LAYOUT_CAPABILITY_KEY } from "pi-libtui/mouse";
import { validateFullscreenSurface } from "../src/runtime/fullscreen-surface.ts";
import { ensureTestLayoutCapability, removeTestLayoutCapability } from "./layout-capability.ts";

ensureTestLayoutCapability();

// type-boundary: The focused fixture implements Pi 0.84.2's validated fullscreen renderer shape.
type TuiBoundary = unknown;

test("resolves the deepest structural component at a logical transcript row", () => {
	const first = {};
	const second = {};
	const nested = {
		getSpans: () => [{ component: second, row: 1, height: 1, width: 20 }],
	};
	const content = {
		getSpans: () => [
			{ component: first, row: 1, height: 1, width: 20 },
			{ component: nested, row: 2, height: 2, width: 20 },
		],
	};
	const scrollView = {
		scrollTop: 2,
		viewportHeight: 2,
		scrollTo() {},
	};
	const contentBox = {
		component: content,
		rect: { x: 0, y: -2, width: 20, height: 4 },
		clip: { x: 0, y: 0, width: 20, height: 2 },
		children: [],
	};
	const scrollBox = {
		component: {},
		rect: { x: 0, y: 0, width: 20, height: 2 },
		clip: { x: 0, y: 0, width: 20, height: 2 },
		children: [contentBox],
		scrollView,
		scrollContentLines: ["zero", "one", "two", "three"],
	};
	const boundary: TuiBoundary = {
		mode: "fullscreen",
		currentLayout: {
			primaryScrollView: scrollView,
			root: {
				component: {},
				rect: { x: 0, y: 0, width: 20, height: 2 },
				clip: { x: 0, y: 0, width: 20, height: 2 },
				children: [scrollBox],
			},
		},
		copySelectionToClipboard: async () => {},
		flash() {},
		requestRender() {},
	};

	const surface = validateFullscreenSurface(boundary as TUI);
	expect(surface?.componentAt(0)).toEqual({ component: content, row: 0 });
	expect(surface?.componentAt(1)).toEqual({ component: first, row: 0 });
	expect(surface?.componentAt(2)).toEqual({ component: nested, row: 0 });
	expect(surface?.componentAt(3)).toEqual({ component: second, row: 0 });
	expect(surface?.componentAt(4)).toBeUndefined();
	expect(surface?.viewportRect).toEqual({ x: 0, y: 0, width: 20, height: 2 });
	expect(surface?.screenPoint({ row: 2, col: 3 })).toEqual({ row: 0, col: 3 });
	scrollView.scrollTop = 3;
	expect(surface?.screenPoint({ row: 3, col: 3 })).toEqual({ row: 0, col: 3 });
	scrollBox.rect.width = 16;
	scrollBox.clip.width = 16;
	expect(validateFullscreenSurface(boundary as TUI)?.viewportRect.width).toBe(16);

	removeTestLayoutCapability();
	try {
		expect(validateFullscreenSurface(boundary as TUI)).toBeUndefined();
		const slots = globalThis as Record<PropertyKey, unknown>;
		slots[FULLSCREEN_LAYOUT_CAPABILITY_KEY] = {
			protocol: "pi-libtui/fullscreen-layout/v1",
			version: 2,
			resolve: () => ({ malformed: false }),
		};
		expect(validateFullscreenSurface(boundary as TUI)).toBeUndefined();
		slots[FULLSCREEN_LAYOUT_CAPABILITY_KEY] = {
			protocol: "pi-libtui/fullscreen-layout/v1",
			version: 1,
			resolve: () => ({ malformed: true }),
		};
		expect(validateFullscreenSurface(boundary as TUI)).toBeUndefined();
	} finally {
		Reflect.deleteProperty(globalThis as Record<PropertyKey, unknown>, FULLSCREEN_LAYOUT_CAPABILITY_KEY);
		ensureTestLayoutCapability();
	}
});
