import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { colorize } from "./highlight";

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type EditorUi = {
	getEditorComponent?: () => EditorFactory | undefined;
	setEditorComponent: (factory: EditorFactory | undefined) => void;
};

type TransformableEditor = EditorComponent & {
	transformEditorLine?: (line: string) => string;
};

const WRAPPED_FACTORY = Symbol.for("skill-dollar.editorFactoryWrapped");
const WRAPPED_FACTORY_STATE = Symbol.for("skill-dollar.editorFactoryWrappedState");
const UI_STATE = Symbol.for("skill-dollar.editorHighlightState");

type HighlightState = {
	getSkillNames: () => Set<string>;
	setEditorComponent: EditorUi["setEditorComponent"];
};

type HighlightableEditorUi = EditorUi & {
	[UI_STATE]?: HighlightState;
};

function colorizeLines(lines: string[], getSkillNames: () => Set<string>): string[] {
	return lines.map((line) => colorize(line, getSkillNames()));
}

function wrapEditorFactory(previous: EditorFactory | undefined, state: HighlightState): EditorFactory {
	const maybeWrapped = previous as (EditorFactory & Record<symbol, unknown>) | undefined;
	if (maybeWrapped?.[WRAPPED_FACTORY] && maybeWrapped[WRAPPED_FACTORY_STATE] === state) return maybeWrapped;

	const wrapped: EditorFactory = (tui, theme, keybindings) => {
		const editor = (previous?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings)) as TransformableEditor;
		const previousTransform = editor.transformEditorLine?.bind(editor);
		if (previousTransform) {
			editor.transformEditorLine = (line: string) => colorize(previousTransform(line), state.getSkillNames());
		} else {
			const previousRender = editor.render.bind(editor);
			editor.render = (width: number) => colorizeLines(previousRender(width), state.getSkillNames);
		}
		return editor;
	};
	(wrapped as unknown as Record<symbol, unknown>)[WRAPPED_FACTORY] = true;
	(wrapped as unknown as Record<symbol, unknown>)[WRAPPED_FACTORY_STATE] = state;
	return wrapped;
}

export function installEditorHighlight(ui: EditorUi, getSkillNames: () => Set<string>): void {
	if (typeof ui.getEditorComponent !== "function") return;
	const highlightUi = ui as HighlightableEditorUi;
	const state = highlightUi[UI_STATE] ?? { getSkillNames, setEditorComponent: ui.setEditorComponent.bind(ui) };
	state.getSkillNames = getSkillNames;
	highlightUi[UI_STATE] = state;

	ui.setEditorComponent = (factory) => state.setEditorComponent(wrapEditorFactory(factory, state));
	ui.setEditorComponent(ui.getEditorComponent());
}
