import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
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
let cachedSkillNames: string[] = [];
let workingActive = false;
let workingFrame = 0;

const WORKING_WORD = "Working";
const WORKING_SHINE_WIDTH = 3;
const WORKING_PERCOLATION_MS = 80;
const RAIL_PULSE_MS = 2000;
const RGB_FALLBACK: Rgb = [0xff, 0xff, 0xff];

type Rgb = [number, number, number];

export function setEditorTheme(uiTheme: Theme): void {
	patchState.currentUiTheme = uiTheme;
}

export function setCachedSkillNames(names: readonly string[]): void {
	cachedSkillNames = [...new Set(names.filter(Boolean))].sort();
}

export function setCachedSkillNamesForTest(names: readonly string[]): void {
	setCachedSkillNames(names);
}

export function setWorkingAnimationState(active: boolean, frame = workingFrame): void {
	workingActive = active;
	workingFrame = frame;
}

export function advanceWorkingAnimationFrame(): void {
	workingFrame++;
}

export function setWorkingAnimationForTest(active: boolean, frame = 0): void {
	setWorkingAnimationState(active, frame);
}

function truncateVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if ([...text].length <= maxWidth) return text;
	if (maxWidth === 1) return "…";
	return `${[...text].slice(0, maxWidth - 1).join("")}…`;
}

function ansi256ToRgb(code: number): Rgb {
	if (code < 16) {
		const base: Rgb[] = [
			[0, 0, 0],
			[128, 0, 0],
			[0, 128, 0],
			[128, 128, 0],
			[0, 0, 128],
			[128, 0, 128],
			[0, 128, 128],
			[192, 192, 192],
			[128, 128, 128],
			[255, 0, 0],
			[0, 255, 0],
			[255, 255, 0],
			[0, 0, 255],
			[255, 0, 255],
			[0, 255, 255],
			[255, 255, 255],
		];
		return base[code] ?? RGB_FALLBACK;
	}
	if (code >= 16 && code <= 231) {
		const n = code - 16;
		const r = Math.floor(n / 36);
		const g = Math.floor((n % 36) / 6);
		const b = n % 6;
		const scale = (value: number) => (value === 0 ? 0 : 55 + value * 40);
		return [scale(r), scale(g), scale(b)];
	}
	const gray = 8 + (code - 232) * 10;
	return [gray, gray, gray];
}

function colorAnsi(uiTheme: Theme, color: string): string | undefined {
	const withGetter = uiTheme as Theme & { getFgAnsi?: (color: string) => string };
	if (withGetter.getFgAnsi) return withGetter.getFgAnsi(color);
	const sample = uiTheme.fg(color as never, "x");
	const marker = sample.indexOf("x");
	return marker >= 0 ? sample.slice(0, marker) : undefined;
}

function colorRgb(uiTheme: Theme, color: string): Rgb {
	const ansi = colorAnsi(uiTheme, color);
	const truecolor = ansi?.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];

	const color256 = ansi?.match(/\x1b\[38;5;(\d+)m/);
	if (color256) return ansi256ToRgb(Number(color256[1]));

	return RGB_FALLBACK;
}

function scaleRgb([r, g, b]: Rgb, factor: number): Rgb {
	const scale = (value: number) => Math.round(Math.max(0, Math.min(255, value * factor)));
	return [scale(r), scale(g), scale(b)];
}

function rgbFg([r, g, b]: Rgb): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

function rgbBg([r, g, b]: Rgb): string {
	return `\x1b[48;2;${r};${g};${b}m`;
}

function triangleWave(frame: number, periodMs: number, lo: number, hi: number): number {
	const elapsedMs = frame * WORKING_PERCOLATION_MS;
	const t = (elapsedMs % periodMs) / periodMs;
	const tri = 1 - Math.abs(2 * t - 1);
	return lo + tri * (hi - lo);
}

function modeColor(mode: string | undefined): string {
	if (mode === "insert") return "success";
	if (mode === "visual") return "accent";
	return "syntaxFunction";
}

function renderWorkingWord(uiTheme: Theme, color: string, frame: number): string {
	const base = scaleRgb(colorRgb(uiTheme, color), 0.55);
	const shine = scaleRgb(colorRgb(uiTheme, color), 1.55);
	const step = Math.floor((frame * WORKING_PERCOLATION_MS) / WORKING_PERCOLATION_MS);
	const chars = [...WORKING_WORD];
	const cycle = chars.length + WORKING_SHINE_WIDTH;
	const pos = step % cycle;

	return chars
		.map((ch, index) => {
			const inShine = index >= pos - WORKING_SHINE_WIDTH && index < pos;
			return `${rgbFg(inShine ? shine : base)}${ch}`;
		})
		.join("");
}

function workingHeaderSegment(innerWidth: number, uiTheme: Theme, color: string): string {
	if (!workingActive) return "";
	const label = renderWorkingWord(uiTheme, color, workingFrame);
	return truncateToWidth(`${label}${ANSI_RESET}`, innerWidth, "");
}

function cachedSkillsSegment(innerWidth: number, uiTheme: Theme): string {
	if (cachedSkillNames.length === 0) return "";
	const label = truncateVisible(`skills: ${cachedSkillNames.join(", ")}`, innerWidth);
	return uiTheme.fg("dim", label);
}

export function renderPolishedEditorForTest(
	editor: TransformableEditor,
	width: number,
	renderBase: (width: number) => string[],
	minTerminalRows: number,
	uiThemeOverride?: Theme,
): string[] {
	const rows = terminalRows();
	if (rows !== undefined && rows < minTerminalRows) return renderBase(width);
	const uiTheme = uiThemeOverride ?? patchState.currentUiTheme;
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
	const railColor = modeColor(mode);
	const railPulseFactor = workingActive ? triangleWave(workingFrame, RAIL_PULSE_MS, 0.18, 1.25) : 0;
	const railBg = workingActive ? rgbBg(scaleRgb(colorRgb(uiTheme, railColor), railPulseFactor)) : "";
	const rail = `${railBg}${uiTheme.fg(railColor as never, "┃")}\x1b[49m${ANSI_RESET}${uiTheme.bg("customMessageBg", " ")}`;
	const lines = [
		workingHeaderSegment(innerWidth, uiTheme, railColor),
		...editorLines,
		cachedSkillsSegment(innerWidth, uiTheme),
	];

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
		return renderPolishedEditorForTest(
			this as unknown as TransformableEditor,
			width,
			(w) => originalRender.call(this, w),
			minTerminalRows,
		);
	};
}
