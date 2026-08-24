import { randomBytes } from "node:crypto";

const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

export interface OutputState {
	/** Session transport state; this is intentionally separate from pi-libtui's visible ToolOutput retention. */
	bufferChunks: string[];
	bufferFirstChunk: number;
	bufferLength: number;
	bufferStartOffset: number;
	emittedOffset: number;
}

export function normalizeOutput(text: string): string {
	return stripControls(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Incrementally strips terminal controls that may be split across bridge chunks. */
export class OutputNormalizer {
	private pending = "";
	private pendingCarriageReturn = false;

	write(chunk: string): string {
		const source = this.pending + chunk;
		const incomplete = incompleteControlStart(source);
		let complete: string;
		if (incomplete === undefined) {
			this.pending = "";
			complete = source;
		} else {
			this.pending = source.slice(incomplete, incomplete + 4_096);
			complete = source.slice(0, incomplete);
		}
		let plain = stripControls(complete);
		let output = "";
		if (this.pendingCarriageReturn && plain.length > 0) {
			output = "\n";
			if (plain.startsWith("\n")) plain = plain.slice(1);
			this.pendingCarriageReturn = false;
		}
		if (plain.endsWith("\r")) {
			plain = plain.slice(0, -1);
			this.pendingCarriageReturn = true;
		}
		return output + plain.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	}

	end(chunk = ""): string {
		let output = this.write(chunk);
		if (this.pendingCarriageReturn) output += "\n";
		this.pending = "";
		this.pendingCarriageReturn = false;
		return output;
	}
}

function stripControls(text: string): string {
	let output = "";
	let plainStart = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code !== 0x1b && (code < 0x80 || code > 0x9f)) continue;
		output += text.slice(plainStart, index);
		const end = controlEnd(text, index);
		if (end === undefined) return output;
		index = end - 1;
		plainStart = end;
	}
	return output + text.slice(plainStart);
}

function incompleteControlStart(text: string): number | undefined {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code !== 0x1b && (code < 0x80 || code > 0x9f)) continue;
		const end = controlEnd(text, index);
		if (end === undefined) return index;
		index = end - 1;
	}
	return undefined;
}

function controlEnd(text: string, start: number): number | undefined {
	const code = text.charCodeAt(start);
	const csi = code === 0x9b ? start + 1 : text[start + 1] === "[" ? start + 2 : -1;
	if (csi >= 0) {
		for (let index = csi; index < text.length; index += 1) {
			const current = text.charCodeAt(index);
			if (current >= 0x40 && current <= 0x7e) return index + 1;
		}
		return undefined;
	}
	const introducer = code === 0x1b ? text[start + 1] : String.fromCharCode(code);
	if (introducer === undefined) return undefined;
	const stringControl = introducer === "]" || code === 0x9d;
	if (
		stringControl ||
		introducer === "P" ||
		introducer === "^" ||
		introducer === "_" ||
		[0x90, 0x98, 0x9e, 0x9f].includes(code)
	) {
		const payload = code === 0x1b ? start + 2 : start + 1;
		for (let index = payload; index < text.length; index += 1) {
			if (stringControl && text.charCodeAt(index) === 0x07) return index + 1;
			if (text.charCodeAt(index) === 0x9c) return index + 1;
			if (text.charCodeAt(index) === 0x1b && text[index + 1] === "\\") return index + 2;
		}
		return undefined;
	}
	return Math.min(text.length, start + (code === 0x1b ? 2 : 1));
}

export function appendBounded(state: OutputState, text: string, maxChars: number): void {
	if (!text) return;
	const last = state.bufferChunks.at(-1);
	if (last !== undefined && last.length + text.length <= 4_096)
		state.bufferChunks[state.bufferChunks.length - 1] = last + text;
	else state.bufferChunks.push(text);
	state.bufferLength += text.length;
	let excess = state.bufferLength - maxChars;
	while (excess > 0 && state.bufferFirstChunk < state.bufferChunks.length) {
		const first = state.bufferChunks[state.bufferFirstChunk]!;
		if (first.length <= excess) {
			state.bufferFirstChunk += 1;
			state.bufferLength -= first.length;
			state.bufferStartOffset += first.length;
			excess -= first.length;
			continue;
		}
		let removed = excess;
		if (/^[\uDC00-\uDFFF]$/.test(first[removed] ?? "")) removed += 1;
		state.bufferChunks[state.bufferFirstChunk] = first.slice(removed);
		state.bufferLength -= removed;
		state.bufferStartOffset += removed;
		excess = 0;
	}
	if (state.bufferFirstChunk >= 1_024 && state.bufferFirstChunk * 2 >= state.bufferChunks.length) {
		state.bufferChunks = state.bufferChunks.slice(state.bufferFirstChunk);
		state.bufferFirstChunk = 0;
	}
}

export function outputEnd(state: OutputState): number {
	return state.bufferStartOffset + state.bufferLength;
}

export function outputTail(state: OutputState, maxCharacters: number): string {
	return sliceOutput(state, Math.max(state.bufferStartOffset, outputEnd(state) - maxCharacters), outputEnd(state));
}

export function takeOutput(
	state: OutputState,
	maxOutputTokens?: number,
): {
	output: string;
	original_token_count?: number;
	output_truncated: boolean;
} {
	const end = outputEnd(state);
	const start = Math.max(state.emittedOffset, state.bufferStartOffset);
	const originalChars = Math.max(0, end - state.emittedOffset);
	state.emittedOffset = end;
	return outputWindow(state, start, end, maxOutputTokens, originalChars);
}

export function peekOutput(
	state: OutputState,
	baseline: number,
	maxOutputTokens?: number,
): {
	output: string;
	original_token_count?: number;
	output_truncated: boolean;
} {
	const end = outputEnd(state);
	const start = Math.max(baseline, state.bufferStartOffset);
	return outputWindow(state, start, end, maxOutputTokens, Math.max(0, end - baseline));
}

function outputWindow(
	state: OutputState,
	start: number,
	end: number,
	maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
	originalChars: number,
): { output: string; original_token_count?: number; output_truncated: boolean } {
	const maxChars = Math.max(256, maxOutputTokens * 4);
	const visibleStart = Math.max(start, end - maxChars);
	const output = sliceOutput(state, visibleStart, end);
	return {
		output,
		original_token_count: Math.ceil(originalChars / 4),
		output_truncated: visibleStart > start || originalChars > end - start,
	};
}

function sliceOutput(state: OutputState, start: number, end: number): string {
	if (start >= end) return "";
	let offset = state.bufferStartOffset;
	const chunks: string[] = [];
	for (let index = state.bufferFirstChunk; index < state.bufferChunks.length && offset < end; index += 1) {
		const chunk = state.bufferChunks[index]!;
		const chunkEnd = offset + chunk.length;
		if (chunkEnd > start) chunks.push(chunk.slice(Math.max(0, start - offset), Math.min(chunk.length, end - offset)));
		offset = chunkEnd;
	}
	const output = chunks.join("");
	return isLowSurrogate(output.charCodeAt(0)) ? output.slice(1) : output;
}

export function truncateOutput(
	text: string,
	maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
	originalChars = text.length,
): {
	output: string;
	original_token_count?: number;
	output_truncated: boolean;
} {
	const maxChars = Math.max(256, maxOutputTokens * 4);
	const originalTokenCount = Math.ceil(Math.max(text.length, originalChars) / 4);
	if (text.length <= maxChars) {
		return {
			output: text,
			original_token_count: originalTokenCount,
			output_truncated: originalChars > text.length,
		};
	}
	return {
		output: text.slice(adjustWindowStart(text, text.length - maxChars)),
		original_token_count: originalTokenCount,
		output_truncated: true,
	};
}

function adjustWindowStart(text: string, start: number): number {
	return isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

export function chunkId(): string {
	return randomBytes(3).toString("hex");
}
