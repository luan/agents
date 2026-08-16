import { expect, test } from "bun:test";
import { echoNotice, type NestedCallRecord } from "./runtime.ts";

function readCalls(count: number): NestedCallRecord[] {
	return Array.from({ length: count }, (_, index) => ({
		name: "read",
		toolCallId: `cell-read-${index}`,
		args: { path: `bench/case-${index}.ts` },
		status: "completed" as const,
		startedAt: Date.now(),
		preview: `export function case${index}() {}`,
	}));
}

test("a mostly copied output gets the notice with its line counts", () => {
	const calls = readCalls(10);
	const output = [...calls.map((call) => call.preview), "=== done"].join("\n");

	expect(echoNotice(output, calls)).toBe(
		"Context notice: 10 of 11 printed lines were verbatim tool output. A derived answer belongs here, not the copy.",
	);
});

test("a derived answer that quotes two lines gets no notice", () => {
	const calls = readCalls(10);
	const derived = ["longest: bench/case-3.ts", "1,204 lines total", "8 files export a function"];
	const output = [...derived, calls[0]?.preview, calls[1]?.preview].join("\n");

	expect(echoNotice(output, calls)).toBeUndefined();
});

test("a short copied output stays under the printed-line floor", () => {
	const calls = readCalls(3);

	expect(echoNotice(calls.map((call) => call.preview).join("\n"), calls)).toBeUndefined();
});

test("a cell that called no tool gets no notice", () => {
	expect(echoNotice(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"), [])).toBeUndefined();
});
