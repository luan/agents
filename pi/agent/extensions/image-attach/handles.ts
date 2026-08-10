import { runningFrame } from "../shared/tui";

/** The handle a clipboard paste leaves in the editor in place of its temp path. */
export const IMAGE_HANDLE = /\[image #(\d+)\]/g;

/**
 * Placeholder sitting where the handle will land while the clipboard is still being read. The
 * spinner replaces `…` at render time, and both are one cell wide, so the editor's own width
 * and wrap maths never see the substitution.
 */
export const PENDING_HANDLE = "[image …]";
const PENDING_HANDLE_RE = /\[image …\]/g;

/** Magenta, to stand apart from skillful's cyan skill references. */
const HANDLE_COLOR = "\x1b[35m";
const DEFAULT_FOREGROUND = "\x1b[39m";

/** Either handle shape, for the span maths that makes them atomic. */
const HANDLE_SPAN = /\[image (?:#\d+|…)\]/g;

/** Handle number → the row of coloured cells standing in for `image `. */
const thumbnails = new Map<number, string>();

let pendingSince: number | undefined;

export function setHandleThumbnail(index: number, cells: string | undefined): void {
	if (cells) thumbnails.set(index, cells);
}
export function clearHandleThumbnails(): void {
	thumbnails.clear();
}
export function clearHandleThumbnail(index: number): void {
	thumbnails.delete(index);
}

/** Where each handle starts and ends in `text`. */
export function handleSpans(text: string): Array<{ start: number; end: number }> {
	if (!text.includes("[image ")) return [];
	return [...text.matchAll(HANDLE_SPAN)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
}

export function formatHandle(index: number): string {
	return `[image #${index}]`;
}

export function beginPendingHandle(): void {
	pendingSince = Date.now();
}

export function endPendingHandle(): void {
	pendingSince = undefined;
}

/** Milliseconds the current capture has been running, or undefined when nothing is pending. */
function pendingElapsedMs(): number | undefined {
	return pendingSince === undefined ? undefined : Date.now() - pendingSince;
}

/**
 * Tint handles in one rendered editor line, animate a pending one, and swap `image ` for the
 * thumbnail once there is one. Only the handle is wrapped, and it restores the default
 * foreground — a line another layer already colored keeps its color up to the handle.
 *
 * Every substitution is width-neutral: `image ` is six cells and so is the thumbnail, and the
 * spinner frame is one cell like the `…` it replaces. The editor lays out the untinted buffer, so
 * a change in visible width here would put the cursor a cell off from where it draws.
 */
export function colorizeHandles(line: string, elapsedMs = pendingElapsedMs()): string {
	if (!line.includes("[image ")) return line;
	return line
		.replace(PENDING_HANDLE_RE, `${HANDLE_COLOR}[image ${runningFrame(elapsedMs)}]${DEFAULT_FOREGROUND}`)
		.replace(IMAGE_HANDLE, (handle, index: string) => {
			const thumbnail = thumbnails.get(Number(index));
			const body = thumbnail ? `[${thumbnail}${HANDLE_COLOR}#${index}]` : handle;
			return `${HANDLE_COLOR}${body}${DEFAULT_FOREGROUND}`;
		});
}
