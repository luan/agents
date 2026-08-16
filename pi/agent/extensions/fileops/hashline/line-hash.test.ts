import { describe, expect, it } from "bun:test";
import { HL_LINE_HASH_LENGTH, lineHashAt, lineHashes, lineHashMatches } from "./line-hash";

const LINES = ["alpha", "beta", "gamma", "delta", "epsilon"];

describe("line hashes", () => {
	it("emits a fixed-width lowercase hex hash", () => {
		for (let line = 1; line <= LINES.length; line++) {
			expect(lineHashAt(LINES, line)).toMatch(new RegExp(`^[0-9a-f]{${HL_LINE_HASH_LENGTH}}$`));
		}
	});

	it("gives identical lines different hashes when their neighbours differ", () => {
		const lines = ["open", "\t}", "close", "other", "\t}", "tail"];
		expect(lines[1]).toBe(lines[4]);
		expect(lineHashAt(lines, 2)).not.toBe(lineHashAt(lines, 5));
	});

	// The property that justifies hashing neighbours: an edit must not invalidate the model's whole map.
	it("invalidates only N-1, N and N+1 when line N changes", () => {
		const edited = [...LINES];
		edited[2] = "GAMMA";
		const before = lineHashes(LINES.join("\n"));
		const after = lineHashes(edited.join("\n"));
		const changed = before.map((hash, index) => (hash === after[index] ? null : index + 1)).filter((n) => n !== null);
		expect(changed).toEqual([2, 3, 4]);
	});

	it("ignores trailing whitespace, matching the file tag's normalization", () => {
		expect(lineHashAt(["a", "b   ", "c"], 2)).toBe(lineHashAt(["a", "b", "c"], 2));
		expect(lineHashAt(["a", "b\t", "c"], 2)).toBe(lineHashAt(["a", "b", "c"], 2));
	});

	// 3 of 104 measured line errors were pure indent, and the user's bar is byte-exact.
	it("treats leading indent as significant", () => {
		expect(lineHashAt(["a", "  b", "c"], 2)).not.toBe(lineHashAt(["a", "b", "c"], 2));
		expect(lineHashAt(["x", "}", "y"], 2)).not.toBe(lineHashAt(["x", " }", "y"], 2));
	});

	it("hashes out-of-range neighbours as empty, so first and last lines are addressable", () => {
		expect(lineHashAt(LINES, 1)).toMatch(/^[0-9a-f]+$/);
		expect(lineHashAt(LINES, LINES.length)).toMatch(/^[0-9a-f]+$/);
	});

	it("matches case-insensitively, because models re-type hashes", () => {
		const hash = lineHashAt(LINES, 3);
		expect(lineHashMatches(LINES, 3, hash.toUpperCase())).toBe(true);
		expect(lineHashMatches(LINES, 3, hash)).toBe(true);
	});

	it("rejects a hash that belonged to a different line", () => {
		expect(lineHashMatches(LINES, 3, lineHashAt(LINES, 1))).toBe(false);
	});

	it("returns one hash per line of the text", () => {
		expect(lineHashes("a\nb\nc\n")).toHaveLength(4);
	});
});
