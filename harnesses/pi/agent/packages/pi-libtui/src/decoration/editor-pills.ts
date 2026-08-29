import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type TuiForegroundColor, tuiTheme } from "../color/theme.ts";
import type { PillContent } from "./glyphs.ts";
import { backgroundAnsiAtColumn, contrastingPillBackground, renderPill } from "./powerline-pill.ts";

const PASTE_MARKER = String.raw`\[paste #\d+(?: [^\]\r\n]*)?\]`;
const RENDERED_PASTE_MARKER = new RegExp(`(?:\\x1b\\[7m(${PASTE_MARKER})\\x1b\\[0m)|(${PASTE_MARKER})`, "g");

export interface EditorTokenPresentation {
	readonly token: string;
	readonly label: string;
	readonly icon: PillContent["icon"];
	readonly iconTone?: TuiForegroundColor;
	/** Optional feature-owned renderer for stateful token presentation. */
	readonly render?: (context: EditorTokenPillRenderContext) => string;
}

export interface EditorTokenPillRenderContext {
	readonly theme: Theme;
	readonly content: PillContent;
	readonly destinationBackgroundAnsi: string;
	readonly inverse: boolean;
}

export interface EditorTokenPillGeometry {
	line: number;
	x: number;
	width: number;
	token: string;
}

export interface EditorTokenPillResult {
	lines: string[];
	pills: readonly EditorTokenPillGeometry[];
}

const NO_PILLS: readonly EditorTokenPillGeometry[] = [];

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Render atomic editor tokens as destination-aware pills without changing editor text or cursor state. */
export function renderEditorTokenPills(
	lines: readonly string[],
	width: number,
	theme: Theme,
	tokens: readonly EditorTokenPresentation[],
): EditorTokenPillResult {
	const present = tokens.filter(
		(presentation) => presentation.token && lines.some((line) => line.includes(presentation.token)),
	);
	if (present.length === 0) return { lines: [...lines], pills: NO_PILLS };
	const boundedWidth = Math.max(0, Math.floor(width));
	const pills: EditorTokenPillGeometry[] = [];
	let rendered = [...lines];
	for (const presentation of present) {
		const escaped = escapeRegExp(presentation.token);
		const pattern = new RegExp(`(?:\\x1b\\[7m(${escaped})\\x1b\\[0m)|(${escaped})`, "gu");
		rendered = rendered.map((line, lineIndex) =>
			replaceMatches(
				line,
				pattern,
				boundedWidth,
				theme,
				presentation.label,
				presentation.icon,
				presentation.iconTone,
				presentation.render,
				presentation.token,
				lineIndex,
				pills,
			),
		);
	}
	return { lines: rendered.map((line) => padLine(line, boundedWidth)), pills };
}

/** Render Pi's native multiline-paste markers with the same editor-token contract. */
export function renderEditorPasteMarkerPills(
	lines: readonly string[],
	width: number,
	theme: Theme,
): EditorTokenPillResult {
	if (!lines.some((line) => line.includes("[paste #"))) return { lines: [...lines], pills: NO_PILLS };
	const boundedWidth = Math.max(0, Math.floor(width));
	const pills: EditorTokenPillGeometry[] = [];
	const rendered = lines.map((line, lineIndex) =>
		replaceMatches(
			line,
			RENDERED_PASTE_MARKER,
			boundedWidth,
			theme,
			undefined,
			"paste",
			"info",
			undefined,
			undefined,
			lineIndex,
			pills,
		),
	);
	return { lines: rendered.map((line) => padLine(line, boundedWidth)), pills };
}

function replaceMatches(
	line: string,
	pattern: RegExp,
	width: number,
	theme: Theme,
	label: string | undefined,
	icon: PillContent["icon"],
	iconTone: TuiForegroundColor | undefined,
	render: EditorTokenPresentation["render"],
	token: string | undefined,
	lineIndex: number,
	pills: EditorTokenPillGeometry[],
): string {
	let addedWidth = 0;
	return line.replace(
		pattern,
		(match, inverseValue: string | undefined, plainValue: string | undefined, offset: number) => {
			const value = inverseValue ?? plainValue;
			if (!value) return match;
			const originalX = visibleWidth(line.slice(0, offset));
			const x = originalX + addedWidth;
			const destination = backgroundAnsiAtColumn(line, originalX);
			const pillLabel = label ?? value.slice(1, -1);
			const content = { icon, iconTone, label: pillLabel } satisfies PillContent;
			let pill: string;
			if (render) {
				pill = render({
					theme,
					content,
					destinationBackgroundAnsi: destination,
					inverse: inverseValue !== undefined,
				});
			} else {
				const colors = tuiTheme(theme);
				const contrast = contrastingPillBackground(theme, destination);
				const background = colors.mixForeground(colors.contrastBackground(contrast), contrast, 0.2);
				pill = renderPill(theme, content, background, "text.primary", undefined, destination);
			}
			const pillWidth = visibleWidth(pill);
			if (x < width) pills.push({ line: lineIndex, x, width: Math.min(pillWidth, width - x), token: token ?? value });
			addedWidth += pillWidth - visibleWidth(value);
			return pill;
		},
	);
}

function padLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
