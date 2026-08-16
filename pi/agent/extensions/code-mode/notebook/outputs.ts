/**
 * Jupyter output events and bridge items -> the pieces a cell accumulates.
 *
 * host.mjs:80 already strips ANSI from `text/plain`, `evalue`, and every traceback line. Nothing
 * here strips again.
 */

import type { CellImage } from "../rust-kernel.ts";
import type { NotebookContentItem } from "./bridge-protocol.ts";
import type { NotebookHostOutput } from "./host-protocol.ts";
import { NOTEBOOK_EXIT_NAME } from "./kernel-bootstrap.ts";

/** Image MIME types a cell can return. Anything else stays text. */
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif"] as const;

const MAX_ERROR_CHARS = 256 * 1024;
const MAX_ERROR_FIELD_CHARS = 64 * 1024;

export type NotebookOutputPiece =
	/** `stream` text carries its own newlines. The cell appends it verbatim. */
	| { kind: "text"; text: string; stream?: boolean }
	| { kind: "image"; image: CellImage }
	| { kind: "error"; error: string };

export function notebookOutputPieces(output: NotebookHostOutput): NotebookOutputPiece[] {
	if (output.kind === "stream") return output.text ? [{ kind: "text", text: output.text, stream: true }] : [];
	if (output.kind === "error") {
		// `exit()` ends the cell as a success. kernel-bootstrap.ts:17 names that throw.
		if (output.ename === NOTEBOOK_EXIT_NAME) return [];
		return [{ kind: "error", error: kernelErrorText(output) }];
	}
	const pieces: NotebookOutputPiece[] = [];
	for (const mime of IMAGE_MIMES) {
		const data = output.data[mime];
		if (typeof data === "string" && data) pieces.push({ kind: "image", image: { data, mimeType: mime } });
	}
	// A bundle with an image also carries a placeholder `text/plain` such as `[Object]`. The image wins.
	if (pieces.length > 0) return pieces;
	const text = output.data["text/plain"] ?? output.data["text/markdown"];
	// A cell with no value reports the literal string `undefined`. That is noise, not output.
	if (typeof text === "string" && text && text !== "undefined") pieces.push({ kind: "text", text });
	return pieces;
}

/** Maps one emitted bridge item. `text()` and `image()` arrive this way, not over Jupyter. */
export function notebookItemPieces(item: NotebookContentItem): NotebookOutputPiece[] {
	if (item.type === "input_text") return item.text ? [{ kind: "text", text: item.text }] : [];
	// `input_audio` has no place in `CellOutcome`, so it is dropped, as rust-kernel.ts:501 drops it.
	if (item.type !== "input_image") return [];
	const match = item.image_url.match(/^data:([^;,]+);base64,(.+)$/s);
	return match ? [{ kind: "image", image: { mimeType: match[1] as string, data: match[2] as string } }] : [];
}

function kernelErrorText(output: { ename: string; evalue: string; traceback: string[] }): string {
	const ename = truncateField(output.ename || "Error");
	const evalue = truncateField(output.evalue || "Notebook cell failed");
	return boundedTraceback(output.traceback) ?? bound(`${ename}: ${evalue}`);
}

function boundedTraceback(traceback: string[]): string | undefined {
	if (!Array.isArray(traceback)) return undefined;
	let output = "";
	for (const line of traceback) {
		if (typeof line !== "string") continue;
		const separator = output ? "\n" : "";
		const remaining = MAX_ERROR_CHARS - output.length - separator.length;
		if (remaining <= 0) return markTruncated(output);
		output += separator + line.slice(0, remaining);
		if (line.length > remaining) return markTruncated(output);
	}
	return output || undefined;
}

function truncateField(value: string): string {
	const marker = "\n[Notebook error field truncated]";
	return value.length <= MAX_ERROR_FIELD_CHARS
		? value
		: `${value.slice(0, MAX_ERROR_FIELD_CHARS - marker.length)}${marker}`;
}

function bound(value: string): string {
	return value.length <= MAX_ERROR_CHARS ? value : markTruncated(value);
}

function markTruncated(value: string): string {
	const marker = "\n[Notebook error truncated]";
	return `${value.slice(0, MAX_ERROR_CHARS - marker.length)}${marker}`;
}
