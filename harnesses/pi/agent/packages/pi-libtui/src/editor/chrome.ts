import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getTuiAppearance } from "../appearance.ts";
import { BackgroundSurface } from "../background-surface.ts";
import { type TuiBackgroundToken, tuiTheme } from "../color/theme.ts";
import { renderPill } from "../decoration/powerline-pill.ts";
import { animationSmoothnessCadenceMs, animationSpeedMultiplier, pulseGlyphFrame } from "../motion.ts";

export type EditorSurfaceStyle = "transparent" | "base" | "editor" | "raised" | "inset" | "accent";
export type EditorTopTreatment = "none" | "half-block" | "rule" | "status-band";
export type EditorBottomTreatment = "none" | "rule";
export type EditorRailStyle = "off" | "static" | "animated";
export type EditorPromptMarkerMotion = "static" | "working" | "always";
export type EditorStatusSeparator = "space" | "dot" | "chevron" | "powerline";
export type EditorStatusBandStyle = "transparent" | "filled" | "powerline";

export interface EditorCompositionStyle {
	readonly surface: EditorSurfaceStyle;
	readonly top: EditorTopTreatment;
	readonly bottom: EditorBottomTreatment;
	readonly leftRail: EditorRailStyle;
	readonly rightRail: EditorRailStyle;
	readonly promptMarker: readonly string[];
	readonly promptMarkerMotion: EditorPromptMarkerMotion;
	readonly bottomStatus: boolean;
	readonly statusSeparator: EditorStatusSeparator;
	readonly statusBand: EditorStatusBandStyle;
	readonly inactiveRailTone: "accent" | "border";
}

export interface EditorCompositionStatus {
	readonly left?: string;
	readonly right?: string;
}

export interface EditorCompositionRenderOptions {
	readonly width: number;
	readonly content: readonly string[];
	/** Segments rendered in the top-left and top-right regions. */
	readonly topStatus?: EditorCompositionStatus;
	readonly active?: boolean;
	readonly elapsedMs?: number;
}

export interface EditorCompositionPreview {
	readonly style: EditorCompositionStyle;
	readonly prompt?: string;
	readonly topStatus?: EditorCompositionStatus;
	readonly bottomStatus?: EditorCompositionStatus;
}

class Rows implements Component {
	constructor(private readonly lines: readonly string[]) {}
	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width, ""));
	}
	invalidate(): void {}
}

function surfaceToken(surface: EditorSurfaceStyle): TuiBackgroundToken | undefined {
	switch (surface) {
		case "transparent":
			return undefined;
		case "base":
			return "surface.base";
		case "editor":
			return "surface.editor";
		case "raised":
			return "surface.raised";
		case "inset":
			return "surface.inset";
		case "accent":
			return "surface.accent";
	}
}

function fit(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function editorContentUsedWidth(line: string): number {
	const trimmedWidth = visibleWidth(stripTerminalSequences(line).trimEnd());
	const cursor = line.indexOf(CURSOR_MARKER);
	const cursorWidth = cursor < 0 ? 0 : visibleWidth(line.slice(0, cursor)) + 1;
	return Math.max(trimmedWidth, cursorWidth);
}

function paintRows(theme: Theme, surface: EditorSurfaceStyle, width: number, lines: readonly string[]): string[] {
	const token = surfaceToken(surface);
	if (!token) return lines.map((line) => fit(line, width));
	return new BackgroundSurface({ theme, component: new Rows(lines), background: token }).render(width);
}

function rail(
	theme: Theme,
	style: EditorRailStyle,
	glyph: string,
	active: boolean,
	elapsedMs: number,
	inactiveTone: "accent" | "border",
): string {
	if (style === "off") return "";
	const colors = tuiTheme(theme);
	if (style !== "animated" || !active) return colors.fg(inactiveTone, glyph);
	const appearance = getTuiAppearance();
	return pulseGlyphFrame(colors, glyph, elapsedMs, {
		periodMs: 1_600 / animationSpeedMultiplier(appearance.animationSpeed),
		baseTone: "border",
		highlightTone: "accent",
		reducedMotion: false,
	});
}

function markerFrame(style: EditorCompositionStyle, active: boolean, elapsedMs: number): string {
	const frames = style.promptMarker;
	if (frames.length === 0) return "";
	const moving = style.promptMarkerMotion === "always" || (style.promptMarkerMotion === "working" && active);
	if (!moving || frames.length === 1) return frames[0] ?? "";
	const appearance = getTuiAppearance();
	const frameMs = Math.max(40, 180 / animationSpeedMultiplier(appearance.animationSpeed));
	return frames[Math.floor(elapsedMs / frameMs) % frames.length] ?? frames[0] ?? "";
}

/** Cells removed from Pi's native editor width by the selected chrome. */
export function editorCompositionContentWidth(style: EditorCompositionStyle, width: number): number {
	const left = style.leftRail === "off" ? 0 : 2;
	const right = style.rightRail === "off" ? 0 : 2;
	const marker = style.promptMarker.length === 0 ? 0 : Math.max(...style.promptMarker.map(visibleWidth)) + 1;
	return Math.max(1, Math.floor(width) - left - right - marker);
}

export function editorStatusSeparator(style: EditorStatusSeparator): string {
	switch (style) {
		case "space":
			return " ";
		case "dot":
			return " · ";
		case "chevron":
			return " > ";
		case "powerline":
			return "  ";
	}
}

export function composeEditorStatus(left: string, right: string, width: number): string {
	const safeWidth = Math.max(0, width);
	if (safeWidth === 0) return "";
	const fittedRight = truncateToWidth(right, safeWidth, "");
	if (!left) return `${" ".repeat(Math.max(0, safeWidth - visibleWidth(fittedRight)))}${fittedRight}`;
	if (!right) return truncateToWidth(left, safeWidth, "");
	if (visibleWidth(fittedRight) >= safeWidth) return fittedRight;
	const fittedLeft = truncateToWidth(left, Math.max(0, safeWidth - visibleWidth(fittedRight) - 1), "");
	const gap = Math.max(1, safeWidth - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
	return `${fittedLeft}${" ".repeat(gap)}${fittedRight}`;
}

function statusLine(
	theme: Theme,
	style: EditorCompositionStyle,
	status: EditorCompositionStatus,
	width: number,
): string {
	const left = status.left ?? "";
	const right = status.right ?? "";
	if (style.statusBand !== "powerline") return composeEditorStatus(left, right, width);
	const leftPill = left
		? renderPill(theme, { label: left, icon: false }, "surface.raised", "text.primary", "surface.base")
		: "";
	const rightPill = right
		? renderPill(theme, { label: right, icon: false }, "surface.raised", "text.primary", "surface.base")
		: "";
	return composeEditorStatus(leftPill, rightPill, width);
}

function ruleLine(theme: Theme, width: number, status?: string): string {
	const colors = tuiTheme(theme);
	if (!status) return colors.fg("border", "─".repeat(Math.max(0, width)));
	const clipped = truncateToWidth(status, Math.max(0, width - 4), "");
	const remaining = Math.max(0, width - visibleWidth(clipped) - 2);
	const left = Math.floor(remaining / 2);
	const right = remaining - left;
	return `${colors.fg("border", "─".repeat(left))} ${clipped} ${colors.fg("border", "─".repeat(right))}`;
}

/** Render generic editor chrome around already-rendered native input rows. */
export function renderEditorComposition(
	theme: Theme,
	style: EditorCompositionStyle,
	options: EditorCompositionRenderOptions,
): string[] {
	const width = Math.max(1, Math.floor(options.width));
	const active = options.active ?? false;
	const elapsedMs = options.elapsedMs ?? 0;
	const colors = tuiTheme(theme);
	const leftWidth = style.leftRail === "off" ? 0 : 2;
	const rightWidth = style.rightRail === "off" ? 0 : 2;
	const innerWidth = Math.max(1, width - leftWidth - rightWidth);
	const markerWidth = style.promptMarker.length === 0 ? 0 : Math.max(...style.promptMarker.map(visibleWidth)) + 1;
	const marker = markerFrame(style, active, elapsedMs);
	const topStatus = options.topStatus ?? {};
	const headerLeft = topStatus.left ?? "";
	const headerRight = topStatus.right ?? "";
	const header = headerLeft ? composeEditorStatus(headerLeft, headerRight, innerWidth) : headerRight;
	const headerWidth = visibleWidth(header);
	const firstContentUsedWidth = editorContentUsedWidth(options.content[0] ?? "");
	const inlineHeader =
		style.top === "half-block" &&
		headerLeft.length === 0 &&
		headerWidth > 0 &&
		markerWidth + firstContentUsedWidth + 2 + headerWidth <= innerWidth;
	const renderedTopStatus = statusLine(theme, style, topStatus, width);
	const topRuleStatus = statusLine(theme, style, topStatus, Math.max(1, width - 4));
	const leftRail = (glyph = "┃") =>
		style.leftRail === "off" ? "" : `${rail(theme, style.leftRail, glyph, active, elapsedMs, style.inactiveRailTone)} `;
	const rightRail = (glyph = "┃") =>
		style.rightRail === "off"
			? ""
			: ` ${rail(theme, style.rightRail, glyph, active, elapsedMs, style.inactiveRailTone)}`;
	const rows = options.content.map((line, index) => {
		const prefix =
			markerWidth === 0
				? ""
				: `${index === 0 ? colors.fg("accent", marker) : ""}${" ".repeat(Math.max(0, markerWidth - (index === 0 ? visibleWidth(marker) : 0)))}`;
		let content = `${prefix}${line}`;
		if (index === 0 && inlineHeader) {
			const usedWidth = markerWidth + firstContentUsedWidth;
			content = composeEditorStatus(truncateToWidth(content, usedWidth, ""), header, innerWidth);
		}
		return `${leftRail()}${fit(content, innerWidth)}${rightRail()}`;
	});
	const paintedRows = paintRows(theme, style.surface, width, rows);
	const result: string[] = [];
	if (style.top === "none" && renderedTopStatus) {
		result.push(
			...paintRows(theme, style.statusBand === "filled" ? "raised" : "transparent", width, [renderedTopStatus]),
		);
	}
	if (style.top === "half-block") {
		const token = surfaceToken(style.surface);
		const capCell = token ? colors.fg(colors.color(token), "▄") : " ";
		const liftedHeader = inlineHeader ? "" : truncateToWidth(header, Math.max(0, innerWidth - 1), "");
		const liftedHeaderWidth = visibleWidth(liftedHeader);
		const fillWidth = Math.max(0, innerWidth - liftedHeaderWidth - (liftedHeader ? 2 : 0));
		const fill = token
			? colors.fg(colors.color(token), `${"▄".repeat(fillWidth)}${liftedHeader ? "▟" : ""}`)
			: " ".repeat(fillWidth);
		const paintedHeader =
			token && liftedHeader ? colors.bg(token, ` ${liftedHeader}`) : liftedHeader ? ` ${liftedHeader}` : "";
		const leftCap =
			style.leftRail === "off"
				? ""
				: `${rail(theme, style.leftRail, "╻", active, elapsedMs, style.inactiveRailTone)}${capCell}`;
		const rightCap =
			style.rightRail === "off"
				? ""
				: `${liftedHeader && token ? colors.bg(token, " ") : capCell}${rail(
						theme,
						style.rightRail,
						liftedHeader ? "┃" : "╻",
						active,
						elapsedMs,
						style.inactiveRailTone,
					)}`;
		result.push(`${leftCap}${fit(`${fill}${paintedHeader}`, innerWidth)}${rightCap}`);
	} else if (style.top === "rule") {
		result.push(ruleLine(theme, width, topRuleStatus));
	} else if (style.top === "status-band" && renderedTopStatus) {
		result.push(
			...paintRows(theme, style.statusBand === "transparent" ? "transparent" : "raised", width, [renderedTopStatus]),
		);
	}
	result.push(...paintedRows);
	if (style.bottom === "rule") result.push(ruleLine(theme, width));
	return result;
}

/** Render a standalone status row for Pi's footer mount or an xsettings preview. */
export function renderEditorCompositionStatus(
	theme: Theme,
	style: EditorCompositionStyle,
	status: EditorCompositionStatus,
	width: number,
	options: Pick<EditorCompositionRenderOptions, "active" | "elapsedMs"> = {},
): string[] {
	if (!style.bottomStatus) return [];
	const safeWidth = Math.max(1, Math.floor(width));
	const leftWidth = style.leftRail === "off" ? 0 : 2;
	const rightWidth = style.rightRail === "off" ? 0 : 2;
	const innerWidth = Math.max(1, safeWidth - leftWidth - rightWidth);
	const line = statusLine(theme, style, status, innerWidth);
	if (!line) return [];
	const active = options.active ?? false;
	const elapsedMs = options.elapsedMs ?? 0;
	const leftRail =
		style.leftRail === "off" ? "" : `${rail(theme, style.leftRail, "┃", active, elapsedMs, style.inactiveRailTone)} `;
	const rightRail =
		style.rightRail === "off" ? "" : ` ${rail(theme, style.rightRail, "┃", active, elapsedMs, style.inactiveRailTone)}`;
	const row = `${leftRail}${fit(line, innerWidth)}${rightRail}`;
	return paintRows(theme, style.surface, safeWidth, [row]);
}

/** Production composition renderer used by xsettings for candidate previews. */
export function renderEditorCompositionPreview(
	theme: Theme,
	preview: EditorCompositionPreview,
	width: number,
	elapsedMs = 720,
): string[] {
	const style = preview.style;
	const prompt = preview.prompt ?? "Ask anything, edit files, run tools";
	const contentWidth = editorCompositionContentWidth(style, width);
	const input = [truncateToWidth(prompt, contentWidth, "…")];
	return [
		...renderEditorComposition(theme, style, {
			width,
			content: input,
			topStatus: preview.topStatus,
			active: true,
			elapsedMs,
		}),
		...renderEditorCompositionStatus(theme, style, preview.bottomStatus ?? {}, width, { active: true, elapsedMs }),
	];
}

/** Repaint cadence needed by always-moving prompt markers. */
export function editorCompositionCadenceMs(style: EditorCompositionStyle, active: boolean): number | undefined {
	const movingMarker =
		style.promptMarker.length > 1 &&
		(style.promptMarkerMotion === "always" || (style.promptMarkerMotion === "working" && active));
	const movingRail = active && (style.leftRail === "animated" || style.rightRail === "animated");
	if (!movingMarker && !movingRail) return undefined;
	const appearance = getTuiAppearance();
	return animationSmoothnessCadenceMs(appearance.animationSmoothness);
}
