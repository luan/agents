import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	dispatchEditorPaste,
	dispatchEditorRender,
	EDITOR_REGISTRY_KEY,
	type EditorRegistry,
	ensureEditorRegistry,
} from "../src/editor.ts";
import { installEditorBridge } from "../src/host/editor-bridge.ts";

// type-boundary: these tests provide only the host methods exercised by Pi's CustomEditor.
type EditorHostBoundary = unknown;

const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} } as EditorHostBoundary as never;
const keys = { matches: () => false } as EditorHostBoundary as KeybindingsManager;
const editorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
} as EditorHostBoundary as never;

const prototype = CustomEditor.prototype;

function isolatedRegistry() {
	return ensureEditorRegistry(Object.create(null) as typeof globalThis);
}

describe("editor registry ownership", () => {
	test("reuses structurally valid hidden state from another JavaScript realm", () => {
		// type-boundary: node:vm returns values from an isolated realm; the editor registry validator narrows it.
		type ForeignRealmValue = unknown;
		const foreignRegistry = runInNewContext(`
			const state = { pasteHandlers: [], renderDecorators: [] };
			const registry = {
				protocol: "pi-libtui/editor/registry/v1",
				version: 1,
				registerPasteHandler(handler) {
					state.pasteHandlers.push(handler);
					return () => state.pasteHandlers.splice(state.pasteHandlers.indexOf(handler), 1);
				},
				registerRenderDecorator(decorator) {
					state.renderDecorators.push(decorator);
					return () => state.renderDecorators.splice(state.renderDecorators.indexOf(decorator), 1);
				},
			};
			Object.defineProperty(registry, Symbol.for("pi-libtui/editor/registry-state/v1"), { value: state });
			registry;
		`) as ForeignRealmValue as EditorRegistry;
		const scope = Object.create(null) as Record<PropertyKey, ForeignRealmValue>;
		scope[EDITOR_REGISTRY_KEY] = foreignRegistry;

		const registry = ensureEditorRegistry(scope as typeof globalThis);
		registry.registerPasteHandler({ id: "foreign.paste", handle: (text) => text.toUpperCase() });
		registry.registerRenderDecorator({ id: "foreign.render", decorate: (lines) => [...lines, "foreign"] });

		expect(registry).toBe(foreignRegistry);
		expect(dispatchEditorPaste(registry, "paste")).toBe("PASTE");
		expect(dispatchEditorRender(registry, ["native"], 40)).toEqual(["native", "foreign"]);
	});

	test("replaces a compatible-looking registry with malformed hidden state", () => {
		const scope = Object.create(null) as Record<PropertyKey, unknown>;
		const malformed = {
			protocol: "pi-libtui/editor/registry/v1",
			version: 1,
			registerPasteHandler: () => () => {},
			registerRenderDecorator: () => () => {},
		};
		Object.defineProperty(malformed, Symbol.for("pi-libtui/editor/registry-state/v1"), {
			value: { pasteHandlers: [null], renderDecorators: [] },
		});
		scope[EDITOR_REGISTRY_KEY] = malformed;

		const registry = ensureEditorRegistry(scope as typeof globalThis);
		expect(registry).not.toBe(malformed);
		expect(dispatchEditorRender(registry, ["native"], 40)).toEqual(["native"]);
	});

	test("resolving the registry does not patch CustomEditor", () => {
		const handleInput = prototype.handleInput;
		const insertTextAtCursor = prototype.insertTextAtCursor;
		const render = prototype.render;

		ensureEditorRegistry(Object.create(null) as typeof globalThis);

		expect(prototype.handleInput).toBe(handleInput);
		expect(prototype.insertTextAtCursor).toBe(insertTextAtCursor);
		expect(prototype.render).toBe(render);
	});

	test("the installed host bridge dispatches paste and render handlers", () => {
		const registry = isolatedRegistry();
		const removePaste = registry.registerPasteHandler({
			id: "test.paste",
			handle: (text) => (text === "image.png" ? "attachment-token" : undefined),
		});
		const removeDecorator = registry.registerRenderDecorator({
			id: "test.render",
			decorate: (lines) => [...lines, "decorated"],
		});
		const removeBridge = installEditorBridge(registry);
		try {
			const nativeEditor = new CustomEditor(tui, editorTheme, keys);
			nativeEditor.insertTextAtCursor("image.png");
			expect(nativeEditor.getText()).toBe("attachment-token");
			expect(nativeEditor.render(40).at(-1)).toBe("decorated");

			const bracketedEditor = new CustomEditor(tui, editorTheme, keys);
			bracketedEditor.handleInput("\x1b[200~image.png\x1b[201~");
			expect(bracketedEditor.getText()).toBe("attachment-token");
		} finally {
			removeBridge();
			removeDecorator();
			removePaste();
		}
	});

	test("multiple bridge leases share one patch and restore after the last release", () => {
		const handleInput = prototype.handleInput;
		const insertTextAtCursor = prototype.insertTextAtCursor;
		const render = prototype.render;
		const registry = isolatedRegistry();
		const releaseFirst = installEditorBridge(registry);
		const wrappedHandleInput = prototype.handleInput;
		const wrappedInsertTextAtCursor = prototype.insertTextAtCursor;
		const wrappedRender = prototype.render;
		const releaseSecond = installEditorBridge(registry);
		try {
			expect(prototype.handleInput).toBe(wrappedHandleInput);
			expect(prototype.insertTextAtCursor).toBe(wrappedInsertTextAtCursor);
			expect(prototype.render).toBe(wrappedRender);

			releaseFirst();
			releaseFirst();
			expect(prototype.handleInput).toBe(wrappedHandleInput);
			expect(prototype.insertTextAtCursor).toBe(wrappedInsertTextAtCursor);
			expect(prototype.render).toBe(wrappedRender);

			releaseSecond();
			expect(prototype.handleInput).toBe(handleInput);
			expect(prototype.insertTextAtCursor).toBe(insertTextAtCursor);
			expect(prototype.render).toBe(render);
		} finally {
			releaseFirst();
			releaseSecond();
		}
	});

	test("render decorators replace by id without stale cleanup removing the active copy", () => {
		const registry = isolatedRegistry();
		const first = {
			id: "shared.decorator",
			decorate: (lines: readonly string[]) => [...lines, "first"],
		};
		const second = {
			id: "shared.decorator",
			decorate: (lines: readonly string[]) => [...lines, "second"],
		};
		const removeFirst = registry.registerRenderDecorator(first);
		const removeSecond = registry.registerRenderDecorator(second);

		try {
			expect(dispatchEditorRender(registry, ["line"], 40)).toEqual(["line", "second"]);
			removeFirst();
			expect(dispatchEditorRender(registry, ["line"], 40)).toEqual(["line", "second"]);
			removeSecond();
			expect(dispatchEditorRender(registry, ["line"], 40)).toEqual(["line"]);
		} finally {
			removeFirst();
			removeSecond();
		}
	});

	test("release preserves a method replaced by another owner", () => {
		const originalRenderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
		const originalRender = prototype.render;
		const originalHandleInput = prototype.handleInput;
		const originalInsertTextAtCursor = prototype.insertTextAtCursor;
		const release = installEditorBridge(isolatedRegistry());
		const externalRender = function externalRender(): string[] {
			return ["external"];
		};
		prototype.render = externalRender;
		try {
			release();
			expect(prototype.render).toBe(externalRender);
			expect(prototype.handleInput).toBe(originalHandleInput);
			expect(prototype.insertTextAtCursor).toBe(originalInsertTextAtCursor);
		} finally {
			release();
			if (originalRenderDescriptor) Object.defineProperty(prototype, "render", originalRenderDescriptor);
			else Reflect.deleteProperty(prototype, "render");
			expect(prototype.render).toBe(originalRender);
		}
	});
});
