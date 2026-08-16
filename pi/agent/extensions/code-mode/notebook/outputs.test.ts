import { expect, it } from "bun:test";
import { NotebookCell } from "./cell.ts";
import type { NotebookHostOutput } from "./host-protocol.ts";
import { NOTEBOOK_EXIT_NAME } from "./kernel-bootstrap.ts";
import { notebookItemPieces, notebookOutputPieces } from "./outputs.ts";

function cellOf(outputs: NotebookHostOutput[]) {
	const cell = new NotebookCell("cell-1", 1);
	for (const output of outputs) cell.applyOutput(output);
	return cell.outcome();
}

it("appends stream text verbatim", () => {
	const outcome = cellOf([
		{ kind: "stream", name: "stdout", text: "hi\n" },
		{ kind: "stream", name: "stdout", text: "there\n" },
	]);
	expect(outcome.output).toBe("hi\nthere");
	expect(outcome.images).toBeUndefined();
	expect(outcome.error).toBeUndefined();
});

it("prefers text/plain in a result bundle", () => {
	expect(notebookOutputPieces({ kind: "result", data: { "text/plain": "42", "text/html": "<b>42</b>" } })).toEqual([
		{ kind: "text", text: "42" },
	]);
});

it("drops the literal undefined a valueless cell reports", () => {
	expect(notebookOutputPieces({ kind: "result", data: { "text/plain": "undefined" } })).toEqual([]);
});

it("pulls images out of a display bundle", () => {
	const outcome = cellOf([
		{ kind: "display", data: { "image/png": "AAAA", "text/plain": "[Object]" } },
		{ kind: "display", data: { "image/jpeg": "BBBB" } },
		{ kind: "display", data: { "image/gif": "CCCC" } },
	]);
	expect(outcome.images).toEqual([
		{ data: "AAAA", mimeType: "image/png" },
		{ data: "BBBB", mimeType: "image/jpeg" },
		{ data: "CCCC", mimeType: "image/gif" },
	]);
	// The bundle's `text/plain` is a placeholder beside an image, so it never reaches the output.
	expect(outcome.output).toBe("");
});

it("reports an error with its traceback", () => {
	const outcome = cellOf([
		{ kind: "error", ename: "Error", evalue: "boom", traceback: ["Error: boom", "    at <anonymous>:1:7"] },
	]);
	expect(outcome.error).toBe("Error: boom\n    at <anonymous>:1:7");
});

it("falls back to ename and evalue when the traceback is empty", () => {
	expect(
		notebookOutputPieces({ kind: "error", ename: "TypeError", evalue: "x is not a function", traceback: [] }),
	).toEqual([{ kind: "error", error: "TypeError: x is not a function" }]);
});

it("bounds a runaway traceback", () => {
	const outcome = cellOf([{ kind: "error", ename: "Error", evalue: "big", traceback: ["x".repeat(400_000)] }]);
	expect(outcome.error?.length).toBeLessThanOrEqual(256 * 1024);
	expect(outcome.error).toEndWith("[Notebook error truncated]");
});

it("keeps only the first error", () => {
	const outcome = cellOf([
		{ kind: "error", ename: "Error", evalue: "first", traceback: [] },
		{ kind: "error", ename: "Error", evalue: "second", traceback: [] },
	]);
	expect(outcome.error).toBe("Error: first");
});

it("treats exit() as a clean end", () => {
	const outcome = cellOf([
		{ kind: "stream", name: "stdout", text: "before exit\n" },
		{ kind: "error", ename: NOTEBOOK_EXIT_NAME, evalue: "exit() ended the cell", traceback: ["…"] },
	]);
	expect(outcome.error).toBeUndefined();
	expect(outcome.output).toBe("before exit");
});

it("maps emitted bridge items", () => {
	const cell = new NotebookCell("cell-1", 1);
	cell.applyItems([
		{ type: "input_text", text: "one" },
		{ type: "input_image", image_url: "data:image/png;base64,ZZZZ" },
		{ type: "input_audio", audio_url: "data:audio/wav;base64,YYYY" },
	]);
	const outcome = cell.outcome();
	expect(outcome.output).toBe("one");
	expect(outcome.images).toEqual([{ data: "ZZZZ", mimeType: "image/png" }]);
});

it("ignores an image item that is not a base64 data url", () => {
	expect(notebookItemPieces({ type: "input_image", image_url: "https://example.com/cat.png" })).toEqual([]);
});

it("starts an emitted item on its own line after an unterminated stream chunk", () => {
	const cell = new NotebookCell("cell-1", 1);
	cell.applyOutput({ kind: "stream", name: "stdout", text: "partial" });
	cell.applyItems([{ type: "input_text", text: "item" }]);
	expect(cell.outcome().output).toBe("partial\nitem");
});

it("truncates once the item ceiling is reached", () => {
	const cell = new NotebookCell("cell-1", 1);
	for (let index = 0; index < 10_001; index += 1) cell.applyItems([{ type: "input_text", text: "x" }]);
	const output = cell.outcome().output;
	expect(output).toEndWith("[Notebook cell output truncated]");
	expect(output.split("\n").length).toBe(10_001);
});
