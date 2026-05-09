import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { terminalRows } from "../shared/terminal";
import { ANSI_RESET, fillBackgroundLine } from "./render-lines";

const CUSTOM_EDITOR_ORIGINAL_RENDER = Symbol.for("agents.polishedTui.customEditorOriginalRender");

type AutocompleteEditorInternals = {
	autocompleteList?: Pick<Component, "render">;
	isShowingAutocomplete?: () => boolean;
};

type TransformableEditor = AutocompleteEditorInternals & {
	getMode?: () => string;
	transformEditorLine?: (line: string) => string;
};

type UiPatchState = { currentUiTheme?: Theme };
const globalPatchState = globalThis as typeof globalThis & {
	__agentsPolishedTuiState?: UiPatchState;
};
globalPatchState.__agentsPolishedTuiState ??= {};
const patchState = globalPatchState.__agentsPolishedTuiState;

export function setEditorTheme(uiTheme: Theme): void {
	patchState.currentUiTheme = uiTheme;
}

function renderPolishedEditor(
	editor: TransformableEditor,
	width: number,
	renderBase: (width: number) => string[],
	minTerminalRows: number,
): string[] {
	const rows = terminalRows();
	if (rows !== undefined && rows < minTerminalRows) return renderBase(width);
	const uiTheme = patchState.currentUiTheme;
	if (!uiTheme) return renderBase(width);

	const innerWidth = Math.max(1, width - 2);
	const rendered = renderBase(innerWidth);
	const isShowingAutocomplete =
		typeof editor.isShowingAutocomplete === "function" ? Boolean(editor.isShowingAutocomplete()) : false;

	if (rendered.length < 2) return renderBase(width);

	const { autocompleteList } = editor;
	const autocompleteCount =
		isShowingAutocomplete && typeof autocompleteList?.render === "function"
			? autocompleteList.render(innerWidth).length
			: 0;
	const editorFrame =
		autocompleteCount > 0 && autocompleteCount < rendered.length ? rendered.slice(0, -autocompleteCount) : rendered;
	const autocompleteLines =
		autocompleteCount > 0 && autocompleteCount < rendered.length ? rendered.slice(-autocompleteCount) : [];

	if (editorFrame.length < 2) return rendered;

	const transformEditorLine: (line: string) => string =
		typeof editor.transformEditorLine === "function"
			? (line: string) => editor.transformEditorLine?.(line) ?? line
			: (line: string) => line;
	const editorLines = editorFrame.slice(1, -1).map(transformEditorLine);
	const mode = typeof editor.getMode === "function" ? editor.getMode() : undefined;
	const railColor = mode === "insert" ? "success" : mode === "visual" ? "accent" : "syntaxFunction";
	const rail = `${uiTheme.fg(railColor, "┃")}${ANSI_RESET}${uiTheme.bg("customMessageBg", " ")}`;
	const lines = ["", ...editorLines, ""];

	return [...lines.map((line) => `${rail}${fillBackgroundLine(uiTheme, line, innerWidth)}`), ...autocompleteLines];
}

export function installEditorComposition(uiTheme: Theme, minTerminalRows = 28): void {
	setEditorTheme(uiTheme);

	// Patch the shared base editor instead of replacing the active editor so
	// Other packages can keep their own editor/autocomplete behavior.
	const prototype = CustomEditor.prototype as unknown as CustomEditor & {
		render(width: number): string[];
	} & Record<symbol, unknown>;
	const originalRender =
		(prototype[CUSTOM_EDITOR_ORIGINAL_RENDER] as ((this: CustomEditor, width: number) => string[]) | undefined) ??
		prototype.render;
	prototype[CUSTOM_EDITOR_ORIGINAL_RENDER] ??= prototype.render;
	prototype.render = function (this: CustomEditor, width: number): string[] {
		return renderPolishedEditor(
			this as unknown as TransformableEditor,
			width,
			(w) => originalRender.call(this, w),
			minTerminalRows,
		);
	};
}
