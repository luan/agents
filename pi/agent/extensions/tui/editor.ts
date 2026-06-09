import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { rgbBg, rgbFg, scaleRgb, shineText, themeRoleToRgb, triangleWave } from "../shared/tui";
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

type EditorChrome = {
	topRight?: string;
	bottomRight?: string;
};

type EditorChromeProvider = (width: number, theme: Theme, options: { modeReserve: number }) => EditorChrome;

export interface EditorSessionIdentity {
	label?: string;
	name?: string;
	color?: string;
}

export type WorkingTimerSnapshot = {
	active: boolean;
	startedAtMs?: number;
	lastTurnMs?: number;
	cumulativeMs: number;
	persistedAtMs: number;
};

type UiPatchState = { currentUiTheme?: Theme };
const globalPatchState = globalThis as typeof globalThis & {
	__agentsPolishedTuiState?: UiPatchState;
};
globalPatchState.__agentsPolishedTuiState ??= {};
const patchState = globalPatchState.__agentsPolishedTuiState;

let workingActive = false;
let workingFrame = 0;
let workingStartedAtMs: number | undefined;
let lastWorkingDurationMs: number | undefined;
let cumulativeWorkingDurationMs = 0;
let workingNowMsForTest: number | undefined;
let editorSessionIdentityProvider: (() => EditorSessionIdentity | undefined) | undefined;

const WORKING_WORD = "Working";
const WORKING_PERCOLATION_MS = 80;
const RAIL_PULSE_MS = 2000;
const EDITOR_BG_DARKEN = 0.78;
const MODE_LABEL_RESERVE = 9;
let editorChromeProvider: EditorChromeProvider | undefined;

export function setEditorTheme(uiTheme: Theme): void {
	patchState.currentUiTheme = uiTheme;
}

export function setWorkingAnimationState(active: boolean, frame = workingFrame): void {
	workingActive = active;
	workingFrame = frame;
}

export function advanceWorkingAnimationFrame(): void {
	workingFrame++;
}

export function setWorkingTimerStarted(nowMs = Date.now()): void {
	workingNowMsForTest = undefined;
	workingStartedAtMs = nowMs;
	lastWorkingDurationMs = undefined;
	setWorkingAnimationState(true, 0);
}

export function setWorkingTimerStopped(nowMs = Date.now()): void {
	if (workingStartedAtMs !== undefined) {
		const durationMs = Math.max(0, nowMs - workingStartedAtMs);
		lastWorkingDurationMs = durationMs;
		cumulativeWorkingDurationMs += durationMs;
	}
	workingStartedAtMs = undefined;
	setWorkingAnimationState(false, 0);
}

export function resetWorkingTimerState(): void {
	workingStartedAtMs = undefined;
	lastWorkingDurationMs = undefined;
	cumulativeWorkingDurationMs = 0;
	workingNowMsForTest = undefined;
	setWorkingAnimationState(false, 0);
}

function finiteNonNegative(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function getWorkingTimerSnapshot(
	nowMs = Date.now(),
	options: { freezeActive?: boolean } = {},
): WorkingTimerSnapshot {
	const activeDurationMs = activeWorkingDurationMs();
	const freezeActive = options.freezeActive && workingActive;
	return {
		active: workingActive && !freezeActive,
		startedAtMs: workingActive && !freezeActive ? workingStartedAtMs : undefined,
		lastTurnMs: freezeActive ? activeDurationMs : lastWorkingDurationMs,
		cumulativeMs: cumulativeWorkingDurationMs + (freezeActive ? activeDurationMs : 0),
		persistedAtMs: nowMs,
	};
}

export function restoreWorkingTimerSnapshot(
	snapshot: WorkingTimerSnapshot | undefined,
	options: { restoreActive?: boolean } = {},
): void {
	if (!snapshot) {
		resetWorkingTimerState();
		return;
	}

	cumulativeWorkingDurationMs = finiteNonNegative(snapshot.cumulativeMs) ?? 0;
	lastWorkingDurationMs = finiteNonNegative(snapshot.lastTurnMs);
	workingStartedAtMs = options.restoreActive && snapshot.active ? finiteNonNegative(snapshot.startedAtMs) : undefined;
	workingNowMsForTest = undefined;
	setWorkingAnimationState(Boolean(workingStartedAtMs), 0);
}

export function setWorkingAnimationForTest(
	active: boolean,
	frame = 0,
	timing: { elapsedMs?: number; lastTurnMs?: number; cumulativeMs?: number } = {},
): void {
	const nowMs = 1_700_000_000_000;
	workingNowMsForTest = nowMs;
	workingStartedAtMs = active ? nowMs - (timing.elapsedMs ?? 0) : undefined;
	lastWorkingDurationMs = timing.lastTurnMs;
	cumulativeWorkingDurationMs = timing.cumulativeMs ?? 0;
	setWorkingAnimationState(active, frame);
}

export function setEditorChromeProvider(provider: EditorChromeProvider | undefined): void {
	editorChromeProvider = provider;
}

export function setEditorSessionIdentityProvider(
	provider: (() => EditorSessionIdentity | undefined) | undefined,
): void {
	editorSessionIdentityProvider = provider;
}

function isStaleCtxError(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error)).includes("ctx is stale");
}

function getEditorSessionIdentity(): EditorSessionIdentity | undefined {
	try {
		return editorSessionIdentityProvider?.();
	} catch (error) {
		if (!isStaleCtxError(error)) throw error;
		editorSessionIdentityProvider = undefined;
		return undefined;
	}
}

function truncateVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if ([...text].length <= maxWidth) return text;
	if (maxWidth === 1) return "…";
	return `${[...text].slice(0, maxWidth - 1).join("")}…`;
}

function colorFg(uiTheme: Theme, color: string, text: string): string {
	return `${rgbFg(themeRoleToRgb(uiTheme, color))}${text}\x1b[39m`;
}

function modeColor(mode: string | undefined): string {
	if (mode === "insert") return "success";
	if (mode === "visual") return "accent";
	return "syntaxFunction";
}

function railColorForMode(mode: string | undefined, identityColor: string | undefined): string {
	if (mode === "normal" && identityColor) return identityColor;
	return modeColor(mode);
}

function renderWorkingWord(uiTheme: Theme, color: string, frame: number): string {
	return shineText(uiTheme, WORKING_WORD, frame * WORKING_PERCOLATION_MS, {
		role: color,
		fallback: (text) => uiTheme.fg("warning", text),
	}).replace(/\x1b\[39m$/, "");
}

export function formatWorkingDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

function nowMs(): number {
	return workingNowMsForTest ?? Date.now();
}

function activeWorkingDurationMs(): number {
	if (workingStartedAtMs === undefined) return 0;
	return Math.max(0, nowMs() - workingStartedAtMs);
}

function totalWorkingDurationMs(): number {
	return cumulativeWorkingDurationMs + (workingActive ? activeWorkingDurationMs() : 0);
}

function workingHeaderSegment(uiTheme: Theme, color: string): string {
	if (!workingActive) {
		if (lastWorkingDurationMs === undefined) return "";
		const text = `Last turn: ${formatWorkingDuration(lastWorkingDurationMs)}. Total cumulative: ${formatWorkingDuration(totalWorkingDurationMs())}.`;
		return `${uiTheme.fg("dim", text)}${ANSI_RESET}`;
	}
	const label = renderWorkingWord(uiTheme, color, workingFrame);
	const elapsed = activeWorkingDurationMs();
	const timing = uiTheme.fg(
		"dim",
		` ${formatWorkingDuration(elapsed)}. Total cumulative: ${formatWorkingDuration(totalWorkingDurationMs())}.`,
	);
	return `${label}${rgbFg(scaleRgb(themeRoleToRgb(uiTheme, color), 0.85))}…${timing}${ANSI_RESET}`;
}

function cleanIdentityPart(value: string | undefined): string | undefined {
	const text = value
		?.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text || undefined;
}

function sessionIdentityText(identity: EditorSessionIdentity | undefined): string | undefined {
	const label = cleanIdentityPart(identity?.label);
	const name = cleanIdentityPart(identity?.name);
	if (label && name) return `${label} ${name}`;
	return label ?? name;
}

function renderIdentityText(uiTheme: Theme, identity: string, identityColor: string | undefined): string {
	if (!identityColor) return uiTheme.fg("dim", identity);
	const rgb = themeRoleToRgb(uiTheme, identityColor);
	return `${rgbFg(scaleRgb(rgb, 0.62))}${identity}${ANSI_RESET}`;
}

function headerLeftSegment(
	width: number,
	uiTheme: Theme,
	color: string,
	identity: string | undefined,
	identityColor: string | undefined,
): string {
	const working = workingHeaderSegment(uiTheme, color);
	if (identity && working) {
		const delimiter = uiTheme.fg("dim", " · ");
		const identityWidth = width - visibleWidth(working) - visibleWidth(delimiter);
		if (identityWidth <= 0) return truncateToWidth(working, width, "");
		const fittedIdentity = renderIdentityText(uiTheme, truncateVisible(identity, identityWidth), identityColor);
		return truncateToWidth(`${fittedIdentity}${delimiter}${working}`, width, "");
	}
	if (identity) return renderIdentityText(uiTheme, truncateVisible(identity, width), identityColor);
	return truncateToWidth(working, width, "");
}

function composeLeftRight(left: string, right: string | undefined, width: number): string {
	if (!right) return truncateToWidth(left, width, "");
	if (!left) return " ".repeat(Math.max(0, width - visibleWidth(right))) + truncateToWidth(right, width, "");

	const maxRightWidth = Math.max(0, width - visibleWidth(left) - 1);
	const fittedRight = truncateToWidth(right, maxRightWidth, "");
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(fittedRight));
	return truncateToWidth(left, width, "") + " ".repeat(gap) + fittedRight;
}

export function renderPolishedEditorForTest(
	editor: TransformableEditor,
	width: number,
	renderBase: (width: number) => string[],
	uiThemeOverride?: Theme,
): string[] {
	const uiTheme = uiThemeOverride ?? patchState.currentUiTheme;
	if (!uiTheme) return renderBase(width);

	const identity = getEditorSessionIdentity();
	const identityText = sessionIdentityText(identity);
	const identityColor = cleanIdentityPart(identity?.color);
	const mode = typeof editor.getMode === "function" ? editor.getMode() : undefined;
	const railColor = railColorForMode(mode, identityColor);
	const secondaryRailColor = identityColor && railColor !== identityColor ? identityColor : undefined;
	const railWidth = 2 + (secondaryRailColor ? 1 : 0);
	const innerWidth = Math.max(1, width - railWidth);
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
	const modeReserve = typeof editor.getMode === "function" ? MODE_LABEL_RESERVE : 0;
	const statusWidth = Math.max(1, innerWidth - modeReserve);
	const chrome = editorChromeProvider?.(innerWidth, uiTheme, { modeReserve }) ?? {};
	const railPulseFactor = workingActive
		? triangleWave(workingFrame * WORKING_PERCOLATION_MS, RAIL_PULSE_MS, 0.18, 1.25)
		: 0;
	const railBg = workingActive ? rgbBg(scaleRgb(themeRoleToRgb(uiTheme, railColor), railPulseFactor)) : "";
	const railGap = fillBackgroundLine(uiTheme, "", 1, { darken: EDITOR_BG_DARKEN });
	const secondaryRail = secondaryRailColor ? `${colorFg(uiTheme, secondaryRailColor, "▐")}${ANSI_RESET}` : "";
	const mainRailGlyph = secondaryRailColor ? "▌" : "┃";
	const rail = `${secondaryRail}${railBg}${colorFg(uiTheme, railColor, mainRailGlyph)}\x1b[49m${ANSI_RESET}${railGap}`;
	const lines = [
		composeLeftRight(
			headerLeftSegment(innerWidth, uiTheme, railColor, identityText, identityColor),
			chrome.topRight,
			innerWidth,
		),
		...editorLines,
		composeLeftRight("", chrome.bottomRight, statusWidth),
	];

	return [
		...lines.map((line) => `${rail}${fillBackgroundLine(uiTheme, line, innerWidth, { darken: EDITOR_BG_DARKEN })}`),
		...autocompleteLines,
	];
}

export function installEditorComposition(uiTheme: Theme): void {
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
		return renderPolishedEditorForTest(this as unknown as TransformableEditor, width, (w) =>
			originalRender.call(this, w),
		);
	};
}
