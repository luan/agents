import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "./fs";
import { Patch } from "./input";
import { lineHashAt } from "./line-hash";
import { Patcher } from "./patcher";
import { InMemorySnapshotStore } from "./snapshots";
import { anchorHashCoverage } from "./verify-anchors";

const PATH = "a.ts";
const TEXT = "one\ntwo\nthree\nfour\nfive\n";

function setup(text = TEXT) {
	const fs = new InMemoryFilesystem([[PATH, text]]);
	const snapshots = new InMemorySnapshotStore();
	const tag = snapshots.record(PATH, text);
	return { fs, snapshots, tag, patcher: new Patcher({ fs, snapshots }) };
}

describe("per-line anchor verification", () => {
	it("applies when the anchor hash still matches", async () => {
		const { patcher, tag, fs } = setup();
		const hash = lineHashAt(TEXT.split("\n"), 2);
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2#${hash}:\n+TWO`));
		expect(fs.get(PATH)).toBe("one\nTWO\nthree\nfour\nfive\n");
	});

	it("rejects a wrong hash and writes nothing", async () => {
		const { patcher, tag, fs } = setup();
		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2#ff:\n+TWO`))).rejects.toThrow(
			/no longer matches line 2/,
		);
		expect(fs.get(PATH)).toBe(TEXT);
	});

	/**
	 * The measured defect: 13 of 15 corrupting trials refreshed the tag correctly while reusing pre-shift line numbers.
	 * The tag proves the content; only the line hash proves where the numbers came from.
	 */
	it("rejects pre-shift numbers carried onto a correctly refreshed tag", async () => {
		const { patcher, snapshots, tag, fs } = setup();
		const staleHash = lineHashAt(TEXT.split("\n"), 4);
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nCUT 1`));
		const freshTag = snapshots.head(PATH)?.hash;
		expect(freshTag).not.toBe(tag);
		const shifted = fs.get(PATH) as string;
		await expect(patcher.apply(Patch.parse(`[${PATH}#${freshTag}]\nPUT 4#${staleHash}:\n+X`))).rejects.toThrow(
			/no longer matches line 4/,
		);
		expect(fs.get(PATH)).toBe(shifted);
	});

	it("rejects pre-shift numbers with a copied row on a fresh tag", async () => {
		const { patcher, snapshots, tag, fs } = setup();
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nCUT 1`));
		const freshTag = snapshots.head(PATH)?.hash;
		const shifted = fs.get(PATH) as string;
		await expect(patcher.apply(Patch.parse(`[${PATH}#${freshTag}]\nPUT 4:four\n+X`))).rejects.toThrow(
			/Anchor 4 expected "four", but found "five"/,
		);
		expect(fs.get(PATH)).toBe(shifted);
	});

	it("still applies a hashless anchor, so the property is not yet structural", async () => {
		const { patcher, tag, fs } = setup();
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2:\n+TWO`));
		expect(fs.get(PATH)).toBe("one\nTWO\nthree\nfour\nfive\n");
	});

	/**
	 * Read and search emit leading whitespace verbatim (`3:    body`), so a de-indented anchor is the model's own
	 * transcription slip, not a stale number. Accepted only when the trimmed text is unique in the file: with one
	 * candidate line there is no look-alike for a stale number to land on, which is all the exact check guarded.
	 */
	it("applies an indentation-only anchor when the trimmed line is unique in the file", async () => {
		const text = "head\n    body\ntail\n";
		const { patcher, tag, fs } = setup(text);
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2:body\n+    NEW`));
		expect(fs.get(PATH)).toBe("head\n    NEW\ntail\n");
	});

	it("refuses an indentation-only anchor when the trimmed line is not unique", async () => {
		const text = "if (a) {\n  x();\n}\nif (b) {\n    x();\n}\n";
		const { patcher, tag, fs } = setup(text);
		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 5:x();\n+    y();`))).rejects.toThrow(
			/differs from line 5 only by leading whitespace, but 2 lines in this file carry that same text/,
		);
		expect(fs.get(PATH)).toBe(text);
	});

	/** The silent-wrong shape, 52 of 220 trials: a stale number landing on a look-alike closer must still be refused. */
	it("refuses a stale number that lands on a same-text line at another indentation", async () => {
		const text = "outer {\n\tinner {\n\t\tcall();\n\t}\n}\n";
		const { patcher, tag, fs } = setup(text);
		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 5:\t}\n+ZAP`))).rejects.toThrow(
			/only by leading whitespace, but 2 lines in this file carry that same text/,
		);
		expect(fs.get(PATH)).toBe(text);
	});

	it("keeps the stale-anchor wording for a genuine content mismatch", async () => {
		const { patcher, tag, fs } = setup();
		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 2:four\n+X`))).rejects.toThrow(
			/Anchor 2 expected "four", but found "two"\. The file changed since you read that line/,
		);
		expect(fs.get(PATH)).toBe(TEXT);
	});

	it("rejects an anchor past the end of the file", async () => {
		const { patcher, tag } = setup();
		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nPUT 99#ab:\n+X`))).rejects.toThrow(/does not exist/);
	});

	it("carries hashes through range lowering, so both endpoints are verified", () => {
		const lines = TEXT.split("\n");
		const good = lineHashAt(lines, 2);
		const section = Patch.parseSingle(`[${PATH}#0A3B]\nPUT 2#${good}..4#ff:\n+X`);
		const coverage = anchorHashCoverage(section.edits);
		expect(coverage.hashed).toBeGreaterThanOrEqual(2);
		expect(() => section.applyTo(TEXT)).toThrow();
	});

	it("reports coverage so the supply rate is measurable", () => {
		const hashed = Patch.parseSingle(`[${PATH}#0A3B]\nCUT 2#ab`);
		expect(anchorHashCoverage(hashed.edits)).toEqual({ hashed: 1, total: 1 });
		const bare = Patch.parseSingle(`[${PATH}#0A3B]\nCUT 2`);
		expect(anchorHashCoverage(bare.edits)).toEqual({ hashed: 0, total: 1 });
	});
});
