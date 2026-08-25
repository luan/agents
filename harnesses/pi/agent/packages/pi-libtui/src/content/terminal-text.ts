import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Remove terminal controls from text that is not explicitly a terminal projection. */
export function sanitizeTuiText(text: string): string {
	return stripTerminalSequences(sanitizeTuiAnsi(text).replace(/\u009b[0-?]*[ -/]*[@-~]/gu, ""))
		.replaceAll("\r", "")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "�");
}

/** Preserve SGR styling while removing terminal controls with side effects. */
export function sanitizeTuiAnsi(text: string): string {
	return sanitizeTuiAnsiChunk(text).text;
}

interface SanitizedAnsiChunk {
	text: string;
	pending: string;
}

/** Sanitize one stream chunk while retaining a split terminal sequence for the next chunk. */
export function sanitizeTuiAnsiChunk(text: string, maxPending = 4_096): SanitizedAnsiChunk {
	let safe = "";
	let plainStart = 0;
	for (let index = terminalSequenceStart(text); index !== undefined; ) {
		safe += sanitizePlainSegment(text.slice(plainStart, index));
		const sequence = terminalSequenceEnd(text, index);
		if (sequence === undefined) return { text: safe, pending: boundPending(text.slice(index), maxPending) };
		if (sequence.kind === "sgr") safe += text.slice(index, sequence.end);
		plainStart = sequence.end;
		index = terminalSequenceStart(text, sequence.end);
	}
	return { text: safe + sanitizePlainSegment(text.slice(plainStart)), pending: "" };
}

function boundPending(pending: string, maximum: number): string {
	const limit = Math.max(4, Math.floor(Number.isFinite(maximum) ? maximum : 4_096));
	if (pending.length <= limit) return pending;
	const csiPrefix = pending.charCodeAt(0) === 0x9b ? "\u009b" : pending.startsWith("\u001b[") ? "\u001b[" : undefined;
	if (csiPrefix) {
		const tail = pending.slice(-(limit - csiPrefix.length - 1));
		return `${csiPrefix}!${tail}`;
	}
	const prefixLength = pending.charCodeAt(0) === 0x1b ? 2 : 1;
	const prefix = pending.slice(0, prefixLength);
	return prefix + pending.slice(-(limit - prefix.length));
}

/** Sanitize and flatten one action-row field. */
export function sanitizeTuiField(text: string): string {
	return sanitizeTuiText(text).replace(/[\n\t]+/gu, " ");
}

function sanitizePlainSegment(text: string): string {
	return text.replaceAll("\r", "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "�");
}

export function terminalSequenceStart(text: string, start = 0): number | undefined {
	for (let index = start; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (
			code === 0x1b ||
			code === 0x90 ||
			code === 0x98 ||
			code === 0x9b ||
			code === 0x9d ||
			code === 0x9e ||
			code === 0x9f
		)
			return index;
	}
	return undefined;
}

export function terminalSequenceEnd(text: string, start: number): { end: number; kind: "sgr" | "control" } | undefined {
	const control = text.charCodeAt(start);
	const csiStart = control === 0x9b ? start + 1 : text[start + 1] === "[" ? start + 2 : -1;
	if (csiStart >= 0) {
		for (let index = csiStart; index < text.length; index += 1) {
			const code = text.charCodeAt(index);
			if (code < 0x40 || code > 0x7e) continue;
			const parameters = text.slice(csiStart, index);
			return {
				end: index + 1,
				kind: text[index] === "m" && /^[0-9:;?]*$/u.test(parameters) ? "sgr" : "control",
			};
		}
		return undefined;
	}
	if (control === 0x9d) {
		const end = stringControlEnd(text, start + 1, true);
		return end === undefined ? undefined : { end, kind: "control" };
	}
	if (control === 0x90 || control === 0x98 || control === 0x9e || control === 0x9f) {
		const end = stringControlEnd(text, start + 1, false);
		return end === undefined ? undefined : { end, kind: "control" };
	}

	const introducer = text[start + 1];
	if (introducer === undefined) return undefined;
	if (introducer === "]") {
		const end = stringControlEnd(text, start + 2, true);
		return end === undefined ? undefined : { end, kind: "control" };
	}
	if (introducer === "P" || introducer === "^" || introducer === "_") {
		const end = stringControlEnd(text, start + 2, false);
		return end === undefined ? undefined : { end, kind: "control" };
	}
	return { end: Math.min(text.length, start + 2), kind: "control" };
}

function stringControlEnd(text: string, start: number, bellTerminates: boolean): number | undefined {
	for (let index = start; index < text.length; index += 1) {
		if (bellTerminates && text.charCodeAt(index) === 0x07) return index + 1;
		if (text.charCodeAt(index) === 0x9c) return index + 1;
		if (text.charCodeAt(index) === 0x1b && text[index + 1] === "\\") return index + 2;
	}
	return undefined;
}
