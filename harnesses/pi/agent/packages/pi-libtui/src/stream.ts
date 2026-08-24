import { terminalSequenceEnd, terminalSequenceStart } from "./content/terminal-text.ts";

const ANSI_RESET = "\x1b[0m";

/** Snapshot of a bounded append-only stream. */
export interface BoundedStreamSnapshot {
	/** Display-safe retained output, including an omission marker when bounded. */
	readonly text: string;
	/** Stable prefix retained from the beginning of the stream. */
	readonly head: string;
	/** Recent suffix retained from the end of the stream. */
	readonly tail: string;
	/** The current unterminated line, independently bounded to the stream budget. */
	readonly partialLine: string;
	readonly truncated: boolean;
	readonly omittedBytes: number;
	readonly totalBytes: number;
	readonly lineCount: number;
	/** True after `replaceFinal` supplied the authoritative value. */
	readonly authoritative: boolean;
}

export interface BoundedStreamOptions {
	/** Maximum source bytes retained between the head and tail. */
	readonly maxBytes: number;
	/** Fraction of retained bytes reserved for the stable head. Defaults to one half. */
	readonly headShare?: number;
	/** Builds the marker inserted between a truncated head and tail. */
	readonly omissionMarker?: (omittedBytes: number) => string;
}

const DEFAULT_MARKER = (omittedBytes: number): string => `\n… ${omittedBytes} bytes omitted …\n`;
const TAIL_ROLL_BYTES = 256 * 1_024;
const MAX_ANSI_PARSER_CHARACTERS = 4_096;

interface AnsiPending {
	parser: string;
	characters: number;
	bytes: number;
}

/**
 * Incrementally retains the useful edges of a text stream without retaining
 * its unbounded middle. Appends cost O(chunk + configured budget), independent
 * of the total stream size.
 */
export class BoundedStreamBuffer {
	private readonly maxBytes: number;
	private readonly headBytes: number;
	private readonly tailBytes: number;
	private readonly omissionMarker: (omittedBytes: number) => string;
	private exactValue = "";
	private exactBytes = 0;
	private truncated = false;
	private headValue = "";
	private tailValue = "";
	private tailPending = "";
	private tailPendingBytes = 0;
	private tailStart = 0;
	private tailValueBytes = 0;
	private tailAnsiPending: AnsiPending = { parser: "", characters: 0, bytes: 0 };
	private partialValue = "";
	private partialPending = "";
	private partialPendingBytes = 0;
	private partialStart = 0;
	private partialBytes = 0;
	private partialHasAnsi = false;
	private partialAnsiPending: AnsiPending = { parser: "", characters: 0, bytes: 0 };
	private bytes = 0;
	private newlines = 0;
	private endsWithNewline = false;
	private hasAnsi = false;
	private isAuthoritative = false;
	private pendingHighSurrogate = "";
	private byteDecoder = new TextDecoder();

	constructor(options: BoundedStreamOptions) {
		if (!Number.isFinite(options.maxBytes) || options.maxBytes < 1) {
			throw new RangeError("maxBytes must be a positive finite number");
		}
		this.maxBytes = Math.floor(options.maxBytes);
		const headShare = Math.min(1, Math.max(0, options.headShare ?? 0.5));
		this.headBytes = Math.floor(this.maxBytes * headShare);
		this.tailBytes = this.maxBytes - this.headBytes;
		this.omissionMarker = options.omissionMarker ?? DEFAULT_MARKER;
	}

	/** Append a decoded string or a raw UTF-8 chunk. */
	append(chunk: string | Uint8Array): BoundedStreamSnapshot {
		this.isAuthoritative = false;
		if (typeof chunk === "string") {
			const decodedBytes = this.byteDecoder.decode();
			if (decodedBytes) this.appendDecoded(decodedBytes);
			this.appendStringChunk(chunk);
		} else {
			this.flushPendingSurrogate();
			const decoded = this.byteDecoder.decode(chunk, { stream: true });
			if (decoded) this.appendDecoded(decoded);
		}
		return this.snapshot();
	}

	/** Flush an incomplete UTF-8 sequence or dangling UTF-16 surrogate. */
	flush(): BoundedStreamSnapshot {
		this.flushPendingSurrogate();
		const decoded = this.byteDecoder.decode();
		if (decoded) this.appendDecoded(decoded);
		return this.snapshot();
	}

	/** Replace all speculative stream chunks with the authoritative final text. */
	replaceFinal(value: string | Uint8Array): BoundedStreamSnapshot {
		this.reset();
		const decoded = typeof value === "string" ? replaceDanglingSurrogates(value) : new TextDecoder().decode(value);
		this.appendDecoded(decoded);
		this.isAuthoritative = true;
		return this.snapshot();
	}

	clear(): void {
		this.reset();
	}

	snapshot(): BoundedStreamSnapshot {
		const partialValue = this.partialValue;
		const partialPending = this.partialPending;
		const partialStart = this.partialStart;
		const partialHasAnsi = this.partialHasAnsi;
		const partialAnsiPendingCharacters = this.partialAnsiPending.characters;
		let partial: string | undefined;
		const partialText = () => {
			if (partial !== undefined) return partial;
			const source = retainedSuffix(partialValue, partialStart, partialPending);
			partial =
				partialHasAnsi && partialAnsiPendingCharacters > 0
					? source.slice(0, Math.max(0, source.length - partialAnsiPendingCharacters))
					: source;
			return partial;
		};
		if (!this.truncated) {
			const pendingCharacters = this.partialAnsiPending.characters;
			const exact =
				pendingCharacters > 0
					? this.exactValue.slice(0, Math.max(0, this.exactValue.length - pendingCharacters))
					: this.exactValue;
			return {
				text: exact,
				head: exact,
				tail: "",
				get partialLine() {
					return partialText();
				},
				truncated: false,
				omittedBytes: 0,
				totalBytes: this.bytes,
				lineCount: this.lineCount(),
				authoritative: this.isAuthoritative,
			};
		}

		const tailValue = this.tailValue;
		const tailPending = this.tailPending;
		const tailStart = this.tailStart;
		const tailSourceBytes = this.tailValueBytes;
		const tailAnsiPendingCharacters = this.tailAnsiPending.characters;
		const tailVisibleBytes = Math.max(0, tailSourceBytes - this.tailAnsiPending.bytes);
		const totalBytes = this.bytes;
		const head = this.headValue;
		const headLength = byteLength(head);
		const hasAnsi = this.hasAnsi;
		const omissionMarker = this.omissionMarker;
		let tail: string | undefined;
		let omittedBytes: number | undefined;
		let marker: string | undefined;
		let text: string | undefined;
		const tailText = () => {
			if (tail === undefined) {
				const source = retainedSuffix(tailValue, tailStart, tailPending);
				tail =
					hasAnsi && tailAnsiPendingCharacters > 0
						? source.slice(0, Math.max(0, source.length - tailAnsiPendingCharacters))
						: source;
			}
			return tail;
		};
		const omitted = () => {
			if (omittedBytes === undefined) {
				omittedBytes = Math.max(0, totalBytes - headLength - tailVisibleBytes);
			}
			return omittedBytes;
		};
		const omission = () => {
			if (marker === undefined) marker = omissionMarker(omitted());
			return marker;
		};
		return {
			get text() {
				const suffix = tailText();
				const gap = omission();
				if (text === undefined) {
					text = hasAnsi ? `${head}${ANSI_RESET}${gap}${ANSI_RESET}${suffix}${ANSI_RESET}` : `${head}${gap}${suffix}`;
				}
				return text;
			},
			head,
			get tail() {
				return tailText();
			},
			get partialLine() {
				return partialText();
			},
			truncated: true,
			get omittedBytes() {
				return omitted();
			},
			totalBytes: this.bytes,
			lineCount: this.lineCount(),
			authoritative: this.isAuthoritative,
		};
	}

	private appendStringChunk(chunk: string): void {
		let decoded = `${this.pendingHighSurrogate}${chunk}`;
		this.pendingHighSurrogate = "";
		if (decoded.length > 0 && isHighSurrogate(decoded.charCodeAt(decoded.length - 1))) {
			this.pendingHighSurrogate = decoded.at(-1) ?? "";
			decoded = decoded.slice(0, -1);
		}
		if (decoded) this.appendDecoded(decoded);
	}

	private appendDecoded(decoded: string): void {
		if (!decoded) return;
		const chunkBytes = byteLength(decoded);
		this.bytes += chunkBytes;
		this.newlines += countNewlines(decoded);
		this.endsWithNewline = decoded.endsWith("\n");
		this.hasAnsi ||= terminalSequenceStart(decoded) !== undefined;

		this.appendPartial(decoded);

		if (!this.truncated) {
			if (this.exactBytes + chunkBytes <= this.maxBytes) {
				this.exactValue += decoded;
				this.exactBytes += chunkBytes;
				return;
			}
			const candidate = this.exactValue + decoded;
			this.headValue = ansiSafePrefix(candidate, this.headBytes);
			this.tailValue = ansiAlignedSuffix(candidate, this.tailBytes);
			this.tailPending = "";
			this.tailPendingBytes = 0;
			this.tailStart = 0;
			this.tailValueBytes = byteLength(this.tailValue);
			this.tailAnsiPending = advanceAnsiPending({ parser: "", characters: 0, bytes: 0 }, this.tailValue);
			this.exactValue = "";
			this.exactBytes = 0;
			this.truncated = true;
			return;
		}

		this.tailPending += decoded;
		this.tailPendingBytes += chunkBytes;
		this.tailValueBytes += chunkBytes;
		this.tailAnsiPending = advanceAnsiPending(this.tailAnsiPending, decoded);
		if (this.tailValueBytes > this.tailBytes) {
			this.trimTail(this.tailValueBytes - this.tailBytes);
		}
		if (this.tailStart >= TAIL_ROLL_BYTES || this.tailPendingBytes >= TAIL_ROLL_BYTES) {
			this.compactTail();
		}
	}

	private trimTail(excessBytes: number): void {
		let removedBytes = 0;
		let sequenceStart = terminalSequenceStart(this.tailValue, this.tailStart);
		while (removedBytes < excessBytes) {
			if (this.tailStart >= this.tailValue.length) {
				this.compactTail();
				sequenceStart = terminalSequenceStart(this.tailValue, this.tailStart);
				if (!this.tailValue) break;
			}
			const start = this.tailStart;
			const code = this.tailValue.codePointAt(start) ?? 0xfffd;
			if (sequenceStart === start) {
				let end = terminalSequenceEnd(this.tailValue, start)?.end;
				if (end === undefined && this.tailPending) {
					this.compactTail();
					sequenceStart = terminalSequenceStart(this.tailValue, this.tailStart);
					end = terminalSequenceEnd(this.tailValue, this.tailStart)?.end;
				}
				if (end === undefined) {
					removedBytes += byteLengthRange(this.tailValue, this.tailStart, this.tailValue.length);
					this.tailStart = this.tailValue.length;
					sequenceStart = undefined;
					continue;
				}
				removedBytes += byteLengthRange(this.tailValue, this.tailStart, end);
				this.tailStart = end;
				sequenceStart = terminalSequenceStart(this.tailValue, this.tailStart);
				continue;
			}
			removedBytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
			this.tailStart += code > 0xffff ? 2 : 1;
			if (sequenceStart !== undefined && this.tailStart > sequenceStart) {
				sequenceStart = terminalSequenceStart(this.tailValue, this.tailStart);
			}
		}
		this.tailValueBytes = Math.max(0, this.tailValueBytes - removedBytes);
	}

	private compactTail(): void {
		this.tailValue = retainedSuffix(this.tailValue, this.tailStart, this.tailPending);
		this.tailPending = "";
		this.tailPendingBytes = 0;
		this.tailStart = 0;
	}

	private flushPendingSurrogate(): void {
		if (!this.pendingHighSurrogate) return;
		this.pendingHighSurrogate = "";
		this.appendDecoded("\uFFFD");
	}

	private appendPartial(decoded: string): void {
		const finalNewline = decoded.lastIndexOf("\n");
		const chunk = finalNewline >= 0 ? decoded.slice(finalNewline + 1) : decoded;
		if (finalNewline >= 0) {
			this.partialValue = chunk;
			this.partialPending = "";
			this.partialPendingBytes = 0;
			this.partialStart = 0;
			this.partialBytes = byteLength(chunk);
			this.partialHasAnsi = terminalSequenceStart(chunk) !== undefined;
			this.partialAnsiPending = advanceAnsiPending({ parser: "", characters: 0, bytes: 0 }, chunk);
		} else if (chunk) {
			const chunkBytes = byteLength(chunk);
			this.partialPending += chunk;
			this.partialPendingBytes += chunkBytes;
			this.partialBytes += chunkBytes;
			this.partialHasAnsi ||= terminalSequenceStart(chunk) !== undefined;
			this.partialAnsiPending = advanceAnsiPending(this.partialAnsiPending, chunk);
		}
		if (this.partialBytes > this.maxBytes) this.trimPartial(this.partialBytes - this.maxBytes);
		if (this.partialStart >= TAIL_ROLL_BYTES || this.partialPendingBytes >= TAIL_ROLL_BYTES) {
			this.compactPartial();
		}
	}

	private trimPartial(excessBytes: number): void {
		let removedBytes = 0;
		let sequenceStart = terminalSequenceStart(this.partialValue, this.partialStart);
		while (removedBytes < excessBytes) {
			if (this.partialStart >= this.partialValue.length) {
				this.compactPartial();
				sequenceStart = terminalSequenceStart(this.partialValue, this.partialStart);
				if (!this.partialValue) break;
			}
			const code = this.partialValue.codePointAt(this.partialStart) ?? 0xfffd;
			if (sequenceStart === this.partialStart) {
				let end = terminalSequenceEnd(this.partialValue, this.partialStart)?.end;
				if (end === undefined && this.partialPending) {
					this.compactPartial();
					sequenceStart = terminalSequenceStart(this.partialValue, this.partialStart);
					end = terminalSequenceEnd(this.partialValue, this.partialStart)?.end;
				}
				if (end === undefined) {
					removedBytes += byteLengthRange(this.partialValue, this.partialStart, this.partialValue.length);
					this.partialStart = this.partialValue.length;
					sequenceStart = undefined;
					continue;
				}
				removedBytes += byteLengthRange(this.partialValue, this.partialStart, end);
				this.partialStart = end;
				sequenceStart = terminalSequenceStart(this.partialValue, this.partialStart);
				continue;
			}
			removedBytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
			this.partialStart += code > 0xffff ? 2 : 1;
			if (sequenceStart !== undefined && this.partialStart > sequenceStart) {
				sequenceStart = terminalSequenceStart(this.partialValue, this.partialStart);
			}
		}
		this.partialBytes = Math.max(0, this.partialBytes - removedBytes);
	}

	private compactPartial(): void {
		this.partialValue = retainedSuffix(this.partialValue, this.partialStart, this.partialPending);
		this.partialPending = "";
		this.partialPendingBytes = 0;
		this.partialStart = 0;
	}

	private lineCount(): number {
		if (this.bytes === 0) return 0;
		return this.newlines + (this.endsWithNewline ? 0 : 1);
	}

	private reset(): void {
		this.exactValue = "";
		this.exactBytes = 0;
		this.truncated = false;
		this.headValue = "";
		this.tailValue = "";
		this.tailPending = "";
		this.tailPendingBytes = 0;
		this.tailStart = 0;
		this.tailValueBytes = 0;
		this.tailAnsiPending = { parser: "", characters: 0, bytes: 0 };
		this.partialValue = "";
		this.partialPending = "";
		this.partialPendingBytes = 0;
		this.partialStart = 0;
		this.partialBytes = 0;
		this.partialHasAnsi = false;
		this.partialAnsiPending = { parser: "", characters: 0, bytes: 0 };
		this.bytes = 0;
		this.newlines = 0;
		this.endsWithNewline = false;
		this.hasAnsi = false;
		this.isAuthoritative = false;
		this.pendingHighSurrogate = "";
		this.byteDecoder = new TextDecoder();
	}
}

function replaceDanglingSurrogates(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (isHighSurrogate(code)) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				result += value.slice(index, index + 2);
				index += 1;
			} else result += "\uFFFD";
		} else if (code >= 0xdc00 && code <= 0xdfff) result += "\uFFFD";
		else result += value[index];
	}
	return result;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function countNewlines(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1;
	return count;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function utf8Prefix(text: string, budget: number): string {
	if (budget <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= budget) return text;
	let end = budget;
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

function utf8Suffix(text: string, budget: number): string {
	if (budget <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= budget) return text;
	let start = buffer.length - budget;
	while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
	return buffer.subarray(start).toString("utf8");
}

function byteLengthRange(text: string, start: number, end: number): number {
	let bytes = 0;
	for (let index = start; index < end; ) {
		const code = text.codePointAt(index) ?? 0xfffd;
		bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		index += code > 0xffff ? 2 : 1;
	}
	return bytes;
}

function retainedSuffix(value: string, start: number, pending: string): string {
	const retained = start === 0 ? value : value.slice(start);
	if (!retained) return pending;
	if (!pending) return retained;
	return retained + pending;
}

function advanceAnsiPending(previous: AnsiPending, chunk: string): AnsiPending {
	if (!previous.parser && terminalSequenceStart(chunk) === undefined) return previous;
	const source = previous.parser + chunk;
	for (let sequenceIndex = terminalSequenceStart(source); sequenceIndex !== undefined; ) {
		const end = terminalSequenceEnd(source, sequenceIndex)?.end;
		if (end === undefined) {
			const continued = previous.characters > 0 && sequenceIndex === 0;
			const pending = source.slice(sequenceIndex);
			return {
				parser: boundAnsiParser(pending),
				characters: continued ? previous.characters + chunk.length : pending.length,
				bytes: continued ? previous.bytes + byteLength(chunk) : byteLength(pending),
			};
		}
		sequenceIndex = terminalSequenceStart(source, end);
	}
	return { parser: "", characters: 0, bytes: 0 };
}

function boundAnsiParser(pending: string): string {
	if (pending.length <= MAX_ANSI_PARSER_CHARACTERS) return pending;
	const prefixLength = pending.charCodeAt(0) === 0x1b ? 2 : 1;
	return pending.slice(0, prefixLength) + pending.slice(-(MAX_ANSI_PARSER_CHARACTERS - prefixLength));
}

function ansiSafePrefix(text: string, budget: number): string {
	let prefix = utf8Prefix(text, budget);
	for (let sequenceIndex = terminalSequenceStart(prefix); sequenceIndex !== undefined; ) {
		const end = terminalSequenceEnd(prefix, sequenceIndex)?.end;
		if (end === undefined) {
			prefix = prefix.slice(0, sequenceIndex);
			break;
		}
		sequenceIndex = terminalSequenceStart(prefix, end);
	}
	return prefix;
}

function ansiAlignedSuffix(text: string, budget: number): string {
	let suffix = utf8Suffix(text, budget);
	let start = text.length - suffix.length;
	for (let sequenceIndex = terminalSequenceStart(text); sequenceIndex !== undefined && sequenceIndex < start; ) {
		const end = terminalSequenceEnd(text, sequenceIndex)?.end;
		if (end === undefined) return "";
		if (end > start) {
			start = end;
			suffix = text.slice(start);
		}
		sequenceIndex = terminalSequenceStart(text, end);
	}
	return suffix;
}
