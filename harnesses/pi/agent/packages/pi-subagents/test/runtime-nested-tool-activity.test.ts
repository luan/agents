import { expect, test } from "bun:test";
import { createNestedToolActivityReader } from "../src/runtime/nested-tool-activity.ts";

test("deduplicates nested activity across exec and wait", () => {
	const reader = createNestedToolActivityReader();
	const running = { details: { calls: [{ name: "read", toolCallId: "call-1", status: "running" }] } };
	const completed = { details: { calls: [{ name: "read", toolCallId: "call-1", status: "completed" }] } };
	expect(reader.started(running)).toEqual(["read"]);
	expect(reader.started(completed)).toEqual([]);
	expect(reader.ended(running)).toEqual([]);
	expect(reader.ended(completed)).toEqual(["read"]);
	expect(reader.ended(completed)).toEqual([]);
});

test("ignores malformed trace details", () => {
	const reader = createNestedToolActivityReader();
	expect(reader.started({ details: { calls: [null, {}, { name: "read", toolCallId: "" }] } })).toEqual([]);
	expect(reader.ended({})).toEqual([]);
});
