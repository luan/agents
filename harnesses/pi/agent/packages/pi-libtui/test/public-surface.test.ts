import { describe, expect, test } from "bun:test";

const PUBLIC_ENTRYPOINTS = [
	"pi-libtui",
	"pi-libtui/diff",
	"pi-libtui/editor",
	"pi-libtui/folding",
	"pi-libtui/mouse",
	"pi-libtui/selection",
	"pi-libtui/stream",
	"pi-libtui/terminal",
	"pi-libtui/tool",
] as const;

const CAPABILITY_KEYS = [
	Symbol.for("pi-libtui/editor/registry/v1"),
	Symbol.for("pi-libtui/folding/registry/v2"),
	Symbol.for("pi-libtui/mouse/registry/v1"),
	Symbol.for("pi-libtui/selection/v1"),
	Symbol.for("pi-libtui.motionScheduler.v1"),
] as const;

describe("public module boundaries", () => {
	test("loads every documented public entrypoint without loading the host extension", async () => {
		const before = CAPABILITY_KEYS.map((key) => Object.hasOwn(globalThis, key));
		for (const entrypoint of PUBLIC_ENTRYPOINTS) {
			const module = await import(entrypoint);
			expect(typeof module).toBe("object");
		}
		const after = CAPABILITY_KEYS.map((key) => Object.hasOwn(globalThis, key));
		expect(after).toEqual(before);
		const mouse = await import("pi-libtui/mouse");
		expect(Object.keys(mouse).sort()).toEqual([
			"FULLSCREEN_LAYOUT_CAPABILITY_KEY",
			"FULLSCREEN_LAYOUT_PROTOCOL",
			"MOUSE_PROTOCOL",
			"MOUSE_REGISTRY_KEY",
			"TEXT_INTERACTION_TARGET",
			"ensureMouseRegistry",
			"getFullscreenLayoutCapability",
			"preserveViewportOnResize",
			"publishFullscreenLayoutCapability",
			"registerModalPointerShield",
			"resolveFullscreenLayout",
		]);
		const editor = await import("pi-libtui/editor");
		expect(Object.keys(editor).sort()).toEqual([
			"EDITOR_PROTOCOL",
			"EDITOR_REGISTRY_KEY",
			"SemanticEditor",
			"dispatchEditorPaste",
			"dispatchEditorRender",
			"ensureEditorRegistry",
			"semanticEditorTheme",
		]);
	});

	test("keeps extension activation explicit", async () => {
		const before = CAPABILITY_KEYS.map((key) => Object.hasOwn(globalThis, key));
		const extension = await import("../src/extension.ts");
		expect(typeof extension.default).toBe("function");
		const after = CAPABILITY_KEYS.map((key) => Object.hasOwn(globalThis, key));
		expect(after).toEqual(before);
	});
});
