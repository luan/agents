/**
 * Shared output budgeting for tools that can emit unbounded text.
 *
 * Two responsibilities, deliberately together because they share the same
 * notion of "how big is this":
 *
 *   1. `boundOutput` — cap what reaches the model, at the point the cost is
 *      created, rather than at delivery. Tools opt in by calling it.
 *   2. `formatTokenCost` — report what a tool actually spent so the cost is
 *      visible in the card instead of only in the transcript.
 *
 * Nothing here imports from a specific extension: this module is the shared
 * contract, so the dependency arrow points at it and never out of it.
 */

// =============================================================================
// Budget constants
// =============================================================================

/**
 * Ceilings on text handed to the model from a single tool call.
 *
 * These are pi core's own numbers, from `core/tools/truncate.ts`, matched
 * deliberately: an override that caps differently from the tool it overrides
 * makes the limit unpredictable from the model's side for no gain.
 *
 * Note what they are — a backstop, not a budget. 50 KB is roughly 12.5k
 * tokens, which is above the 99th percentile of observed reads, so this fires
 * on catastrophes rather than on expensive-but-normal calls. Keeping ordinary
 * calls cheap is the job of the views themselves.
 */
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
/**
 * Per-line character ceiling for LINE-ORIENTED output, where one minified line
 * must not drain the budget.
 *
 * Deliberately not a default: applied to a document or a structured payload it
 * mutilates legitimate content — a long prose field is not noise, and chopping
 * it makes the caller fetch the same data again, costing more than it saved.
 * Callers whose output is one-match-per-line opt in explicitly.
 */
export const GREP_MAX_LINE_CHARS = 500;

export interface BoundOutputOptions {
	maxBytes?: number;
	maxLines?: number;
	/** Omit to leave long lines intact. See {@link GREP_MAX_LINE_CHARS}. */
	maxLineChars?: number;
	/**
	 * Reference to the full, unbounded output (e.g. `artifact://<id>`). When
	 * set it is named in the truncation notice so the omitted text stays
	 * reachable instead of being silently lost.
	 */
	fullOutputRef?: string;
}

export interface BoundedOutput {
	text: string;
	truncated: boolean;
	/** Token estimate of the returned text. */
	tokens: number;
	/** Token estimate of the input, before any capping. */
	originalTokens: number;
}

/** Estimate tokens the same way the rest of the codebase does: bytes / 4. */
export function approxTokenCount(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/** Slice by byte offsets without splitting a UTF-8 sequence. */
function safeSliceByBytes(text: string, start: number, end?: number): string {
	const buffer = Buffer.from(text, "utf8");
	let safeStart = Math.min(buffer.length, Math.max(0, start));
	let safeEnd = Math.min(buffer.length, Math.max(safeStart, end ?? buffer.length));
	while (safeStart < buffer.length && (buffer[safeStart]! & 0xc0) === 0x80) safeStart += 1;
	while (safeEnd > safeStart && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd -= 1;
	return buffer.subarray(safeStart, safeEnd).toString("utf8");
}

function capLineChars(line: string, maxChars: number): string {
	if (line.length <= maxChars) return line;
	const omitted = line.length - maxChars;
	return `${line.slice(0, maxChars)}…${omitted} chars elided…`;
}

/**
 * Cap `text` to a budget, head-biased.
 *
 * Head-biased rather than middle-truncated: the head of a tool result carries
 * the structure a reader needs to decide what to do next, and a middle cut
 * through structured output yields something that no longer parses.
 */
export function boundOutput(text: string, options: BoundOutputOptions = {}): BoundedOutput {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxLineChars = options.maxLineChars;
	const originalTokens = approxTokenCount(text);

	// Byte-slice BEFORE splitting into lines. Splitting first would allocate an
	// array proportional to the input rather than to the budget, so one huge
	// payload could exhaust the heap on the very path meant to prevent that.
	const totalBytes = Buffer.byteLength(text, "utf8");
	let truncated = totalBytes > maxBytes;
	// Narrow by characters before touching Buffer: every UTF-8 character is at
	// least one byte, so the first `maxBytes` characters always contain the
	// first `maxBytes` bytes. Without this, `safeSliceByBytes` would allocate a
	// Buffer the size of the whole input to keep a small prefix.
	let output = truncated ? safeSliceByBytes(text.slice(0, maxBytes), 0, maxBytes) : text;

	// Cheap pre-check: only pay for line work when a line bound can actually bite.
	const needsLineWork = maxLineChars !== undefined || output.length > maxLines;
	if (needsLineWork) {
		let lines = output.split("\n");
		if (lines.length > maxLines) {
			lines = lines.slice(0, maxLines);
			truncated = true;
		}
		if (maxLineChars !== undefined) {
			lines = lines.map((line) => {
				const capped = capLineChars(line, maxLineChars);
				if (capped !== line) truncated = true;
				return capped;
			});
		}
		output = lines.join("\n");
	}

	if (!truncated) return { text, truncated: false, tokens: originalTokens, originalTokens };

	const omitted = Math.max(0, originalTokens - approxTokenCount(output));
	const pointer = options.fullOutputRef ? ` Full output: ${options.fullOutputRef}` : "";
	const notice = `\n[output bounded — ~${omitted} tokens omitted of ~${originalTokens}.${pointer}]`;
	const withNotice = `${output}${notice}`;
	return { text: withNotice, truncated: true, tokens: approxTokenCount(withNotice), originalTokens };
}

// =============================================================================
// Cost reporting
// =============================================================================

export type CostSeverity = "normal" | "elevated" | "high" | "severe";

interface CostThresholds {
	/** At or above this, the cost is elevated (~p75 of observed results). */
	elevated: number;
	/** At or above this, the cost is high (~p90). */
	high: number;
	/** At or above this, the cost is severe (~p99). */
	severe: number;
}

/**
 * Thresholds are hardcoded rather than learned at runtime.
 *
 * The numbers come from percentiles measured over 119,597 tool results across
 * 499 recorded sessions. They are a calibration, not a law — capping work
 * lowers the very distributions they were drawn from, so re-derive them from a
 * fresh sweep when they stop feeling right rather than trusting them forever.
 */
const DEFAULT_THRESHOLDS: CostThresholds = { elevated: 700, high: 1_800, severe: 9_000 };

const TOOL_THRESHOLDS: Record<string, CostThresholds> = {
	read: { elevated: 1_500, high: 2_600, severe: 7_000 },
	// Recalibrated for the post-cap world: a full page of `search` is ~2.4k and a
	// full page of `find` ~2.9k, so the pre-cap percentiles painted the ordinary
	// case orange. These flag approaching the budget, not merely using it.
	search: { elevated: 3_000, high: 5_000, severe: 9_000 },
	find: { elevated: 3_000, high: 5_000, severe: 9_000 },
	skill: { elevated: 1_600, high: 2_100, severe: 6_000 },
	write_stdin: { elevated: 200, high: 700, severe: 9_900 },
	// Mutations return almost nothing; anything sizeable is worth noticing.
	edit: { elevated: 50, high: 200, severe: 600 },
	write: { elevated: 50, high: 200, severe: 600 },
	apply_patch: { elevated: 50, high: 200, severe: 600 },
	ast_edit: { elevated: 50, high: 200, severe: 600 },
};

export function tokenCostSeverity(tokens: number, toolName?: string): CostSeverity {
	const thresholds = (toolName ? TOOL_THRESHOLDS[toolName] : undefined) ?? DEFAULT_THRESHOLDS;
	if (tokens >= thresholds.severe) return "severe";
	if (tokens >= thresholds.high) return "high";
	if (tokens >= thresholds.elevated) return "elevated";
	return "normal";
}

/** Render a token count compactly: 940 → "940", 1240 → "1.2k", 10009 → "10k". */
export function formatTokenCount(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

export interface TokenCostLabel {
	/** Ready to append to a card line, e.g. "1.2k tok". */
	text: string;
	severity: CostSeverity;
	tokens: number;
}

/**
 * Build the cost label for a tool card.
 *
 * Callers map `severity` to their own palette: `normal` keeps the existing
 * subdued colour, and elevated/high/severe escalate from there.
 */
export function formatTokenCost(tokens: number, toolName?: string): TokenCostLabel {
	return { text: `${formatTokenCount(tokens)} tok`, severity: tokenCostSeverity(tokens, toolName), tokens };
}

/** Convenience for callers holding the raw result text rather than a count. */
export function formatTokenCostForText(text: string, toolName?: string): TokenCostLabel {
	return formatTokenCost(approxTokenCount(text), toolName);
}
