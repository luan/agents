import { expect, test } from "bun:test";
import { type EditorFactory, installEditorLayer } from "../shared/editor-composition";
import promptStorage from "./index";

test("removes its editor layer before session replacement", () => {
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	promptStorage({
		on(name: string, handler: (event: unknown, context: unknown) => unknown) {
			handlers.set(name, handler);
		},
	} as never);

	let factory: EditorFactory | undefined = () => ({
		render: () => [],
		invalidate() {},
	});
	const ui = {
		getEditorComponent: () => factory,
		setEditorComponent: (next: EditorFactory | undefined) => {
			factory = next;
		},
	};
	installEditorLayer(ui, Symbol.for("prompt-storage.editorShortcutLayer"), () => () => {
		throw new Error("stale context");
	});

	handlers.get("session_shutdown")?.({}, { hasUI: true, ui });

	expect(factory).toBeDefined();
	expect(() => factory?.(undefined as never, undefined as never, undefined as never)).not.toThrow();
});
