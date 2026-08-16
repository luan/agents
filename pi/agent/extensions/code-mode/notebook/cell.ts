/**
 * One notebook cell's accumulated output.
 *
 * Two sources feed it: Jupyter outputs from the kernel process, and items the cell emitted through
 * the loopback bridge. Both become `CellOutcome`, the shape render.ts already draws.
 */

import type { CellImage, CellOutcome } from "../rust-kernel.ts";
import type { NotebookContentItem } from "./bridge-protocol.ts";
import type { NotebookHostOutput } from "./host-protocol.ts";
import { type NotebookOutputPiece, notebookItemPieces, notebookOutputPieces } from "./outputs.ts";

// Same ceilings the injected bootstrap applies at kernel-bootstrap.ts:12. A cell that beats the
// kernel's own bound, by printing through Jupyter, still stops here.
const MAX_CELL_OUTPUT_CHARS = 32 * 1024 * 1024;
const MAX_CELL_OUTPUT_ITEMS = 10_000;
const TRUNCATED_NOTICE = "[Notebook cell output truncated]";

export class NotebookCell {
	/** Aborted when the cell ends, so every tool call it left in flight stops. */
	readonly controller = new AbortController();
	private output = "";
	private readonly images: CellImage[] = [];
	private error: string | undefined;
	private chars = 0;
	private items = 0;
	private truncated = false;

	constructor(
		readonly id: string,
		readonly localId: number,
	) {}

	applyOutput(output: NotebookHostOutput): void {
		for (const piece of notebookOutputPieces(output)) this.push(piece);
	}

	applyItems(items: NotebookContentItem[]): void {
		for (const item of items) for (const piece of notebookItemPieces(item)) this.push(piece);
	}

	outcome(): CellOutcome {
		return {
			output: this.output.trimEnd(),
			...(this.images.length > 0 ? { images: this.images } : {}),
			...(this.error ? { error: this.error } : {}),
		};
	}

	private push(piece: NotebookOutputPiece): void {
		// The first error is the one that ended the cell. Later ones describe the unwind.
		if (piece.kind === "error") {
			this.error ??= piece.error;
			return;
		}
		if (this.truncated) return;
		const size = piece.kind === "text" ? piece.text.length : piece.image.data.length;
		if (this.items >= MAX_CELL_OUTPUT_ITEMS || this.chars + size > MAX_CELL_OUTPUT_CHARS) {
			this.append(TRUNCATED_NOTICE, false);
			this.truncated = true;
			return;
		}
		this.items += 1;
		this.chars += size;
		if (piece.kind === "image") this.images.push(piece.image);
		else this.append(piece.text, piece.stream === true);
	}

	private append(text: string, stream: boolean): void {
		// An emitted item is one line. A stream chunk brings its own newlines and is appended raw.
		if (!stream && this.output && !this.output.endsWith("\n")) this.output += "\n";
		this.output += stream ? text : `${text}\n`;
	}
}
