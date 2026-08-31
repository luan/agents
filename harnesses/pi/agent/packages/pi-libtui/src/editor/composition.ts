import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The editor factory shape exposed by Pi's interactive UI. */
export type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** The small UI surface required to compose editor factories. */
export type EditorUi = Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent">;

/** Wrap an existing editor factory while preserving other installed layers. */
export type EditorLayer = (previous: EditorFactory | undefined) => EditorFactory;

interface EditorLayerState {
	base: EditorFactory | undefined;
	layers: Map<symbol, EditorLayer>;
	applied: EditorFactory | undefined;
}

const states = new WeakMap<object, EditorLayerState>();

function compose(state: EditorLayerState): EditorFactory | undefined {
	let factory = state.base;
	for (const layer of state.layers.values()) factory = layer(factory);
	return factory;
}

/** Install an idempotently removable editor layer on one Pi UI instance. */
export function installEditorLayer(ui: EditorUi, id: symbol, layer: EditorLayer): () => void {
	const key = ui as object;
	let state = states.get(key);
	if (!state) {
		state = { base: ui.getEditorComponent(), layers: new Map(), applied: undefined };
		states.set(key, state);
	}
	state.layers.set(id, layer);
	const applied = compose(state);
	state.applied = applied;
	ui.setEditorComponent(applied);

	let active = true;
	return () => {
		if (!active) return;
		active = false;
		const current = states.get(key);
		if (!current || current.layers.get(id) !== layer) return;
		current.layers.delete(id);
		if (ui.getEditorComponent() === current.applied) {
			const next = compose(current);
			current.applied = next;
			ui.setEditorComponent(next);
		}
		if (current.layers.size === 0) states.delete(key);
	};
}
