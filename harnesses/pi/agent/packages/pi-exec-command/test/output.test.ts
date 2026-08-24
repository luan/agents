import { expect, test } from "bun:test";
import { appendBounded, OutputNormalizer, takeOutput, truncateOutput } from "../src/output.ts";

test("output bounds preserve the newest text and report the original size", () => {
	const state = { bufferChunks: [], bufferFirstChunk: 0, bufferLength: 0, bufferStartOffset: 0, emittedOffset: 0 };
	appendBounded(state, "a".repeat(2_000), 1_024);
	const output = takeOutput(state, 100);
	expect(output.output).toBe("a".repeat(400));
	expect(output.original_token_count).toBe(500);
	expect(output.output_truncated).toBe(true);
});

test("normalizes terminal controls split across bridge chunks", () => {
	const output = new OutputNormalizer();
	expect(output.write("before\x1b[")).toBe("before");
	expect(output.write("31mred\x1b]52;c;sec")).toBe("red");
	expect(output.end("ret\x07after")).toBe("after");
});

test("normalizes C1 controls and CRLF split across bridge chunks", () => {
	const output = new OutputNormalizer();
	expect(output.write("a\r")).toBe("a");
	expect(output.write("\nb\u009b31mred\u009b0m\u009d52;c;secret")).toBe("\nbred");
	expect(output.end("\u0007safe")).toBe("safe");
});

test("removes standalone C1 controls", () => {
	const output = new OutputNormalizer();
	expect(output.end("a\u0080\u008f\u0091\u009a\u009cb")).toBe("ab");
});

test("never starts a bounded output window with a lone low surrogate", () => {
	const text = `${"😀".repeat(128)}x`;
	const state = { bufferChunks: [], bufferFirstChunk: 0, bufferLength: 0, bufferStartOffset: 0, emittedOffset: 0 };
	appendBounded(state, text.slice(0, 129), 1_024);
	appendBounded(state, text.slice(129), 1_024);

	const window = takeOutput(state, 64).output;
	expect(window.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
	expect(window).toBe(`${"😀".repeat(127)}x`);
	expect(truncateOutput(text, 64).output).toBe(window);
});

test("keeps high-volume bounded appends within the streaming budget", () => {
	const state = { bufferChunks: [], bufferFirstChunk: 0, bufferLength: 0, bufferStartOffset: 0, emittedOffset: 0 };
	const chunk = "x".repeat(4_096);
	const started = performance.now();
	for (let index = 0; index < 40_000; index += 1) appendBounded(state, chunk, 8 * 1_024 * 1_024);
	expect(performance.now() - started).toBeLessThan(500);
	expect(state.bufferLength).toBe(8 * 1_024 * 1_024);
});
