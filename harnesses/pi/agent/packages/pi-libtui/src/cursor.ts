import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences } from "@earendil-works/pi-tui";
import { getTuiAppearance, type TuiCursorStyle } from "./appearance.ts";
import { tuiTheme } from "./color/theme.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Rendering options for a palette-owned virtual cursor cell. */
export interface VirtualCursorOptions {
	/** Use the warning cursor used while copy-mode has an active selection. */
	selected?: boolean;
	/** Preserve copy-mode's bold block cursor while sharing its palette policy. */
	mode?: "editor" | "copy";
}

/** Semantic purpose used to resolve a configured cursor policy. */
export type CursorRole = "insertion" | "navigation" | "selection";

/** Options shared by semantic cursor rendering and cursor markers. */
export interface SemanticCursorOptions {
	/** Semantic cursor whose configured style should be applied. */
	role: CursorRole;
}

/** Semantic editor cursor options with the theme required for virtual paint. */
export interface MarkEditorCursorOptions extends SemanticCursorOptions {
	/** Pi theme used to derive virtual cursor colors. */
	theme: Theme;
}

const CURSOR_ROLE_MARKERS: Record<CursorRole, string> = {
	insertion: "\x1b_pi-libtui:cursor:insertion\x07",
	navigation: "\x1b_pi-libtui:cursor:navigation\x07",
	selection: "\x1b_pi-libtui:cursor:selection\x07",
};

const CURSOR_ROLE_PATTERN = /\x1b_pi-libtui:cursor:(insertion|navigation|selection)\x07/gu;

/**
 * Resolves the configured cursor style for a semantic role.
 *
 * @param role Insertion, navigation, or selection purpose.
 * @returns The active virtual or native terminal cursor style for that role.
 */
export function cursorStyle(role: CursorRole): TuiCursorStyle {
	const appearance = getTuiAppearance();
	if (role === "insertion") return appearance.insertionCursor;
	if (role === "navigation") return appearance.navigationCursor;
	return appearance.selectionCursor;
}

/**
 * Tests whether a cursor style is rendered by the terminal rather than painted into text.
 *
 * @param style Cursor style to classify.
 * @returns `true` for terminal-default, block, underline, and bar styles.
 */
export function isNativeCursorStyle(style: TuiCursorStyle): boolean {
	return style !== "virtual";
}

/**
 * Finds the semantic role paired with Pi's active cursor position in the visible viewport.
 *
 * @param lines Rendered terminal rows, including private cursor markers.
 * @param height Number of bottom-most rows visible to the renderer.
 * @returns The active semantic role, or `undefined` when no valid paired marker exists.
 */
export function findCursorRole(lines: readonly string[], height: number): CursorRole | undefined {
	const top = Math.max(0, lines.length - height);
	for (let row = lines.length - 1; row >= top; row -= 1) {
		const line = lines[row] ?? "";
		const cursor = line.indexOf(CURSOR_MARKER);
		const roleMatch =
			cursor >= 0
				? CURSOR_ROLE_PATTERN.exec(line.slice(cursor + CURSOR_MARKER.length))
				: [...line.matchAll(CURSOR_ROLE_PATTERN)].at(-1);
		const role = cursor >= 0 && roleMatch?.index !== 0 ? undefined : roleMatch?.[1];
		CURSOR_ROLE_PATTERN.lastIndex = 0;
		if (cursor >= 0 && (role === "insertion" || role === "navigation" || role === "selection")) return role;
		// Virtual navigation and selection cursors deliberately omit Pi's marker.
		// Virtual insertion never does, so an unpaired insertion role is stale.
		if (cursor < 0 && (role === "navigation" || role === "selection")) return role;
		// Pi selects the first cursor marker on the bottom-most marked line. A
		// role elsewhere must not style that cursor.
		if (cursor >= 0) return undefined;
	}
	return undefined;
}

/**
 * Attaches a semantic role marker to an existing Pi cursor marker.
 *
 * @param line Rendered line that may contain Pi's cursor marker.
 * @param role Semantic role to attach.
 * @returns The marked line, or the original line when no marker exists or a role is already attached.
 */
export function markSemanticCursorPosition(line: string, role: CursorRole): string {
	const marker = line.indexOf(CURSOR_MARKER);
	if (marker < 0) return line;
	const after = marker + CURSOR_MARKER.length;
	CURSOR_ROLE_PATTERN.lastIndex = 0;
	const existing = CURSOR_ROLE_PATTERN.exec(line.slice(after));
	CURSOR_ROLE_PATTERN.lastIndex = 0;
	if (existing?.index === 0) return line;
	return `${line.slice(0, after)}${CURSOR_ROLE_MARKERS[role]}${line.slice(after)}`;
}

/**
 * Removes all private pi-libtui cursor-role markers from a rendered line.
 *
 * @param line Rendered terminal line.
 * @returns The line with semantic role metadata removed and other content preserved.
 */
export function stripCursorRoleMarkers(line: string): string {
	return line.replaceAll(CURSOR_ROLE_PATTERN, "");
}

/**
 * Removes Pi's one-grapheme fake editor cursor when an unfocused editor omits its hardware marker.
 *
 * @param line Rendered editor line.
 * @returns The cleaned line, or the original line when it contains a focused cursor or no exact fake-cursor form.
 */
export function removeUnmarkedEditorCursor(line: string): string {
	// A focused overlay editor owns this marked cursor. Its fake inverse
	// styling is intentionally preserved for Pi to position and render.
	if (line.includes(CURSOR_MARKER)) return line;
	// Native selection highlighting ends with INVERSE_OFF. Restrict this to
	// the editor's one-grapheme + RESET form so selected transcript text stays
	// untouched.
	const match = /\x1b\[7m([^\x1b]+)\x1b\[0m/u.exec(line);
	if (!match || [...graphemes.segment(stripTerminalSequences(match[1] ?? ""))].length !== 1) return line;
	const start = match.index ?? 0;
	return `${line.slice(0, start)}${match[1]}${line.slice(start + match[0].length)}`;
}

/**
 * Paints a visible one-cell cursor using pi-libtui semantic colors.
 *
 * @param theme Pi theme used to derive cursor foreground and background colors.
 * @param text Text occupying the cursor cell.
 * @param options Selection and editor/copy rendering policy.
 * @returns ANSI-styled cursor-cell text without semantic role metadata.
 */
export function renderVirtualCursor(theme: Theme, text: string, options: VirtualCursorOptions = {}): string {
	const colors = tuiTheme(theme);
	if (options.selected) {
		return `\x1b[1m${colors.fgAnsi("cursor.selectedText")}${colors.bgAnsi("cursor.selected")}${text}\x1b[0m`;
	}
	if (options.mode === "copy") {
		if (getTuiAppearance().softCursor) {
			return `\x1b[1m${colors.fgAnsi("text.primary")}${colors.bgAnsi("surface.cursor")}${text}\x1b[0m`;
		}
		return `\x1b[1m${colors.fgAnsi("cursor.idleText")}${colors.bgAnsi("cursor.idle")}${text}\x1b[0m`;
	}
	if (getTuiAppearance().softCursor) {
		return colors.bg("surface.cursor", colors.fg("text.primary", text));
	}
	return colors.bg("surface.base", colors.fg("text.primary", `\x1b[7m${text}\x1b[27m`));
}

/**
 * Renders one active semantic cursor and carries its role to the cursor bridge.
 *
 * @param theme Pi theme used when the resolved style is virtual.
 * @param text Text occupying the cursor cell; virtual rendering strips existing terminal styling.
 * @param options Semantic role whose configured policy should be applied.
 * @returns Virtual ANSI paint or native cursor-position metadata followed by the cell text.
 */
export function renderSemanticCursor(theme: Theme, text: string, options: SemanticCursorOptions): string {
	const style = cursorStyle(options.role);
	const marker = CURSOR_ROLE_MARKERS[options.role];
	if (isNativeCursorStyle(style)) return `${CURSOR_MARKER}${marker}${text}`;

	const plain = stripTerminalSequences(text);
	const cursor =
		options.role === "insertion"
			? renderVirtualCursor(theme, plain)
			: renderVirtualCursor(theme, plain, {
					mode: "copy",
					selected: options.role === "selection",
				});
	// Insertion cursors retain Pi's hidden marker for IME positioning. Copy-mode
	// virtual cursors have no text input and keep the hardware cursor absent.
	return `${options.role === "insertion" ? CURSOR_MARKER : ""}${marker}${cursor}`;
}

/**
 * Preserves and optionally restyles Pi's focused multiline editor cursor through compositing.
 *
 * @param line Rendered editor line containing Pi's inverse-video fake cursor.
 * @param renderCursor Custom cursor-cell renderer, semantic options, or `undefined` to preserve Pi's styling.
 * @returns The line with exactly one Pi cursor position and the requested cursor rendering.
 */
export function markEditorCursor(
	line: string,
	renderCursor?: ((text: string) => string) | MarkEditorCursorOptions,
): string {
	const marker = line.indexOf(CURSOR_MARKER);
	if (marker < 0 && renderCursor && typeof renderCursor !== "function") return removeUnmarkedEditorCursor(line);
	const start = marker >= 0 ? marker + CURSOR_MARKER.length : 0;
	const match = /\x1b\[7m([^\x1b]+)\x1b\[0m/u.exec(line.slice(start));
	if (!match || [...graphemes.segment(stripTerminalSequences(match[1] ?? ""))].length !== 1) return line;
	const cursorStart = start + (match.index ?? 0);
	const render =
		typeof renderCursor === "function"
			? renderCursor
			: renderCursor
				? (text: string) => renderSemanticCursor(renderCursor.theme, text, renderCursor)
				: undefined;
	const cursor = render ? render(stripTerminalSequences(match[1] ?? "")) : match[0];
	let before = line.slice(0, cursorStart);
	if (marker >= 0 && cursor.includes(CURSOR_MARKER)) before = before.replace(CURSOR_MARKER, "");
	return `${before}${marker >= 0 || cursor.includes(CURSOR_MARKER) ? "" : CURSOR_MARKER}${cursor}${line.slice(cursorStart + match[0].length)}`;
}

/**
 * Restyles Pi's focused single-line Input cursor, whose inverse span closes with SGR 27.
 *
 * @param line Rendered Input line containing Pi's cursor marker and inverse cursor cell.
 * @param options Theme and semantic role used to render the replacement cursor.
 * @returns The line with Pi's fake cursor replaced by the configured semantic cursor; unmarked fake cursors are removed.
 */
export function markInputCursor(line: string, options: MarkEditorCursorOptions): string {
	const marker = line.indexOf(CURSOR_MARKER);
	if (marker < 0) return removeUnmarkedInputCursor(line);
	const start = marker + CURSOR_MARKER.length;
	const match = /\x1b\[7m([^\x1b]+)\x1b\[27m/u.exec(line.slice(start));
	if (!match || [...graphemes.segment(stripTerminalSequences(match[1] ?? ""))].length !== 1) return line;
	const cursorStart = start + (match.index ?? 0);
	const cursor = renderSemanticCursor(options.theme, stripTerminalSequences(match[1] ?? ""), options);
	const before = line.slice(0, cursorStart).replace(CURSOR_MARKER, "");
	return `${before}${cursor}${line.slice(cursorStart + match[0].length)}`;
}

function removeUnmarkedInputCursor(line: string): string {
	if (line.includes(CURSOR_MARKER)) return line;
	const match = /\x1b\[7m([^\x1b]+)\x1b\[27m/u.exec(line);
	if (!match || [...graphemes.segment(stripTerminalSequences(match[1] ?? ""))].length !== 1) return line;
	const start = match.index ?? 0;
	return `${line.slice(0, start)}${match[1]}${line.slice(start + match[0].length)}`;
}
