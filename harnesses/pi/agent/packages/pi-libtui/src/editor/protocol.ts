export const EDITOR_REGISTRY_KEY = Symbol.for("pi-libtui/editor/registry/v1");
export const EDITOR_PROTOCOL = "pi-libtui/editor/registry/v1" as const;

export interface EditorPasteHandler {
	readonly id: string;
	readonly priority?: number;
	handle(text: string): string | undefined;
}

export interface EditorRenderDecorator {
	readonly id: string;
	readonly priority?: number;
	decorate(lines: readonly string[], width: number): string[];
}

export interface EditorRegistry {
	readonly protocol: typeof EDITOR_PROTOCOL;
	readonly version: 1;
	registerPasteHandler(handler: EditorPasteHandler): () => void;
	registerRenderDecorator(decorator: EditorRenderDecorator): () => void;
}

interface RegistryState {
	pasteHandlers: EditorPasteHandler[];
	renderDecorators: EditorRenderDecorator[];
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; these validators narrow them.
type UntrustedRegistryValue = unknown;

const STATE_KEY = Symbol.for("pi-libtui/editor/registry-state/v1");
const states = new WeakMap<EditorRegistry, RegistryState>();

function isRecord(value: UntrustedRegistryValue): value is Record<PropertyKey, UntrustedRegistryValue> {
	return value !== null && typeof value === "object";
}

function hasPriority(value: Record<PropertyKey, UntrustedRegistryValue>): boolean {
	return value.priority === undefined || (typeof value.priority === "number" && Number.isFinite(value.priority));
}

function isPasteHandler(value: UntrustedRegistryValue): value is EditorPasteHandler {
	return isRecord(value) && typeof value.id === "string" && hasPriority(value) && typeof value.handle === "function";
}

function isRenderDecorator(value: UntrustedRegistryValue): value is EditorRenderDecorator {
	return isRecord(value) && typeof value.id === "string" && hasPriority(value) && typeof value.decorate === "function";
}

function isState(value: UntrustedRegistryValue): value is RegistryState {
	if (!isRecord(value)) return false;
	return (
		Array.isArray(value.pasteHandlers) &&
		value.pasteHandlers.every(isPasteHandler) &&
		Array.isArray(value.renderDecorators) &&
		value.renderDecorators.every(isRenderDecorator)
	);
}

function stateOf(value: UntrustedRegistryValue): RegistryState | undefined {
	if (!isRecord(value)) return undefined;
	try {
		const state = Reflect.get(value, STATE_KEY) as UntrustedRegistryValue;
		return isState(state) ? state : undefined;
	} catch {
		return undefined;
	}
}

function isRegistry(value: UntrustedRegistryValue): value is EditorRegistry {
	if (!isRecord(value)) return false;
	try {
		return (
			value.protocol === EDITOR_PROTOCOL &&
			value.version === 1 &&
			typeof value.registerPasteHandler === "function" &&
			typeof value.registerRenderDecorator === "function" &&
			stateOf(value) !== undefined
		);
	} catch {
		return false;
	}
}

function stateFor(registry: EditorRegistry): RegistryState {
	const local = states.get(registry);
	if (local && isState(local)) return local;
	const shared = stateOf(registry);
	if (shared) {
		states.set(registry, shared);
		return shared;
	}
	const state: RegistryState = { pasteHandlers: [], renderDecorators: [] };
	try {
		Object.defineProperty(registry, STATE_KEY, { value: state, enumerable: false });
	} catch {
		// A malformed non-configurable state from another realm must not break local editor dispatch.
	}
	states.set(registry, state);
	return state;
}

function ordered<T extends { readonly priority?: number }>(values: readonly T[]): T[] {
	return [...values].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
}

function removeIdentity<T>(values: T[], value: T): void {
	const index = values.indexOf(value);
	if (index >= 0) values.splice(index, 1);
}

function replaceById<T extends { readonly id: string }>(values: T[], value: T): void {
	const index = values.findIndex((existing) => existing.id === value.id);
	if (index >= 0) {
		values[index] = value;
		return;
	}
	values.push(value);
}

function removeActiveById<T extends { readonly id: string }>(values: T[], value: T): void {
	const index = values.findIndex((existing) => existing.id === value.id && existing === value);
	if (index >= 0) values.splice(index, 1);
}

export function dispatchEditorPaste(registry: EditorRegistry, text: string): string | undefined {
	for (const handler of ordered(stateFor(registry).pasteHandlers)) {
		try {
			const replacement = handler.handle(text);
			if (replacement !== undefined) return replacement;
		} catch {
			// Optional feature handlers must not break the editor's native paste path.
		}
	}
	return undefined;
}

export function dispatchEditorRender(registry: EditorRegistry, lines: string[], width: number): string[] {
	let rendered = lines;
	for (const decorator of ordered(stateFor(registry).renderDecorators)) {
		try {
			const next = decorator.decorate(rendered, width);
			if (Array.isArray(next) && next.every((line) => typeof line === "string")) rendered = next;
		} catch {
			// Rendering from one optional feature must not take down the editor.
		}
	}
	return rendered;
}

/** Resolve the process-wide editor registry without activating any Pi host behavior. */
export function ensureEditorRegistry(scope: typeof globalThis = globalThis): EditorRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[EDITOR_REGISTRY_KEY];
	if (isRegistry(existing)) {
		const state = stateOf(existing);
		if (state) states.set(existing, state);
		return existing;
	}

	const registry: EditorRegistry = {
		protocol: EDITOR_PROTOCOL,
		version: 1,
		registerPasteHandler(handler) {
			const handlers = stateFor(registry).pasteHandlers;
			handlers.push(handler);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				removeIdentity(handlers, handler);
			};
		},
		registerRenderDecorator(decorator) {
			const decorators = stateFor(registry).renderDecorators;
			replaceById(decorators, decorator);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				removeActiveById(decorators, decorator);
			};
		},
	};
	stateFor(registry);
	slots[EDITOR_REGISTRY_KEY] = registry;
	return registry;
}
