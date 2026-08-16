import { expect, test } from "bun:test";
import { createNestedToolActivityReader } from "./nested-tool-activity.ts";

function cellResult(calls: Array<{ name: string; toolCallId: string; status: string }>) {
	return { content: [], details: { cell_id: 1, calls } };
}

test("a code-mode child reports the tools its cell called, not just exec", () => {
	const reader = createNestedToolActivityReader();
	const running = cellResult([
		{ name: "exec_command", toolCallId: "cell-1", status: "completed" },
		{ name: "read", toolCallId: "cell-2", status: "running" },
	]);

	expect(reader.started(running)).toEqual(["exec_command", "read"]);
	expect(reader.started(running)).toEqual([]);
	expect(reader.ended(running)).toEqual(["exec_command"]);
});

/**
 * A cell that outlives its yield returns the same `calls` array from `exec` and again from `wait`, so
 * counting both reported twice the work the child did.
 */
test("a cell collected by wait counts each nested call once", () => {
	const reader = createNestedToolActivityReader();
	const yielded = cellResult([
		{ name: "exec_command", toolCallId: "cell-1", status: "completed" },
		{ name: "exec_command", toolCallId: "cell-2", status: "running" },
	]);
	const collected = cellResult([
		{ name: "exec_command", toolCallId: "cell-1", status: "completed" },
		{ name: "exec_command", toolCallId: "cell-2", status: "completed" },
	]);

	expect(reader.ended(yielded)).toEqual(["exec_command"]);
	expect(reader.ended(collected)).toEqual(["exec_command"]);
	expect(reader.ended(collected)).toEqual([]);
});

test("a tool result without cell calls reports nothing nested", () => {
	const reader = createNestedToolActivityReader();

	expect(reader.started({ content: [], details: { output: "hi" } })).toEqual([]);
	expect(reader.ended(undefined)).toEqual([]);
});
