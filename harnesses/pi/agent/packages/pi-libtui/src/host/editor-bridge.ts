import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { dispatchEditorPaste, dispatchEditorRender, type EditorRegistry } from "../editor.ts";

const BRIDGE_KEY = Symbol.for("pi-libtui/editor/custom-editor-bridge/v1");
const BRIDGE_PROTOCOL = "pi-libtui/editor/custom-editor-bridge/v1" as const;
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

type EditorPrototype = CustomEditor["constructor"]["prototype"];
type HandleInput = EditorPrototype["handleInput"];
type InsertTextAtCursor = EditorPrototype["insertTextAtCursor"];
type Render = EditorPrototype["render"];

interface OriginalMethod<T> {
	readonly descriptor: PropertyDescriptor | undefined;
	readonly method: T;
}

interface EditorBridgeState {
	readonly protocol: typeof BRIDGE_PROTOCOL;
	leases: number;
	readonly handleInput: OriginalMethod<HandleInput>;
	readonly insertTextAtCursor: OriginalMethod<InsertTextAtCursor>;
	readonly render: OriginalMethod<Render>;
	readonly wrappedHandleInput: HandleInput;
	readonly wrappedInsertTextAtCursor: InsertTextAtCursor;
	readonly wrappedRender: Render;
}

// type-boundary: Symbol.for bridge state can come from another installed pi-libtui copy; this validator narrows its lifecycle fields.
type UntrustedBridgeState = unknown;

function bridgeState(value: UntrustedBridgeState): EditorBridgeState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<EditorBridgeState>;
	if (
		candidate.protocol !== BRIDGE_PROTOCOL ||
		typeof candidate.leases !== "number" ||
		typeof candidate.wrappedHandleInput !== "function" ||
		typeof candidate.wrappedInsertTextAtCursor !== "function" ||
		typeof candidate.wrappedRender !== "function"
	) {
		return undefined;
	}
	return candidate as EditorBridgeState;
}

function originalMethod<K extends "handleInput" | "insertTextAtCursor" | "render">(
	prototype: EditorPrototype,
	key: K,
): OriginalMethod<EditorPrototype[K]> {
	return {
		descriptor: Object.getOwnPropertyDescriptor(prototype, key),
		method: prototype[key],
	};
}

function installMethod<K extends "handleInput" | "insertTextAtCursor" | "render">(
	prototype: EditorPrototype,
	key: K,
	method: EditorPrototype[K],
): void {
	Object.defineProperty(prototype, key, {
		configurable: true,
		enumerable: false,
		writable: true,
		value: method,
	});
}

function restoreMethod<K extends "handleInput" | "insertTextAtCursor" | "render">(
	prototype: EditorPrototype,
	key: K,
	original: OriginalMethod<EditorPrototype[K]>,
	wrapper: EditorPrototype[K],
): void {
	if (prototype[key] !== wrapper) return;
	if (original.descriptor) {
		Object.defineProperty(prototype, key, original.descriptor);
	} else {
		Reflect.deleteProperty(prototype, key);
	}
}

/** Install the extension-owned CustomEditor adapter for one active Pi session. */
export function installEditorBridge(registry: EditorRegistry): () => void {
	const prototype = CustomEditor.prototype;
	const active = bridgeState(Reflect.get(prototype, BRIDGE_KEY));
	if (active) {
		active.leases += 1;
		return releaseBridge(prototype, active);
	}

	const handleInput = originalMethod(prototype, "handleInput");
	const insertTextAtCursor = originalMethod(prototype, "insertTextAtCursor");
	const render = originalMethod(prototype, "render");

	const wrappedHandleInput: HandleInput = function libtuiHandleInput(this: CustomEditor, data: string): void {
		const pasted = data.match(BRACKETED_PASTE)?.[1];
		if (pasted !== undefined) {
			const replacement = dispatchEditorPaste(registry, pasted);
			if (replacement !== undefined) {
				insertTextAtCursor.method.call(this, replacement);
				return;
			}
		}
		handleInput.method.call(this, data);
	};
	const wrappedInsertTextAtCursor: InsertTextAtCursor = function libtuiInsertTextAtCursor(
		this: CustomEditor,
		text: string,
	): void {
		insertTextAtCursor.method.call(this, dispatchEditorPaste(registry, text) ?? text);
	};
	const wrappedRender: Render = function libtuiRender(this: CustomEditor, width: number): string[] {
		return dispatchEditorRender(registry, render.method.call(this, width), width);
	};

	const state: EditorBridgeState = {
		protocol: BRIDGE_PROTOCOL,
		leases: 1,
		handleInput,
		insertTextAtCursor,
		render,
		wrappedHandleInput,
		wrappedInsertTextAtCursor,
		wrappedRender,
	};
	Object.defineProperty(prototype, BRIDGE_KEY, { configurable: true, value: state });
	installMethod(prototype, "handleInput", wrappedHandleInput);
	installMethod(prototype, "insertTextAtCursor", wrappedInsertTextAtCursor);
	installMethod(prototype, "render", wrappedRender);
	return releaseBridge(prototype, state);
}

function releaseBridge(prototype: EditorPrototype, state: EditorBridgeState): () => void {
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		state.leases -= 1;
		if (state.leases > 0) return;

		restoreMethod(prototype, "handleInput", state.handleInput, state.wrappedHandleInput);
		restoreMethod(prototype, "insertTextAtCursor", state.insertTextAtCursor, state.wrappedInsertTextAtCursor);
		restoreMethod(prototype, "render", state.render, state.wrappedRender);
		if (bridgeState(Reflect.get(prototype, BRIDGE_KEY)) === state) Reflect.deleteProperty(prototype, BRIDGE_KEY);
	};
}
