import { CAPTURE_MAX_BYTES } from "../../artifact-store/pi/capture.ts";
import { capMiddleByBytes, safeSliceByBytes } from "../../shared/output-budget.ts";
import { HARD_MAX_TOOL_TOKENS, resolveToolBudget } from "../../shared/tool-bounding.ts";

/**
 * The default and the ceiling both come from the shared table.
 *
 * Truncating here and again in the central `tool_result` bound means the
 * smaller of the two numbers is the one the model ever sees. Owning a second
 * default here would make the schema's "defaults to N" false for every call
 * that does not pass `max_output_tokens` — which is most of them.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = resolveToolBudget("exec_command");
export const MAX_OUTPUT_TOKENS_CEILING = HARD_MAX_TOOL_TOKENS;
const DEFAULT_MAX_OUTPUT_LINE_CHARS = 400;
export const UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;

export function resolveMaxOutputTokens(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_OUTPUT_TOKENS;
	return Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.max(1, Math.floor(requested)));
}

export function appendCaptureOutput(current: string, appended: string): { output: string; truncated: boolean } {
	const currentBytes = Buffer.byteLength(current, "utf8");
	if (currentBytes >= CAPTURE_MAX_BYTES) return { output: current, truncated: true };
	const remaining = CAPTURE_MAX_BYTES - currentBytes;
	const appendedBytes = Buffer.byteLength(appended, "utf8");
	if (appendedBytes <= remaining) return { output: `${current}${appended}`, truncated: false };
	return { output: `${current}${safeSliceByBytes(appended, 0, remaining)}`, truncated: true };
}

function lineCount(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

function truncateLineMiddle(line: string, maxChars: number): string {
	if (line.length <= maxChars) return line;
	let marker = `…${line.length - maxChars} chars truncated…`;
	marker = `…${line.length - Math.max(0, maxChars - marker.length)} chars truncated…`;
	const budget = Math.max(0, maxChars - marker.length);
	const headBudget = Math.ceil(budget / 2);
	const tailBudget = Math.floor(budget / 2);
	return `${line.slice(0, headBudget)}${marker}${line.slice(line.length - tailBudget)}`;
}

function truncateLongLines(
	text: string,
	maxChars = DEFAULT_MAX_OUTPUT_LINE_CHARS,
): { output: string; output_truncated?: boolean } {
	let changed = false;
	const output = text
		.split("\n")
		.map((line) => {
			const truncated = truncateLineMiddle(line, maxChars);
			if (truncated !== line) changed = true;
			return truncated;
		})
		.join("\n");
	return changed ? { output, output_truncated: true } : { output };
}

/** True when `maxTokens` will force `formattedTruncateText` to drop a middle, which is the only loss it cannot mark in place. */
export function willElideMiddle(text: string, maxTokens: number): boolean {
	return (
		text.split("\n").some((line) => line.length > DEFAULT_MAX_OUTPUT_LINE_CHARS) ||
		Buffer.byteLength(text, "utf8") > maxTokens * 4
	);
}

/**
 * The elision marker names where the dropped bytes went.
 *
 * `…N tokens truncated…` alone described a loss the caller could not undo: `consumeOutput` empties `pendingBuffer` in
 * the same call, so a later drain returns the bytes that arrived next, never the middle this one cut.
 */
export function formattedTruncateText(
	text: string,
	maxTokens = DEFAULT_MAX_OUTPUT_TOKENS,
	fullOutputRef?: string,
): { output: string; output_truncated?: boolean; elided_bytes?: number } {
	const limitedLines = truncateLongLines(text);
	const output = limitedLines.output;
	if (!limitedLines.output_truncated && Buffer.byteLength(output, "utf8") <= maxTokens * 4) {
		return { output };
	}
	let elidedBytes = 0;
	const truncated = capMiddleByBytes(output, maxTokens * 4, {
		notice: (omittedBytes) => {
			elidedBytes = omittedBytes;
			const where = fullOutputRef ? `, kept in ${fullOutputRef}` : "";
			return `…${Math.ceil(omittedBytes / 4)} tokens elided${where}…`;
		},
	});
	return {
		output: `Total output lines: ${lineCount(text)}\n\n${truncateLongLines(truncated).output}`,
		output_truncated: true,
		elided_bytes: elidedBytes,
	};
}
