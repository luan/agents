import { createRequire } from "node:module";

/** Backstop matching pi core `core/tools/truncate.ts`: 50 KB is ~12.5k tokens, above the p99 of observed reads. */
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
export const GREP_MAX_LINE_CHARS = 500;

export interface BoundOutputOptions {
	maxBytes?: number;
	maxLines?: number;
	maxLineChars?: number;
	fullOutputRef?: string;
}

export interface BoundedOutput {
	text: string;
	truncated: boolean;
	tokens: number;
	originalTokens: number;
}

// bytes/4 ran 41-49% low at p01 over 127,213 recorded results, so `read` shipped 8,823 real tokens against 6,000 and
// still said truncated. Vocab load is 127ms, paid by the first count, not pi's boot; 2.17 is the densest measured.
const TOKENIZER_MODULE = "gpt-tokenizer/model/gpt-4o";
const CONSERVATIVE_BYTES_PER_TOKEN = 2.17;

let countExact: ((text: string) => number) | undefined;

function exactCounter(): ((text: string) => number) | undefined {
	if (countExact) return countExact;
	try {
		const { countTokens } = createRequire(import.meta.url)(TOKENIZER_MODULE) as {
			countTokens: (t: string) => number;
		};
		countExact = countTokens;
	} catch {
		countExact = undefined;
	}
	return countExact;
}

// BPE cost is superlinear in a whitespace-free run: 2.3ms at 1KB, 16ms at 8KB, 256ms at 32KB, 10s for a 200KB line.
const EXACT_MAX_RUN_CHARS = 4096;

function longestUnbrokenRun(text: string): number {
	let longest = 0;
	let current = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 32 || code === 10 || code === 9 || code === 13) {
			current = 0;
			continue;
		}
		current++;
		if (current > longest) longest = current;
	}
	return longest;
}

export function approxTokenCount(text: string): number {
	if (!text) return 0;
	const exact = exactCounter();
	if (exact && longestUnbrokenRun(text) <= EXACT_MAX_RUN_CHARS) return exact(text);
	return Math.ceil(Buffer.byteLength(text, "utf8") / CONSERVATIVE_BYTES_PER_TOKEN);
}

export function bytesPerTokenOf(text: string): number {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes === 0) return 4;
	return bytes / Math.max(1, approxTokenCount(text));
}

export interface ImageDimensions {
	readonly width: number;
	readonly height: number;
}

const IMAGE_PATCH_PX = 32;

// OpenAI documents no multiplier for GPT-5.6 and no patch budget on its default `auto` detail, so 1.2 is fitted to live gpt-5.6-luna deltas.
const IMAGE_PATCH_MULTIPLIER = 1.2;

// 128 KB of base64 decodes to 96 KB, which clears a maximal 64 KB EXIF APP1 segment ahead of the JPEG SOF marker.
const IMAGE_HEADER_BASE64_CHARS = 128 * 1024;

// GIF and WebP headers are unread, so they take the 720x540 `PREVIEW_MAX_WIDTH_PX` cap in image-preview.ts:11.
const UNREADABLE_IMAGE_TOKENS = 469;

const JPEG_NON_SOF = new Set([0xc4, 0xc8, 0xcc]);

function readPngDimensions(head: Buffer): ImageDimensions | undefined {
	if (head.length < 24) return undefined;
	return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function readJpegDimensions(head: Buffer): ImageDimensions | undefined {
	let offset = 2;
	while (offset + 9 <= head.length) {
		if (head[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = head[offset + 1] ?? 0;
		if (marker === 0xff || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return undefined;
		if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NON_SOF.has(marker)) {
			return { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) };
		}
		const segmentLength = head.readUInt16BE(offset + 2);
		if (segmentLength < 2) return undefined;
		offset += 2 + segmentLength;
	}
	return undefined;
}

export function readImageDimensions(head: Buffer): ImageDimensions | undefined {
	if (head.length >= 4 && head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") {
		return readPngDimensions(head);
	}
	if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) {
		return readJpegDimensions(head);
	}
	return undefined;
}

export function imageTokensForDimensions(width: number, height: number): number {
	if (!(width > 0) || !(height > 0)) return UNREADABLE_IMAGE_TOKENS;
	const patches = Math.ceil(width / IMAGE_PATCH_PX) * Math.ceil(height / IMAGE_PATCH_PX);
	return Math.round(patches * IMAGE_PATCH_MULTIPLIER);
}

/** Keyed on dimensions from the header, because a JPEG and a PNG of one image occupy the same context. */
export function estimateImageTokens(base64Data: unknown): number {
	if (typeof base64Data !== "string") return UNREADABLE_IMAGE_TOKENS;
	const dimensions = readImageDimensions(Buffer.from(base64Data.slice(0, IMAGE_HEADER_BASE64_CHARS), "base64"));
	return dimensions ? imageTokensForDimensions(dimensions.width, dimensions.height) : UNREADABLE_IMAGE_TOKENS;
}

export function safeSliceByBytes(text: string, start: number, end?: number): string {
	const buffer = Buffer.from(text, "utf8");
	let safeStart = Math.min(buffer.length, Math.max(0, start));
	let safeEnd = Math.min(buffer.length, Math.max(safeStart, end ?? buffer.length));
	while (safeStart < buffer.length && (buffer[safeStart]! & 0xc0) === 0x80) safeStart += 1;
	while (safeEnd > safeStart && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd -= 1;
	return buffer.subarray(safeStart, safeEnd).toString("utf8");
}

export interface MiddleCapOptions {
	headShare?: number;
	notice?: (omittedBytes: number) => string;
}

export function capMiddleByBytes(text: string, maxBytes: number, options: MiddleCapOptions = {}): string {
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= maxBytes) return text;
	const headBytes = Math.max(0, Math.floor(maxBytes * (options.headShare ?? 0.5)));
	const tailBytes = Math.max(0, maxBytes - headBytes);
	const head = headBytes > 0 ? safeSliceByBytes(text.slice(0, headBytes), 0, headBytes) : "";
	const tailChars = tailBytes > 0 ? text.slice(-tailBytes) : "";
	const tail = tailBytes > 0 ? safeSliceByBytes(tailChars, Buffer.byteLength(tailChars, "utf8") - tailBytes) : "";
	const omittedBytes = totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
	return `${head}${options.notice?.(omittedBytes) ?? ""}${tail}`;
}

function capLineChars(line: string, maxChars: number): string {
	if (line.length <= maxChars) return line;
	const omitted = line.length - maxChars;
	return `${line.slice(0, maxChars)}…${omitted} chars elided…`;
}

/** Head-biased, for callers needing a parseable prefix; on 2026-08-10 head bias took continuations from 3% to 48%, so `truncateMiddleByTokens` in tool-bounding.ts is the default. */
export function boundOutput(text: string, options: BoundOutputOptions = {}): BoundedOutput {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxLineChars = options.maxLineChars;
	const originalTokens = approxTokenCount(text);

	const totalBytes = Buffer.byteLength(text, "utf8");
	let truncated = totalBytes > maxBytes;
	let output = truncated ? safeSliceByBytes(text.slice(0, maxBytes), 0, maxBytes) : text;

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

export type CostSeverity = "normal" | "elevated" | "high" | "severe";

export interface CostThresholds {
	elevated: number;
	high: number;
	severe: number;
}

// Percentiles over 119,597 tool results in 499 recorded sessions set p75 elevated, p90 high, p99 severe. The p99
// outgrew the budgets that landed after it, so severe fired on no bounded result. The most a `boundTextWithArtifact`
// result carries is 0.946 of its budget on the smallest row, so 0.9 is the highest fraction every row reaches.
const BUDGET_FRACTIONS = { elevated: 0.5, high: 0.7, severe: 0.9 } as const;

function thresholdsForBudget(budget: number): CostThresholds {
	return {
		elevated: Math.round(budget * BUDGET_FRACTIONS.elevated),
		high: Math.round(budget * BUDGET_FRACTIONS.high),
		severe: Math.round(budget * BUDGET_FRACTIONS.severe),
	};
}

/** Covers `read`, `exec`, `wait` and `skill` too: their budget is `DEFAULT_TOOL_TOKEN_BUDGET`. */
export const DEFAULT_THRESHOLDS: CostThresholds = thresholdsForBudget(6_000);

/** Mutations return a confirmation, so 50 tokens is already a diff worth seeing, well under the 1,000 budget. */
const MUTATION_THRESHOLDS: CostThresholds = { elevated: 50, high: 200, severe: 600 };

const TERMINAL_THRESHOLDS: CostThresholds = thresholdsForBudget(2_500);

/** Budgets are `TOOL_TOKEN_BUDGETS` in tool-bounding.ts, hardcoded because that file imports this one; 2,500 is the `exec_command` and `write_stdin` row. */
export const TOOL_THRESHOLDS: Record<string, CostThresholds> = {
	search: thresholdsForBudget(4_000),
	find: thresholdsForBudget(3_000),
	exec_command: TERMINAL_THRESHOLDS,
	write_stdin: TERMINAL_THRESHOLDS,
	edit: MUTATION_THRESHOLDS,
	write: MUTATION_THRESHOLDS,
	apply_patch: MUTATION_THRESHOLDS,
	ast_edit: MUTATION_THRESHOLDS,
};

export function tokenCostSeverity(tokens: number, toolName?: string): CostSeverity {
	const thresholds = (toolName ? TOOL_THRESHOLDS[toolName] : undefined) ?? DEFAULT_THRESHOLDS;
	if (tokens >= thresholds.severe) return "severe";
	if (tokens >= thresholds.high) return "high";
	if (tokens >= thresholds.elevated) return "elevated";
	return "normal";
}

/** Render a token count compactly: 940 to "940", 1240 to "1.2k", 10009 to "10k". */
export function formatTokenCount(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

export interface TokenCostLabel {
	text: string;
	severity: CostSeverity;
	tokens: number;
}

export function formatTokenCost(tokens: number, toolName?: string): TokenCostLabel {
	return { text: `${formatTokenCount(tokens)} tok`, severity: tokenCostSeverity(tokens, toolName), tokens };
}

export function formatTokenCostForText(text: string, toolName?: string): TokenCostLabel {
	return formatTokenCost(approxTokenCount(text), toolName);
}
