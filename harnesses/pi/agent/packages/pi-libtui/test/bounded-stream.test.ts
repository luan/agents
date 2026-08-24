import { describe, expect, test } from "bun:test";
import { BoundedStreamBuffer } from "../src/stream.ts";

describe("BoundedStreamBuffer", () => {
	test("never exposes an incomplete ANSI control before truncation", () => {
		const stream = new BoundedStreamBuffer({ maxBytes: 64 });
		expect(stream.append("ready\x1b[3").text).toBe("ready");
		expect(stream.append("1mred").text).toBe("ready\x1b[31mred");
	});

	test("keeps exact output and the current partial line while under budget", () => {
		const stream = new BoundedStreamBuffer({ maxBytes: 64 });
		stream.append("one\ntw");
		const snapshot = stream.append("o\npartial");

		expect(snapshot).toMatchObject({
			text: "one\ntwo\npartial",
			head: "one\ntwo\npartial",
			tail: "",
			partialLine: "partial",
			truncated: false,
			totalBytes: 15,
			lineCount: 3,
		});
	});

	test("decodes split UTF-8 and UTF-16 chunks without broken code points", () => {
		const bytes = new TextEncoder().encode("A😀界Z");
		const byteStream = new BoundedStreamBuffer({ maxBytes: 64 });
		for (const byte of bytes) byteStream.append(Uint8Array.of(byte));
		expect(byteStream.flush().text).toBe("A😀界Z");

		const stringStream = new BoundedStreamBuffer({ maxBytes: 64 });
		const emoji = "😀";
		stringStream.append(emoji.slice(0, 1));
		expect(stringStream.snapshot().text).toBe("");
		stringStream.append(emoji.slice(1));
		expect(stringStream.snapshot().text).toBe(emoji);
	});

	test("retains code-point-safe head and tail edges", () => {
		const stream = new BoundedStreamBuffer({
			maxBytes: 12,
			omissionMarker: (bytes) => `<${bytes}>`,
		});
		const snapshot = stream.append("A😀BCDEF😀Z");

		expect(snapshot).toMatchObject({
			head: "A😀B",
			tail: "F😀Z",
			truncated: true,
			omittedBytes: 3,
			totalBytes: 15,
		});
		expect(snapshot.text).toBe("A😀B<3>F😀Z");
		expect(snapshot.text).not.toContain("�");
	});

	test("never cuts an ANSI sequence and resets styling around an omission", () => {
		const stream = new BoundedStreamBuffer({
			maxBytes: 18,
			omissionMarker: () => "<cut>",
		});
		const snapshot = stream.append("\x1b[31mred-red-red-red\x1b[39m tail");

		expect(snapshot.truncated).toBe(true);
		expect(snapshot.head.endsWith("\x1b[")).toBe(false);
		expect(snapshot.tail.startsWith("31m")).toBe(false);
		expect(snapshot.text).toContain("\x1b[0m<cut>\x1b[0m");
		expect(snapshot.text.endsWith("\x1b[0m")).toBe(true);
	});

	test("never cuts an eight-bit CSI sequence at a retained edge", () => {
		const head = new BoundedStreamBuffer({ maxBytes: 8, omissionMarker: () => "<cut>" });
		const headSnapshot = head.append("\u009b31mred-red-red-red\u009b39m tail");
		expect(headSnapshot.head).toBe("");
		expect(headSnapshot.text).not.toContain("\u009b31");

		const tail = new BoundedStreamBuffer({ maxBytes: 12, omissionMarker: () => "<cut>" });
		const tailSnapshot = tail.append(`${"x".repeat(30)}\u009b31mred`);
		expect(tailSnapshot.tail).toBe("red");
		expect(tailSnapshot.text).not.toContain("31mred");
	});

	test("retains an ANSI sequence split across chunks without exposing its partial bytes", () => {
		const stream = new BoundedStreamBuffer({ maxBytes: 24, omissionMarker: () => "<cut>" });
		stream.append(`${"x".repeat(50)}\x1b[3`);
		expect(stream.snapshot().text).not.toContain("\x1b[3");

		const completed = stream.append("1mred");
		expect(completed.tail).toContain("\x1b[31mred");
		expect(completed.text).toContain("\x1b[31mred\x1b[0m");
	});

	test("retains an eight-bit CSI sequence split across chunks", () => {
		const stream = new BoundedStreamBuffer({ maxBytes: 24, omissionMarker: () => "<cut>" });
		stream.append(`${"x".repeat(50)}\u009b3`);
		expect(stream.snapshot().text).not.toContain("\u009b3");

		const completed = stream.append("1mred");
		expect(completed.tail).toContain("\u009b31mred");
		expect(completed.text).toContain("\u009b31mred\x1b[0m");
	});

	test("keeps a split string-control boundary intact while retaining stream styling", () => {
		const stream = new BoundedStreamBuffer({ maxBytes: 24, omissionMarker: () => "<cut>" });
		stream.append(`${"x".repeat(50)}\x1b]52;c;secret`);
		const completed = stream.append("\x9ctail");

		expect(completed.tail).not.toStartWith("]52;");
		expect(completed.tail).toEndWith("tail");
	});

	test("lets an authoritative final value replace speculative chunks", () => {
		const stream = new BoundedStreamBuffer({ maxBytes: 10 });
		stream.append("speculative output that will disappear");
		const final = stream.replaceFinal("final ✓");

		expect(final).toMatchObject({
			text: "final ✓",
			head: "final ✓",
			tail: "",
			truncated: false,
			authoritative: true,
			totalBytes: 9,
		});
	});

	test("stays bounded across many tiny chunks", () => {
		const stream = new BoundedStreamBuffer({ maxBytes: 128 });
		for (let index = 0; index < 100_000; index += 1) stream.append(`line-${index}\n`);
		const snapshot = stream.snapshot();

		expect(snapshot.truncated).toBe(true);
		expect(Buffer.byteLength(snapshot.head) + Buffer.byteLength(snapshot.tail)).toBeLessThanOrEqual(128);
		expect(snapshot.tail).toEndWith("line-99999\n");
		expect(snapshot.partialLine).toBe("");
		expect(snapshot.lineCount).toBe(100_000);
	});

	test("keeps lazy snapshots stable while later chunks arrive", () => {
		const stream = new BoundedStreamBuffer({ maxBytes: 1_024 });
		const before = stream.append("before");
		stream.append(" after");

		expect(before.text).toBe("before");
		expect(before.partialLine).toBe("before");
		expect(stream.snapshot().text).toBe("before after");
	});
});
