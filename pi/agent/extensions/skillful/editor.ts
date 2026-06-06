import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { type EditorFactory, type EditorUi, installEditorLayer } from "../shared/tui";
import { colorize, colorizeLines } from "./highlight";

const EDITOR_LAYER_ID = Symbol.for("skillful.editorHighlightLayer");
const ANSI_RE = /\x1b\[[0-9;]*m/g;

type TransformableEditor = EditorComponent & {
	transformEditorLine?: (line: string) => string;
};

type HighlightState = {
	inFence: boolean;
};

function colorizeEditorLine(line: string, skills: Set<string>, state: HighlightState): string {
	const plain = line.replace(ANSI_RE, "").trimStart();
	if (plain.startsWith("```")) {
		state.inFence = !state.inFence;
		return line;
	}
	if (state.inFence) return line;
	return colorize(line, skills);
}

function wrapEditorFactory(previous: EditorFactory | undefined, getSkillNames: () => Set<string>): EditorFactory {
	const wrapped: EditorFactory = (tui, theme, keybindings) => {
		const editor = (previous?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings)) as TransformableEditor;
		const previousRender = editor.render.bind(editor);
		const previousTransform = editor.transformEditorLine?.bind(editor);
		let state: HighlightState = { inFence: false };
		let usedLineTransform = false;
		editor.transformEditorLine = (line: string) => {
			usedLineTransform = true;
			return colorizeEditorLine(previousTransform?.(line) ?? line, getSkillNames(), state);
		};
		editor.render = (width: number) => {
			state = { inFence: false };
			usedLineTransform = false;
			const rendered = previousRender(width);
			return usedLineTransform ? rendered : colorizeLines(rendered, getSkillNames());
		};
		return editor;
	};
	return wrapped;
}

export function installEditorHighlight(ui: EditorUi, getSkillNames: () => Set<string>): void {
	installEditorLayer(ui, EDITOR_LAYER_ID, (factory) => wrapEditorFactory(factory, getSkillNames));
}
