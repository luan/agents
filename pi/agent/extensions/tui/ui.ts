import { CustomEditor, type Theme, UserMessageComponent } from "@mariozechner/pi-coding-agent";
import { type Component, Container, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const USER_MESSAGE_ORIGINAL_RENDER = Symbol.for("agents.polishedTui.userMessageOriginalRender");
const CUSTOM_EDITOR_ORIGINAL_RENDER = Symbol.for("agents.polishedTui.customEditorOriginalRender");

type AutocompleteEditorInternals = {
	autocompleteList?: Pick<Component, "render">;
	isShowingAutocomplete?: () => boolean;
};

type TransformableEditor = AutocompleteEditorInternals & {
	transformEditorLine?: (line: string) => string;
};

type UiPatchState = { currentUiTheme?: Theme };
const globalPatchState = globalThis as typeof globalThis & {
	__agentsPolishedTuiState?: UiPatchState;
};
globalPatchState.__agentsPolishedTuiState ??= {};
const patchState = globalPatchState.__agentsPolishedTuiState;

const ESCAPE_PATTERN = "\\x1B";
const RESET_ANSI = new RegExp(`${ESCAPE_PATTERN}\\[0m`, "g");
const RESET = "\x1b[0m";

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, width, "");
	const spaces = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${spaces}`;
}

function fillBackgroundLine(uiTheme: Theme, content: string, width: number): string {
	const filled = fillLine(content, width);
	const sample = uiTheme.bg("customMessageBg", " ");
	const spaceIndex = sample.indexOf(" ");
	if (spaceIndex < 0) return uiTheme.bg("customMessageBg", filled);

	const backgroundStart = sample.slice(0, spaceIndex);
	const backgroundEnd = sample.slice(spaceIndex + 1);
	return `${backgroundStart}${filled.replace(RESET_ANSI, `${RESET}${backgroundStart}`)}${backgroundEnd}`;
}

export function patchUserMessageComponent(uiTheme: Theme): void {
	patchState.currentUiTheme = uiTheme;

	const prototype = UserMessageComponent.prototype as unknown as {
		render(width: number): string[];
	} & Record<symbol, unknown>;
	const originalRender =
		(prototype[USER_MESSAGE_ORIGINAL_RENDER] as
			| ((this: UserMessageComponent, width: number) => string[])
			| undefined) ?? prototype.render;
	if (prototype[USER_MESSAGE_ORIGINAL_RENDER]) return;
	prototype[USER_MESSAGE_ORIGINAL_RENDER] = prototype.render;
	prototype.render = function (this: UserMessageComponent, width: number): string[] {
		const uiTheme = patchState.currentUiTheme;
		if (!uiTheme) return originalRender.call(this, width);

		const railWidth = 2;
		const innerWidth = Math.max(1, width - railWidth);
		const baseLines = Container.prototype.render.call(this, innerWidth) as string[];
		if (baseLines.length === 0) return baseLines;

		const hasLeadingSpacer = baseLines.length > 1 && visibleWidth(baseLines[0] ?? "") === 0;
		const leadingLines = hasLeadingSpacer ? [baseLines[0] ?? ""] : [];
		const contentLines = hasLeadingSpacer ? baseLines.slice(1) : baseLines;
		const rail = `${uiTheme.fg("border", "┃")}${RESET}${uiTheme.bg("customMessageBg", " ")}`;
		const styledLines = contentLines.map((line) => `${rail}${fillBackgroundLine(uiTheme, line, innerWidth)}`);

		if (styledLines.length === 0) {
			return leadingLines;
		}

		styledLines[0] = OSC133_ZONE_START + styledLines[0];
		styledLines[styledLines.length - 1] += OSC133_ZONE_END + OSC133_ZONE_FINAL;
		return [...leadingLines, ...styledLines];
	};
}

function renderPolishedEditor(
	editor: TransformableEditor,
	width: number,
	renderBase: (width: number) => string[],
): string[] {
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
	const rail = `${uiTheme.fg("accent", "┃")}${RESET}${uiTheme.bg("customMessageBg", " ")}`;
	const lines = ["", ...editorLines, ""];

	return [...lines.map((line) => `${rail}${fillBackgroundLine(uiTheme, line, innerWidth)}`), ...autocompleteLines];
}

export function installEditorComposition(uiTheme: Theme): void {
	patchState.currentUiTheme = uiTheme;

	// Patch the shared base editor instead of replacing the active editor so
	// packages like pi-fff can keep their own editor/autocomplete behavior.
	const prototype = CustomEditor.prototype as unknown as CustomEditor & {
		render(width: number): string[];
	} & Record<symbol, unknown>;
	const originalRender =
		(prototype[CUSTOM_EDITOR_ORIGINAL_RENDER] as ((this: CustomEditor, width: number) => string[]) | undefined) ??
		prototype.render;
	if (prototype[CUSTOM_EDITOR_ORIGINAL_RENDER]) return;
	prototype[CUSTOM_EDITOR_ORIGINAL_RENDER] = prototype.render;
	prototype.render = function (this: CustomEditor, width: number): string[] {
		return renderPolishedEditor(this as unknown as TransformableEditor, width, (w) => originalRender.call(this, w));
	};
}
