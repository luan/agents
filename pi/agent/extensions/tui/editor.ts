import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { rgbFg, scaleRgb, shineText, themeRoleToRgb } from "../shared/tui";
import { ANSI_RESET, fillEditorLine, fillEditorTransitionLine } from "./render-lines";

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

type EditorChromeProvider = (
	width: number,
	theme: Theme,
	options: { modeReserve: number; topRightWidth: number },
) => EditorChrome;

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
let workingFastMode = false;
let editorSessionIdentityProvider: (() => EditorSessionIdentity | undefined) | undefined;
let transitionRailColor = "syntaxFunction";
let transitionIdentityColor: string | undefined;

const WORKING_WORD = "Working";
const ZIPPING_VARIANTS = [
	["ż", "i", "ṅ", "ġ"],
	["ž", "ǐ", "ň", "ǧ"],
	["ẑ", "î", "n̂", "ĝ"],
	["ẕ", "ī", "ṉ", "ḡ"],
	["ẓ", "ị", "ṇ", "g̣"],
	["z̧", "į", "ņ", "ģ"],
	["z̃", "ĩ", "ñ", "g̃"],
	["z̊", "i̊", "n̊", "g̊"],
	["z̸", "i̸", "n̸", "g̸"],
] as const;
export const WORKING_ANIMATION_INTERVAL_MS = 32;
const RAIL_PULSE_MS = 2000;
const MODE_LABEL_RESERVE = 9;
const FULL_RAIL_FRAMES = ["▐"] as const;
const HALF_RAIL_FRAMES = ["▗"] as const;
const SECONDARY_RAIL_FRAMES = FULL_RAIL_FRAMES;
let editorChromeProvider: EditorChromeProvider | undefined;

function setEditorTheme(uiTheme: Theme): void {
	patchState.currentUiTheme = uiTheme;
}

function animatedRail(frames: readonly string[], uiTheme: Theme, color: string, fallback: string): string {
	if (!workingActive) return colorFg(uiTheme, color, fallback);
	const phase = ((workingFrame * WORKING_ANIMATION_INTERVAL_MS) % RAIL_PULSE_MS) / RAIL_PULSE_MS;
	const progress = (1 - Math.cos(phase * Math.PI * 2)) / 2;
	const factor = 0.35 + progress * 0.8;
	const glyph = frames[Math.round(progress * (frames.length - 1))] ?? fallback;
	return `${rgbFg(scaleRgb(themeRoleToRgb(uiTheme, color), factor))}${glyph}${ANSI_RESET}`;
}

function renderEditorTransition(width: number, uiTheme: Theme, mode?: string): string {
	const railColor = mode === undefined ? transitionRailColor : railColorForMode(mode, transitionIdentityColor);
	const secondaryRailColor =
		transitionIdentityColor && railColor !== transitionIdentityColor ? transitionIdentityColor : undefined;
	const secondary = secondaryRailColor ? `${colorFg(uiTheme, secondaryRailColor, "▖")}${ANSI_RESET}` : "";
	const rail = `${secondary}${animatedRail(HALF_RAIL_FRAMES, uiTheme, railColor, "╻")}`;
	return fillEditorTransitionLine(uiTheme, rail, width);
}

function setWorkingAnimationState(active: boolean, frame = workingFrame): void {
	workingActive = active;
	workingFrame = frame;
}

export function advanceWorkingAnimationFrame(): void {
	workingFrame++;
}

export function setWorkingFastMode(active: boolean): void {
	workingFastMode = active;
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

function trimTrailingBlanks(line: string): string {
	return line.replace(/[ \t]+$/, "");
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
	if (workingFastMode) {
		const variants = ZIPPING_VARIANTS[frame % ZIPPING_VARIANTS.length] ?? ZIPPING_VARIANTS[0];
		const word = [variants[0], variants[1], "p", "p", "i", variants[2], variants[3], "…"];
		const popIndex = word.length - 1 - (Math.floor(frame / 2) % word.length);
		const baseRgb = themeRoleToRgb(uiTheme, color);
		const warningBaseRgb = themeRoleToRgb(uiTheme, "warning");
		const warningRgb = scaleRgb(warningBaseRgb, 1.25);
		const warningEdgeRgb = scaleRgb(warningBaseRgb, 0.65);
		const baseShinePosition = ((frame * WORKING_ANIMATION_INTERVAL_MS) / 80) % (word.length + 3);
		const letters = word
			.map((letter, index) => {
				if (popIndex === index) return `\x1b[1;9m${rgbFg(warningRgb)}${letter}\x1b[22;29;39m`;
				const leftIndex = (popIndex + word.length - 1) % word.length;
				const rightIndex = (popIndex + 1) % word.length;
				if (index === leftIndex || index === rightIndex) {
					return `\x1b[9m${rgbFg(warningEdgeRgb)}${letter}\x1b[29;39m`;
				}
				const shineDistance = baseShinePosition - index;
				const shineAmount = shineDistance > 0 && shineDistance < 3 ? Math.sin((shineDistance / 3) * Math.PI) : 0;
				const brightness = 0.55 + shineAmount;
				return `${rgbFg(scaleRgb(baseRgb, brightness))}${letter}\x1b[39m`;
			})
			.join("");
		return `${uiTheme.fg("warning", "⚡")}${letters}`;
	}
	return shineText(uiTheme, WORKING_WORD, frame * WORKING_ANIMATION_INTERVAL_MS, {
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

function workingHeaderSegment(uiTheme: Theme, color: string, width: number): string {
	if (!workingActive) {
		if (lastWorkingDurationMs === undefined) return "";
		const text = uiTheme.fg(
			"dim",
			`Last turn: ${formatWorkingDuration(lastWorkingDurationMs)}. Total cumulative: ${formatWorkingDuration(totalWorkingDurationMs())}.`,
		);
		return `${truncateToWidth(text, width, "")}${ANSI_RESET}`;
	}
	const label = renderWorkingWord(uiTheme, color, workingFrame);
	const elapsed = activeWorkingDurationMs();
	const timing = uiTheme.fg(
		"dim",
		` ${formatWorkingDuration(elapsed)}. Total cumulative: ${formatWorkingDuration(totalWorkingDurationMs())}.`,
	);
	const ellipsis = workingFastMode ? "" : `${rgbFg(scaleRgb(themeRoleToRgb(uiTheme, color), 0.85))}…`;
	const left = `${label}${ellipsis}${timing}`;
	return `${truncateToWidth(left, width, "")}${ANSI_RESET}`;
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
	const working = workingHeaderSegment(uiTheme, color, width);
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

	const fittedRight = truncateToWidth(right, width, "");
	const rightWidth = visibleWidth(fittedRight);
	if (!left || rightWidth >= width) return " ".repeat(Math.max(0, width - rightWidth)) + fittedRight;

	const fittedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "");
	const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
	return fittedLeft + " ".repeat(gap) + fittedRight;
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
	transitionIdentityColor = identityColor;
	const mode = typeof editor.getMode === "function" ? editor.getMode() : undefined;
	const railColor = railColorForMode(mode, identityColor);
	const secondaryRailColor = identityColor && railColor !== identityColor ? identityColor : undefined;
	transitionRailColor = railColor;
	const railWidth = 2 + (secondaryRailColor ? 1 : 0);
	const innerWidth = Math.max(1, width - railWidth);
	const modeReserve = typeof editor.getMode === "function" ? MODE_LABEL_RESERVE : 0;
	const statusWidth = Math.max(1, innerWidth - modeReserve);
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
	const rawEditorLines = editorFrame.slice(1, -1);
	const editorLines = rawEditorLines.map(transformEditorLine);
	const railGap = fillEditorLine(uiTheme, "", 1);
	const secondaryRail = secondaryRailColor
		? `${animatedRail(SECONDARY_RAIL_FRAMES, uiTheme, secondaryRailColor, "▐")}${ANSI_RESET}`
		: "";
	const mainRailFrames = secondaryRailColor ? SECONDARY_RAIL_FRAMES : FULL_RAIL_FRAMES;
	const mainRailGlyph = secondaryRailColor ? "▌" : "┃";
	const rail = `${secondaryRail}${animatedRail(mainRailFrames, uiTheme, railColor, mainRailGlyph)}${railGap}`;
	const [firstEditorLine = "", ...remainingEditorLines] = editorLines;
	// The prompt owns the full width; the status gets whatever the first row leaves over
	// (one column of gap), compacting itself and vanishing as the text grows into it.
	// The base editor pads every row to its full width, so measure typed content, not padding.
	const topRightWidth = Math.max(0, innerWidth - visibleWidth(trimTrailingBlanks(rawEditorLines[0] ?? "")) - 1);
	const chrome = editorChromeProvider?.(innerWidth, uiTheme, { modeReserve, topRightWidth }) ?? {};
	const lines = [
		composeLeftRight(firstEditorLine, chrome.topRight, innerWidth),
		...remainingEditorLines,
		composeLeftRight(
			headerLeftSegment(statusWidth, uiTheme, railColor, identityText, identityColor),
			chrome.bottomRight,
			statusWidth,
		),
	];

	return [
		renderEditorTransition(width, uiTheme, mode),
		...lines.map((line) => `${rail}${fillEditorLine(uiTheme, line, innerWidth)}`),
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
