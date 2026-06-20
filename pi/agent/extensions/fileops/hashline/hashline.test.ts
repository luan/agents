import { describe, expect, it } from "bun:test";
import { applyEdits } from "./apply";
import { hasBlockEdit, resolveBlockEdits } from "./block";
import { buildCompactDiffPreview, generateNumberedDiff } from "./diff-preview";
import { InMemoryFilesystem } from "./fs";
import { Patch } from "./input";
import { HEADTAIL_DRIFT_WARNING } from "./messages";
import { MismatchError } from "./mismatch";
import { parsePatch, parsePatchStreaming } from "./parser";
import { Patcher } from "./patcher";
import { Recovery } from "./recovery";
import { InMemorySnapshotStore, type ObservedLines } from "./snapshots";
import type { BlockResolution, BlockResolver, Edit, SyntaxValidator } from "./types";

function apply(
	text: string,
	diff: string,
	options: { autoDropPureInsertDuplicates?: boolean } = {},
): { text: string; warnings: string[] } {
	const { edits, warnings } = parsePatch(diff);
	const result = applyEdits(text, edits, options);
	return { text: result.text, warnings: [...warnings, ...(result.warnings ?? [])] };
}

function record(store: InMemorySnapshotStore, path: string, text: string, observedLines?: ObservedLines): string {
	return store.record(path, text, observedLines);
}

/** A tag the store can never have minted: flip the first hex digit of a real one. */
function unmintedTag(store: InMemorySnapshotStore, path: string): string {
	const minted = record(store, path, "decoy-content-for-tag\n");
	const flipped = minted[0] === "F" ? "0" : "F";
	return `${flipped}${minted.slice(1)}`;
}

describe("hashline verb grammar", () => {
	it("replaces a concrete range with literal body rows in textual order", () => {
		expect(apply("a\nb\nc", "replace 2..2:\n+before\n+after").text).toBe("a\nbefore\nafter\nc");
	});

	it("deletes a single source line and a concrete range", () => {
		expect(apply("a\nb\nc", "delete 2").text).toBe("a\nc");
		expect(apply("a\nb\nc\nd", "delete 2..3").text).toBe("a\nd");
	});

	it("inserts before and after concrete anchors", () => {
		expect(apply("a\nb\nc", "insert before 2:\n+before\ninsert after 2:\n+after").text).toBe(
			"a\nbefore\nb\nafter\nc",
		);
	});

	it("inserts at head and tail", () => {
		expect(apply("a\nb", "insert head:\n+HEAD").text).toBe("HEAD\na\nb");
		expect(apply("a\nb", "insert tail:\n+TAIL").text).toBe("a\nb\nTAIL");
	});

	it("inserts after the final line without falling off the file", () => {
		expect(apply("aaa\nbbb\nccc", "insert after 3:\n+tail").text).toBe("aaa\nbbb\nccc\ntail");
	});

	it("accepts single-number replace and delete shorthand", () => {
		expect(apply("a\nb\nc\nd\ne", "replace 2:\n+X").text).toBe("a\nX\nc\nd\ne");
		expect(apply("a\nb\nc\nd\ne", "delete 2").text).toBe("a\nc\nd\ne");
	});

	it("accepts alternate replace range separators and missing colon", () => {
		for (const header of ["replace 2-3:", "replace 2…3:", "replace 2 3:", "replace 2..3"]) {
			expect(apply("a\nb\nc\nd\ne", `${header}\n+X`).text).toBe("a\nX\nd\ne");
		}
	});

	it("accepts missing colon on insert headers", () => {
		expect(apply("a\nb\nc", "insert before 2\n+X").text).toBe("a\nX\nb\nc");
		expect(apply("a\nb\nc", "insert head\n+X").text).toBe("X\na\nb\nc");
	});

	it("validates insert anchors against file bounds", () => {
		expect(() => apply("a\nb", "insert before 4:\n+x")).toThrow(/Line 4 does not exist/);
	});

	it("treats an empty replace hunk as a delete and rejects empty inserts", () => {
		expect(apply("a\nb\nc", "replace 2..2:").text).toBe("a\nc");
		expect(() => apply("a\nb", "insert head:")).toThrow(/needs at least one/);
		expect(() => apply("a\nb", "insert tail:")).toThrow(/needs at least one/);
	});

	it("preserves explicit blank replacement rows", () => {
		expect(apply("a\nb\nc", "replace 2..2:\n+\n+").text).toBe("a\n\n\nc");
		expect(apply("a\nb\nc", "replace 2..2:\n+first\n+\n+second").text).toBe("a\nfirst\n\nsecond\nc");
	});

	it("preserves whitespace-bearing and sigil-leading payload exactly", () => {
		expect(apply("a", "replace 1..1:\n+\tconst x = 1;").text).toBe("\tconst x = 1;");
		expect(apply("a", "replace 1..1:\n+|literal\n+^literal").text).toBe("|literal\n^literal");
	});

	it("allows literal text beginning with - or + when prefixed with +", () => {
		expect(apply("a\nb\nc", "replace 2..2:\n+-literal\n++plus").text).toBe("a\n-literal\n+plus\nc");
	});

	it("range ends before it starts is rejected", () => {
		expect(() => apply("a\nb\nc", "replace 3..2:\n+X")).toThrow(/ends before it starts/);
	});

	it("does not flush a trailing streaming pending empty replace hunk", () => {
		expect(parsePatchStreaming("replace 5..5:\n").edits).toEqual([]);
	});

	it("flushes a streaming empty replace hunk when another hunk starts", () => {
		const { edits } = parsePatchStreaming("replace 2..2:\ninsert tail:\n");
		expect(edits).toEqual([{ kind: "delete", anchor: { line: 2 }, lineNum: 1, index: 0 }]);
	});

	it("flushes a trailing streaming delete hunk (deletes are complete without a body)", () => {
		const { edits } = parsePatchStreaming("delete 2..3\n");
		expect(edits.map((edit) => edit.kind)).toEqual(["delete", "delete"]);
	});
});

describe("hashline rejections", () => {
	it("rejects a bare single-number hunk header with verb guidance", () => {
		expect(() => apply("a\nb\nc", "2\n+B")).toThrow(/hunk headers need a verb/);
	});

	it("rejects a bare numeric range with verb guidance", () => {
		expect(() => apply("a\nb\nc", "2 3\n+X")).toThrow(/Hunk headers need a verb/);
	});

	it("rejects - body rows with a teaching error", () => {
		expect(() => apply("a\nb\nc", "replace 2..2:\n-old\n+new")).toThrow(/`-` rows are not valid/);
	});

	it("rejects delete with a body", () => {
		expect(() => apply("a\nb\nc", "delete 2\n+X")).toThrow(/does not take body rows/);
	});

	it("rejects delete with a colon", () => {
		expect(() => apply("a\nb\nc", "delete 2:\n+X")).toThrow(/has no colon/);
	});

	it("rejects apply_patch sentinels as contamination", () => {
		expect(() => apply("a\nb", "*** Update File: a.ts\nreplace 1..1:\n+x")).toThrow(/apply_patch sentinel/);
	});

	it("rejects unified-diff hunk headers as contamination", () => {
		expect(() => apply("a\nb\nc", "@@ -1,3 +1,3 @@\nreplace 2..2:\n+X")).toThrow(/unified-diff hunk header/);
	});

	it("treats top-level +TEXT as an orphan literal payload", () => {
		expect(() => apply("a\nb", "+const X = 1;\nreplace 2..2:\n+x")).toThrow(
			/payload line has no preceding hunk header/,
		);
	});

	it("rejects overlapping replacement ranges", () => {
		expect(() => apply("a\nb\nc\nd\ne", "replace 2..4:\n+X\nreplace 3..5:\n+Y")).toThrow(
			/anchor line 3 is already targeted by another hunk on line 1/,
		);
	});

	it("teaches the verb grammar when legacy hunk forms appear", () => {
		expect(() => apply("a\nb\nc", "DELETE 2 3")).toThrow(/use `delete A\.\.B`/);
		expect(() => apply("a\nb\nc", "BEFORE 2\n+x")).toThrow(/use `insert before N:`/);
		expect(() => apply("a\nb\nc", "BOF\n+x")).toThrow(/insert head/);
		expect(() => apply("a\nb\nc\nd", "replace 2..2:\n&3..4")).toThrow(/repeat rows were removed/);
	});

	it("rejects delete block with a trailing colon", () => {
		expect(() => apply("a\nb\nc", "delete block 2:\n+X")).toThrow(/has no colon/);
	});

	it("rejects two hunks targeting the identical range", () => {
		expect(() => apply("a\nb\nc", "replace 2..2:\n+X\nreplace 2..2:\n+Y")).toThrow(
			/already targeted by another hunk/,
		);
	});
});

describe("hashline leniency", () => {
	it("auto-pipes a bare body row while warning", () => {
		const result = apply("a\nb\nc", "replace 2..2:\n  hello");
		expect(result.text).toBe("a\n  hello\nc");
		expect(result.warnings.join("\n")).toMatch(/Auto-prefixed bare body row/);
	});

	it("strips read-output line-number prefixes from auto-piped bare body rows", () => {
		const result = apply("a\nb\nc", "replace 2..2:\n2:hello");
		expect(result.text).toBe("a\nhello\nc");
		expect(result.warnings.join("\n")).toMatch(/Auto-prefixed bare body row/);
	});

	it("preserves +N: literal payloads without stripping", () => {
		const result = apply("a\nb\nc", "replace 2..2:\n+3:keep");
		expect(result.text).toBe("a\n3:keep\nc");
		expect(result.warnings).toEqual([]);
	});

	it("strips only one N: prefix from bare body rows", () => {
		expect(apply("a\nb\nc", "replace 2..2:\n2:42:hello").text).toBe("a\n42:hello\nc");
	});

	it("strips N: prefixes only when every bare body row carries one", () => {
		expect(apply("a\nb\nc\nd", "replace 2..3:\n2:foo\n3:bar").text).toBe("a\nfoo\nbar\nd");
		expect(apply("a\nb\nc\nd", "replace 2..3:\n3:keep\nplain").text).toBe("a\n3:keep\nplain\nd");
	});

	it("strips copied read-output prefixes only inside pasted bare body rows", () => {
		const result = apply("a\nb\nc\nd\ne", "replace 2..4:\n+line one\n3:line two");
		expect(result.text).toBe("a\nline one\nline two\ne");
	});

	it("terminates parsing at *** Abort without surfacing a warning", () => {
		const { edits, warnings } = parsePatch("insert after 1:\n+HELLO\n*** Abort\ninsert after 99:\n+never");
		expect(edits).toHaveLength(1);
		expect(warnings).toEqual([]);
	});

	it("keeps pure-insert context echoes literal", () => {
		expect(apply("aaa\nbbb\nccc", "insert tail:\n+bbb\n+ccc\n+NEW").text).toBe("aaa\nbbb\nccc\nbbb\nccc\nNEW");
	});
});

describe("hashline section headers", () => {
	it("extracts path, snapshot tag, and diff body from bracket headers", () => {
		const patch = Patch.parse("[src/foo.ts#1A2B]\nreplace 2..2:\n+BBB");
		expect(patch.sections).toHaveLength(1);
		expect(patch.sections[0].path).toBe("src/foo.ts");
		expect(patch.sections[0].fileHash).toBe("1A2B");
	});

	it("normalizes lowercase section tags while parsing", () => {
		expect(Patch.parseSingle("[a.ts#1a2b]\nreplace 1..1:\n+x").fileHash).toBe("1A2B");
	});

	it("rejects malformed snapshot tags", () => {
		for (const header of ["[a.ts#1A2]", "[a.ts#1A2G]", "[a.ts#1A2B5]"]) {
			expect(() => Patch.parse(`${header}\nreplace 1..1:\n+x`)).toThrow(/Input header must be/);
		}
	});

	it("recovers apply_patch-contaminated headers", () => {
		const section = Patch.parseSingle("[*** Update File:foo.ts#C0B5]\nreplace 1..1:\n+x");
		expect(section.path).toBe("foo.ts");
		expect(section.fileHash).toBe("C0B5");
	});

	it("rejects conflicting snapshot tags for the same path", () => {
		expect(() => Patch.parse("[a.ts#0A3B]\nreplace 1..1:\n+x\n[a.ts#1F7C]\nreplace 2..2:\n+y")).toThrow(
			/Conflicting hashline snapshot tags/,
		);
	});

	it("requires a bracket header on the first non-blank line with a verb-op example", () => {
		expect(() => Patch.parse("delete 38..40")).toThrow(/input must begin with "\[PATH#HASH\]"/);
		expect(() => Patch.parse("delete 38..40")).toThrow(/\[src\/foo\.ts#1A2B\]/);
	});

	it("drops a trailing header without operations", () => {
		const patch = Patch.parse("[a.ts#0A3B]\nreplace 1..1:\n+x\n[b.ts#1F7C]");
		expect(patch.sections.map((section) => section.path)).toEqual(["a.ts"]);
	});

	it("stops the splitter at *** Abort before later sections", () => {
		const patch = Patch.parse(
			"[a.ts#0A3B]\ninsert after 1:\n+HELLO\n*** Abort\n[b.ts#1F7C]\ninsert after 9:\n+never",
		);
		expect(patch.sections.map((section) => section.path)).toEqual(["a.ts"]);
		expect(patch.sections[0].edits).toHaveLength(1);
	});

	it("skips leading blank lines and the begin-patch envelope", () => {
		const section = Patch.parseSingle("\n\n*** Begin Patch\n[a.ts#0A3B]\ndelete 1\n*** End Patch\n");
		expect(section.path).toBe("a.ts");
		expect(section.edits).toHaveLength(1);
	});

	it("merges sections targeting the same path into one batch", () => {
		const patch = Patch.parse("[a.ts#0A3B]\nreplace 1..1:\n+x\n[b.ts#1F7C]\ndelete 1\n[a.ts#0A3B]\ndelete 2");
		expect(patch.sections.map((section) => section.path)).toEqual(["a.ts", "b.ts"]);
		expect(patch.sections[0].diff).toContain("delete 2");
	});
});

describe("pure insert boundary repair", () => {
	it("auto-drops a duplicated single structural suffix by default", () => {
		const result = apply("if ok {\n\tkeep();\n}", "insert before 3:\n+\tadded();\n+}");
		expect(result.text).toBe("if ok {\n\tkeep();\n\tadded();\n}");
		expect(result.warnings.join("\n")).toMatch(/Auto-dropped 1 duplicate line\(s\) at the end of insert/);
	});

	it("auto-drops a duplicated single structural prefix by default", () => {
		const result = apply("});\nnext();", "insert after 1:\n+});\n+added();");
		expect(result.text).toBe("});\nadded();\nnext();");
		expect(result.warnings.join("\n")).toMatch(/Auto-dropped 1 duplicate line\(s\) at the start of insert/);
	});

	it("preserves generic pure-insert duplicate boundaries by default", () => {
		const result = apply("aaa\nbbb\nccc", "insert after 2:\n+aaa\n+bbb\n+NEW");
		expect(result.text).toBe("aaa\nbbb\naaa\nbbb\nNEW\nccc");
		expect(result.warnings).toEqual([]);
	});

	it("auto-drops generic pure-insert duplicate boundaries when enabled", () => {
		const result = apply("aaa\nbbb\nccc\nddd", "insert after 2:\n+aaa\n+bbb\n+NEW\n+ccc\n+ddd", {
			autoDropPureInsertDuplicates: true,
		});
		expect(result.text).toBe("aaa\nbbb\nNEW\nccc\nddd");
		expect(result.warnings.join("\n")).toMatch(/Auto-dropped 2 duplicate line\(s\) at the start of insert/);
		expect(result.warnings.join("\n")).toMatch(/Auto-dropped 2 duplicate line\(s\) at the end of insert/);
	});
});

describe("replacement boundary repair", () => {
	it("auto-absorbs duplicated multiline suffix boundaries during replacement", () => {
		const file = [
			"import React from 'react';",
			"import { Composition } from 'remotion';",
			"",
			"export const RemotionRoot: React.FC = () => {",
			"\treturn (",
			"\t\t<>",
			"\t\t\t<Composition",
			'\t\t\t\tid="Main"',
			"\t\t\t\tcomponent={Main}",
			"\t\t\t\tdurationInFrames={300}",
			"\t\t\t\tfps={30}",
			"\t\t\t\twidth={1920}",
			"\t\t\t\theight={1080}",
			"\t\t\t/>",
			"\t\t</>",
			"\t);",
			"};",
		].join("\n");
		const diff = [
			"replace 7..14:",
			"+\t\t\t<Composition",
			'+\t\t\t\tid="Main"',
			"+\t\t\t\tcomponent={Main}",
			"+\t\t\t\tdurationInFrames={600}",
			"+\t\t\t\tfps={30}",
			"+\t\t\t\twidth={1920}",
			"+\t\t\t\theight={1080}",
			"+\t\t\t/>",
			"+\t\t</>",
			"+\t);",
		].join("\n");
		const result = apply(file, diff);
		expect(result.text).toBe(file.replace("durationInFrames={300}", "durationInFrames={600}"));
		expect(result.warnings.join("\n")).toMatch(
			/dropped 2 duplicated trailing payload line\(s\) already present below the range/,
		);
	});

	it("auto-absorbs a single duplicated structural closer during replacement", () => {
		const file = ["it('a', () => {", "\tsetup();", "\trun();", "});", "after();"].join("\n");
		const result = apply(file, "replace 2..3:\n+\tsetup2();\n+\trun2();\n+});");
		expect(result.text).toBe(["it('a', () => {", "\tsetup2();", "\trun2();", "});", "after();"].join("\n"));
		expect(result.warnings.join("\n")).toMatch(
			/dropped 1 duplicated trailing payload line\(s\) already present below the range/,
		);
	});

	it("drops a duplicated structural opener when it exactly explains delimiter imbalance", () => {
		const file = [
			"class Renderer {",
			"\tprivate ready = false;",
			"\tplanRender(",
			"\t\ta: number,",
			"\t\tb: number,",
			"\t): Intent {",
			"\t\treturn intent(a, b);",
			"\t}",
			"}",
		].join("\n");
		const result = apply(
			file,
			"replace 4..6:\n+\tplanRender(\n+\t\ta: number,\n+\t\tb: number,\n+\t\tc: number,\n+\t): Intent {",
		);
		const lines = result.text.split("\n");
		expect(lines.filter((line) => line === "\tplanRender(")).toHaveLength(1);
		expect(result.text).toContain("c: number");
		expect(result.warnings.join("\n")).toMatch(
			/dropped 1 duplicated leading payload line\(s\) already present above the range/,
		);
	});

	it("keeps structural closing lines the replacement range deleted without restating", () => {
		const file = ["const handlers = {", "\ta() {", "\t\trun();", "\t},", "};"].join("\n");
		const result = apply(file, "replace 5..5:\n+\tb() {\n+\t\trun2();\n+\t},");
		expect(result.text).toBe(
			["const handlers = {", "\ta() {", "\t\trun();", "\t},", "\tb() {", "\t\trun2();", "\t},", "};"].join("\n"),
		);
		expect(result.warnings.join("\n")).toMatch(
			/kept 1 structural closing line\(s\) the range deleted without restating/,
		);
	});

	it("repairs single-line nonstructural boundary echoes when both sides are echoed", () => {
		const file = [
			"func _cmd_travel_homeworld():",
			"\tvar destination = get_homeworld()",
			"\ttravel_to(destination)",
			"\tprint_status()",
		].join("\n");
		const diff = [
			"replace 2..3:",
			"+func _cmd_travel_homeworld():",
			"+\tvar destination = find_homeworld()",
			"+\ttravel_to(destination)",
			"+\tprint_status()",
		].join("\n");
		const result = apply(file, diff);
		expect(result.text).toBe(
			[
				"func _cmd_travel_homeworld():",
				"\tvar destination = find_homeworld()",
				"\ttravel_to(destination)",
				"\tprint_status()",
			].join("\n"),
		);
		expect(result.warnings.join("\n")).toMatch(/replacement boundary echo/);
	});

	it("keeps single blank boundary echoes", () => {
		const file = ["function f() {", "", "\tfoo();", "", "}", "tail();"].join("\n");
		const result = apply(file, "replace 3..3:\n+\n+\tfoo2();\n+");
		expect(result.text).toBe(["function f() {", "", "", "\tfoo2();", "", "", "}", "tail();"].join("\n"));
		expect(result.warnings).toEqual([]);
	});

	it("keeps unresolved delimiter imbalance instead of inventing a repair", () => {
		const file = ["if (a) {", "\tfoo();", "}", "bar();"].join("\n");
		const result = apply(file, "replace 2..2:\n+if (a) {\n+\tif (b) {\n+\t\tfoo();");
		expect(result.text).toBe(["if (a) {", "if (a) {", "\tif (b) {", "\t\tfoo();", "}", "bar();"].join("\n"));
		expect(result.warnings).toEqual([]);
	});

	it("keeps boundary echoes when they would consume the whole payload", () => {
		const result = apply("A\nB\nold\nC\nD", "replace 3..3:\n+A\n+B\n+C\n+D");
		expect(result.text).toBe("A\nB\nA\nB\nC\nD\nC\nD");
		expect(result.warnings).toEqual([]);
	});

	it("keeps payloads made only of single lines matching both neighbors", () => {
		const result = apply("a\nold\nc", "replace 2..2:\n+a\n+c");
		expect(result.text).toBe("a\na\nc\nc");
		expect(result.warnings).toEqual([]);
	});

	it("keeps a balance-preserving replacement with a coincidental tail match", () => {
		const result = apply("foo();\nbar();\nbar();\nbaz();", "replace 2..2:\n+qux();\n+bar();");
		expect(result.text).toBe("foo();\nqux();\nbar();\nbar();\nbaz();");
		expect(result.warnings).toEqual([]);
	});

	it("keeps a balance-neutral duplicated statement", () => {
		const result = apply("a = 1;\nb = 2;\nc = 3;", "replace 1..1:\n+a = 1;\n+b = 2;");
		expect(result.text).toBe("a = 1;\nb = 2;\nb = 2;\nc = 3;");
		expect(result.warnings).toEqual([]);
	});

	it("ignores brackets inside string literals when counting balance", () => {
		const file = ['const a = "}";', "const b = 1;", "done();"].join("\n");
		const result = apply(file, 'replace 2..2:\n+const b = "}}}";');
		expect(result.text).toBe(['const a = "}";', 'const b = "}}}";', "done();"].join("\n"));
		expect(result.warnings).toEqual([]);
	});

	it("composes OMP-style boundary absorption through stale-snapshot recovery", () => {
		const PATH = "/repo/spec.ts";
		const snapshotText = [
			"describe('suite', () => {",
			"",
			"it('a', () => {",
			"\tsetup();",
			"\trun();",
			"});",
			"",
			"function fillerOne() {",
			"\treturn 1;",
			"}",
			"",
			"function fillerTwo() {",
			"\treturn 2;",
			"}",
			"const tail = 0;",
		].join("\n");
		const currentText = snapshotText.replace("const tail = 0;", "const tail = 99;");
		const store = new InMemorySnapshotStore();
		const fileHash = record(store, PATH, snapshotText);
		const { edits } = parsePatch("replace 4..5:\n+\tsetup2();\n+\trun2();\n+});");
		const recovered = new Recovery(store).tryRecover({ path: PATH, currentText, fileHash, edits });
		expect(recovered).not.toBeNull();
		const lines = (recovered?.text ?? "").split("\n");
		expect(lines.filter((line) => line.trim() === "});")).toHaveLength(1);
		expect(recovered?.text).toContain("setup2();");
		expect(recovered?.text).toContain("const tail = 99;");
		expect(recovered?.warnings?.join("\n")).toMatch(
			/dropped 1 duplicated trailing payload line\(s\) already present below the range/,
		);
	});
});

describe("after-insert landing correction", () => {
	it("slides a shallower insert after anchor past structural closers", () => {
		const file = ["function f() {", "    if (x) {", "        a();", "    }", "    b();", "}", ""].join("\n");
		const result = apply(file, "insert after 3:\n+    c();");
		expect(result.text).toBe(
			["function f() {", "    if (x) {", "        a();", "    }", "    c();", "    b();", "}", ""].join("\n"),
		);
		expect(result.warnings.join("\n")).toMatch(/moved past 1 closing line to after line 4/);
	});

	it("does not slide when another hunk targets the closer", () => {
		const file = ["function f() {", "    if (x) {", "        a();", "    }", "    b();", "}", ""].join("\n");
		const result = apply(file, "insert after 3:\n+    c();\ndelete 4");
		expect(result.text).toBe(
			["function f() {", "    if (x) {", "        a();", "    c();", "    b();", "}", ""].join("\n"),
		);
		expect(result.warnings).toEqual([]);
	});
});

const stubResolver: BlockResolver = ({ line }) => ({ start: line, end: line + 1 });

function normalizeEdits(edits: readonly Edit[]): unknown[] {
	return edits.map((edit) => {
		if (edit.kind === "insert")
			return { kind: edit.kind, cursor: edit.cursor, text: edit.text, mode: edit.mode, blockStart: edit.blockStart };
		if (edit.kind === "delete") return { kind: edit.kind, anchor: edit.anchor };
		return { kind: edit.kind, anchor: edit.anchor };
	});
}

describe("hashline block edits", () => {
	it("parses replace block N: into a single deferred block edit", () => {
		const { edits } = parsePatch("replace block 2:\n+A\n+B");
		expect(edits).toHaveLength(1);
		const edit = edits[0];
		if (edit.kind !== "block") throw new Error("expected block edit");
		expect(edit.anchor.line).toBe(2);
		expect(edit.payloads).toEqual(["A", "B"]);
	});

	it("still parses a literal replace range when the block sub-keyword is absent", () => {
		const { edits } = parsePatch("replace 2..3:\n+A");
		expect(hasBlockEdit(edits)).toBe(false);
		expect(edits.some((edit) => edit.kind === "delete")).toBe(true);
	});

	it("rejects a replace block hunk with no body row", () => {
		expect(() => parsePatch("replace block 2:")).toThrow(/`replace block N:` needs at least one/);
	});

	it("parses delete block N into a block edit with no payloads", () => {
		const { edits } = parsePatch("delete block 2");
		expect(edits).toHaveLength(1);
		const edit = edits[0];
		if (edit.kind !== "block") throw new Error("expected block edit");
		expect(edit.payloads).toEqual([]);
	});

	it("rejects body rows under delete block N", () => {
		expect(() => parsePatch("delete block 2\n+X")).toThrow(/`delete block N` does not take body rows/);
	});

	it("parses insert after block N into an insert-after block edit", () => {
		const { edits } = parsePatch("insert after block 2:\n+A");
		expect(edits).toHaveLength(1);
		const edit = edits[0];
		if (edit.kind !== "block") throw new Error("expected block edit");
		expect(edit.mode).toBe("insert_after");
		expect(edit.payloads).toEqual(["A"]);
	});

	it("rejects insert after block N with no body rows", () => {
		expect(() => parsePatch("insert after block 2:")).toThrow(/`insert` needs at least one/);
	});

	it("expands a block edit exactly like the equivalent replace range", () => {
		const blockEdits = resolveBlockEdits(
			parsePatch("replace block 2:\n+A\n+B").edits,
			"ignored",
			"x.ts",
			stubResolver,
		);
		const rangeEdits = parsePatch("replace 2..3:\n+A\n+B").edits;
		expect(normalizeEdits(blockEdits)).toEqual(normalizeEdits(rangeEdits));
		expect(hasBlockEdit(blockEdits)).toBe(false);
	});

	it("expands a delete-block edit into pure deletes", () => {
		const resolved = resolveBlockEdits(parsePatch("delete block 2").edits, "ignored", "x.ts", stubResolver);
		expect(resolved.every((edit) => edit.kind === "delete")).toBe(true);
		expect(resolved.map((edit) => (edit.kind === "delete" ? edit.anchor.line : 0))).toEqual([2, 3]);
	});

	it("expands insert-after-block to after-anchor inserts at the resolved block end", () => {
		const resolved = resolveBlockEdits(
			parsePatch("insert after block 2:\n+A").edits,
			"ignored",
			"x.ts",
			stubResolver,
			{
				onResolved: (resolution) =>
					expect(resolution).toEqual({ anchorLine: 2, start: 2, end: 3, op: "insert_after" }),
			},
		);
		expect(normalizeEdits(resolved)).toEqual([
			{
				kind: "insert",
				cursor: { kind: "after_anchor", anchor: { line: 3 } },
				text: "A",
				mode: undefined,
				blockStart: 2,
			},
		]);
	});

	it("lowers unresolvable insert-after-block to plain insert-after with a warning", () => {
		const warnings: string[] = [];
		const resolved = resolveBlockEdits(
			parsePatch("insert after block 2:\n+A").edits,
			"one\ntwo",
			"x.ts",
			() => null,
			{
				onWarning: (message) => warnings.push(message),
			},
		);
		expect(normalizeEdits(resolved)).toEqual([
			{
				kind: "insert",
				cursor: { kind: "after_anchor", anchor: { line: 2 } },
				text: "A",
				mode: undefined,
				blockStart: undefined,
			},
		]);
		expect(warnings.join("\n")).toMatch(/applied as plain `insert after 2:`/);
	});

	it("lowers insert-after-block only for no-block resolver failures", () => {
		const warnings: string[] = [];
		const noBlockResolver: BlockResolver = () => ({ reason: "no_block" });
		const resolved = resolveBlockEdits(
			parsePatch("insert after block 2:\n+A").edits,
			"one\ntwo",
			"x.ts",
			noBlockResolver,
			{ onWarning: (message) => warnings.push(message) },
		);

		expect(normalizeEdits(resolved)).toEqual([
			{
				kind: "insert",
				cursor: { kind: "after_anchor", anchor: { line: 2 } },
				text: "A",
				mode: undefined,
				blockStart: undefined,
			},
		]);
		expect(warnings.join("\n")).toMatch(/applied as plain `insert after 2:`/);
	});

	it("rejects insert-after-block when the resolver reports syntax or parser failures", () => {
		for (const [reason, pattern] of [
			["syntax_error", /syntax error/],
			["parser_unavailable", /parser unavailable/],
			["unsupported_language", /unsupported language/],
		] as const) {
			const resolver: BlockResolver = () => ({ reason });
			expect(() =>
				resolveBlockEdits(parsePatch("insert after block 2:\n+A").edits, "one\ntwo", "x.ts", resolver),
			).toThrow(pattern);
		}
	});

	it("rejects insert-after-block when no resolver is wired", () => {
		expect(() =>
			resolveBlockEdits(parsePatch("insert after block 2:\n+A").edits, "one\ntwo", "x.ts", undefined),
		).toThrow(/parser unavailable/);
	});

	it("returns the input untouched when there are no block edits", () => {
		const { edits } = parsePatch("replace 2..2:\n+A");
		expect(resolveBlockEdits(edits, "ignored", "x.ts", stubResolver)).toBe(edits);
	});

	it("throws a parser-unavailable diagnostic when no resolver is wired", () => {
		expect(() => resolveBlockEdits(parsePatch("replace block 2:\n+A").edits, "ignored", "x.ts", undefined)).toThrow(
			/parser unavailable/,
		);
	});

	it("drops an unresolvable block edit in drop mode", () => {
		const resolved = resolveBlockEdits(parsePatch("replace block 2:\n+A").edits, "ignored", "x.ts", () => null, {
			onUnresolved: "drop",
		});
		expect(resolved).toHaveLength(0);
	});

	it("throws a no-block diagnostic in throw mode when the resolver returns null", () => {
		expect(() => resolveBlockEdits(parsePatch("replace block 7:\n+A").edits, "ignored", "x.ts", () => null)).toThrow(
			/no syntactic block begins/,
		);
	});

	it("fires onResolved with the resolved span for replace and delete blocks", () => {
		const seen: BlockResolution[] = [];
		resolveBlockEdits(parsePatch("replace block 2:\n+A\ndelete block 5").edits, "ignored", "x.ts", stubResolver, {
			onResolved: (resolution) => seen.push(resolution),
		});
		expect(seen).toEqual([
			{ anchorLine: 2, start: 2, end: 3, op: "replace" },
			{ anchorLine: 5, start: 5, end: 6, op: "delete" },
		]);
	});

	it("does not fire onResolved for a dropped unresolvable block", () => {
		const seen: BlockResolution[] = [];
		resolveBlockEdits(parsePatch("replace block 2:\n+A").edits, "ignored", "x.ts", () => null, {
			onUnresolved: "drop",
			onResolved: (resolution) => seen.push(resolution),
		});
		expect(seen).toEqual([]);
	});

	it("rejects a block edit that resolves to a single line", () => {
		const singleLineResolver: BlockResolver = ({ line }) => ({ start: line, end: line });
		expect(() =>
			resolveBlockEdits(parsePatch("insert after block 2:\n+X").edits, "a\nb\nc", "x.ts", singleLineResolver),
		).toThrow(/single-line block/);
	});

	it("drops a single-line block resolution in drop mode", () => {
		const singleLineResolver: BlockResolver = ({ line }) => ({ start: line, end: line });
		const resolved = resolveBlockEdits(
			parsePatch("replace block 2:\n+X").edits,
			"a\nb\nc",
			"x.ts",
			singleLineResolver,
			{
				onUnresolved: "drop",
			},
		);
		expect(resolved).toHaveLength(0);
	});

	it("applyTo resolves a block edit and matches the equivalent replace", () => {
		const text = "function x() {\n  if (y) {\n  }\n}\n";
		const block = Patch.parseSingle("[x.ts#0A3B]\nreplace block 2:\n+  if (y || z) {\n+  }");
		const range = Patch.parseSingle("[x.ts#0A3B]\nreplace 2..3:\n+  if (y || z) {\n+  }");
		expect(block.applyTo(text, stubResolver).text).toBe(range.applyTo(text).text);
	});

	it("applyTo throws when a block edit has no resolver", () => {
		const section = Patch.parseSingle("[x.ts#0A3B]\nreplace block 2:\n+X");
		expect(() => section.applyTo("a\nb\nc")).toThrow(/replace block/);
	});

	it("applyPartialTo drops an unresolvable block edit instead of throwing", () => {
		const section = Patch.parseSingle("[x.ts#0A3B]\nreplace block 2:\n+X");
		expect(section.applyPartialTo("a\nb\nc").text).toBe("a\nb\nc");
	});

	it("pulls a deeper insert-after-block body inside trailing block closers", () => {
		const text = ["function f() {", "    afterEach(() => {", "        destroy();", "    });", "}", ""].join("\n");
		const section = Patch.parseSingle("[x.ts#0A3B]\ninsert after block 2:\n+        setup();");
		const result = section.applyTo(text, ({ line }) => ({ start: line, end: line + 2 }));
		expect(result.text).toBe(
			["function f() {", "    afterEach(() => {", "        destroy();", "        setup();", "    });", "}", ""].join(
				"\n",
			),
		);
		expect(result.warnings?.join("\n")).toMatch(/placed inside the block, after line 3/);
	});

	it("applies a block edit on the tag-match path and surfaces the resolved span", async () => {
		const PATH = "x.ts";
		const text = "function x() {\n  if (y) {\n  }\n}\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });
		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace block 2:\n+  if (y || z) {\n+  }`));
		expect(result.sections[0].op).toBe("update");
		expect(fs.get(PATH)).toBe("function x() {\n  if (y || z) {\n  }\n}\n");
		expect(result.sections[0].blockResolutions).toEqual([{ anchorLine: 2, start: 2, end: 3, op: "replace" }]);
	});

	it("applies a delete-block edit on the tag-match path", async () => {
		const PATH = "x.ts";
		const text = "function x() {\n  if (y) {\n  }\n}\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\ndelete block 2`));
		expect(fs.get(PATH)).toBe("function x() {\n}\n");
	});

	it("resolves against the tagged snapshot and recovers onto drifted content", async () => {
		const PATH = "x.ts";
		const snapshotText = "line0\nline1\nline2\nline3\nline4\n";
		const liveText = "line0\nline1\nline2\nline3\nline4\nline5\n";
		const fs = new InMemoryFilesystem([[PATH, liveText]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, snapshotText);
		const seenTexts: string[] = [];
		const recordingResolver: BlockResolver = ({ line, text }) => {
			seenTexts.push(text);
			return { start: line, end: line + 1 };
		};
		const patcher = new Patcher({ fs, snapshots, blockResolver: recordingResolver });
		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace block 2:\n+NEW`));
		expect(seenTexts).toEqual([snapshotText]);
		expect(fs.get(PATH)).toBe("line0\nNEW\nline3\nline4\nline5\n");
		expect(result.sections[0].warnings.join("\n")).toMatch(/Recovered/);
		expect(result.sections[0].blockResolutions).toBeUndefined();
	});

	it("rejects a drifted block edit whose tagged snapshot is unavailable", async () => {
		const PATH = "x.ts";
		const liveText = "line0\nline1\nline2\nline3\n";
		const fs = new InMemoryFilesystem([[PATH, liveText]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = unmintedTag(snapshots, PATH);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });
		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace block 2:\n+NEW`))).rejects.toThrow(
			MismatchError,
		);
		expect(fs.get(PATH)).toBe(liveText);
	});

	it("throws a block-unresolved error through the patcher and leaves the file untouched", async () => {
		const PATH = "x.ts";
		const text = "function x() {\n  if (y) {\n  }\n}\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: () => null });
		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace block 2:\n+NEW`))).rejects.toThrow(
			/no syntactic block begins/,
		);
		expect(fs.get(PATH)).toBe(text);
	});
});

describe("hashline patcher contracts", () => {
	it("requires a snapshot store at construction", () => {
		const fs = new InMemoryFilesystem();
		expect(() => new Patcher({ fs } as never)).toThrow(/requires a SnapshotStore/);
	});

	it("applies when the section tag names the live content and mints a fresh tag", async () => {
		const PATH = "a.ts";
		const fs = new InMemoryFilesystem([[PATH, "before\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, "before\n");
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace 1..1:\n+after`));
		expect(result.sections[0].op).toBe("update");
		expect(result.sections[0].fileHash).toMatch(/^[0-9A-F]{4}$/);
		expect(result.sections[0].header).toBe(`[${PATH}#${result.sections[0].fileHash}]`);
		expect(fs.get(PATH)).toBe("after\n");
	});

	it("applies full-file tagged edits when the file content still matches", async () => {
		const PATH = "a.ts";
		const text = "one\ntwo\nthree\nfour\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace 2..2:\n+TWO`));
		expect(fs.get(PATH)).toBe("one\nTWO\nthree\nfour\n");
	});

	it("rejects anchored edits on lines the read never displayed", async () => {
		const PATH = "a.ts";
		const text = "one\ntwo\nthree\nfour\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\ninsert after 4:\n+FIVE`))).rejects.toThrow(
			/exact target range/,
		);
		expect(fs.get(PATH)).toBe(text);
	});

	it("widens observed-line coverage when identical content is re-read", async () => {
		const PATH = "a.ts";
		const text = "one\ntwo\nthree\nfour\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text, [1, 2]);
		record(snapshots, PATH, text, [4]);
		const patcher = new Patcher({ fs, snapshots });

		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\ninsert after 4:\n+FIVE`));
		expect(fs.get(PATH)).toBe("one\ntwo\nthree\nfour\nFIVE\n");
	});

	it("rejects edits anchored only to synthetic context lines", async () => {
		const PATH = "a.ts";
		const text = "function x() {\n  return 1;\n}\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text, { explicit: [2], synthetic: [1, 3] });
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\ninsert after 3:\n+const y = 2;`))).rejects.toThrow(
			/synthetic context/i,
		);
		expect(fs.get(PATH)).toBe(text);
	});

	it("allows edits anchored to synthetic context lines only when policy permits it", async () => {
		const PATH = "a.ts";
		const text = "function x() {\n  return 1;\n}\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text, { explicit: [2], synthetic: [1, 3] });
		const patcher = new Patcher({ fs, snapshots, allowSyntheticContextEdits: true });

		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\ninsert after 3:\n+const y = 2;`));
		expect(fs.get(PATH)).toBe("function x() {\n  return 1;\n}\nconst y = 2;\n");
	});

	it("rejects hashline edits that introduce syntax errors before writing", async () => {
		const PATH = "a.ts";
		const before = "const ok = 1;\n";
		const fs = new InMemoryFilesystem([[PATH, before]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, before);
		const syntaxValidator: SyntaxValidator = ({ text }) =>
			text.includes("const =") ? { kind: "invalid", errorCount: 1 } : { kind: "valid", errorCount: 0 };
		const patcher = new Patcher({ fs, snapshots, syntaxValidator });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace 1..1:\n+const = ;`))).rejects.toThrow(
			/syntax error/i,
		);
		expect(fs.get(PATH)).toBe(before);
	});

	it("allows edits to already-broken files when syntax errors do not increase", async () => {
		const PATH = "a.ts";
		const before = "const = ;\n";
		const fs = new InMemoryFilesystem([[PATH, before]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, before);
		const syntaxValidator: SyntaxValidator = ({ text }) => ({
			kind: "invalid",
			errorCount: text.split("const =").length - 1,
		});
		const patcher = new Patcher({ fs, snapshots, syntaxValidator });

		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\ninsert tail:\n+// still one syntax error`));
		expect(fs.get(PATH)).toBe("const = ;\n// still one syntax error\n");
	});

	it("rejects edits to already-broken files when syntax errors increase", async () => {
		const PATH = "a.ts";
		const before = "const = ;\n";
		const fs = new InMemoryFilesystem([[PATH, before]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, before);
		const syntaxValidator: SyntaxValidator = ({ text }) => ({
			kind: "invalid",
			errorCount: text.split("const =").length - 1,
		});
		const patcher = new Patcher({ fs, snapshots, syntaxValidator });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\ninsert tail:\n+const = ;`))).rejects.toThrow(
			/syntax error/i,
		);
		expect(fs.get(PATH)).toBe(before);
	});

	it("does not block hashline edits for unsupported syntax-validation languages", async () => {
		const PATH = "a.txt";
		const before = "before\n";
		const fs = new InMemoryFilesystem([[PATH, before]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, before);
		const syntaxValidator: SyntaxValidator = () => ({ kind: "unsupported_language" });
		const patcher = new Patcher({ fs, snapshots, syntaxValidator });

		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace 1..1:\n+after`));
		expect(fs.get(PATH)).toBe("after\n");
	});

	it("refuses with a mismatch when the recorded version no longer matches live content", async () => {
		const PATH = "a.ts";
		const fs = new InMemoryFilesystem([[PATH, "drifted\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, "before\n");
		const patcher = new Patcher({ fs, snapshots });
		const failure = patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace 1..1:\n+after`));
		await expect(failure).rejects.toThrow(MismatchError);
		await expect(failure).rejects.toThrow(/file changed between read and edit/);
		expect(fs.get(PATH)).toBe("drifted\n");
	});

	it("refuses with a not-from-this-session diagnostic when the tag was never recorded", async () => {
		const PATH = "a.ts";
		const fs = new InMemoryFilesystem([[PATH, "content\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const bogus = unmintedTag(snapshots, PATH);
		const patcher = new Patcher({ fs, snapshots });
		const failure = patcher.apply(Patch.parse(`[${PATH}#${bogus}]\nreplace 1..1:\n+after`));
		await expect(failure).rejects.toThrow(/is not from this session/);
		await expect(failure).rejects.toThrow(/never invent the tag/);
		expect(fs.get(PATH)).toBe("content\n");
	});

	it("rejects a hashless head or tail insert", async () => {
		const PATH = "a.ts";
		const fs = new InMemoryFilesystem([[PATH, "a\nb\n"]]);
		const patcher = new Patcher({ fs, snapshots: new InMemorySnapshotStore() });
		const failure = patcher.apply(Patch.parse(`[${PATH}]\ninsert tail:\n+c`));
		await expect(failure).rejects.toThrow(/Missing hashline snapshot tag/);
		await expect(failure).rejects.toThrow(/write tool/);
		expect(fs.get(PATH)).toBe("a\nb\n");
	});

	it("hard-rejects an anchored edit that omits the snapshot tag", async () => {
		const PATH = "a.ts";
		const fs = new InMemoryFilesystem([[PATH, "a\nb\n"]]);
		const patcher = new Patcher({ fs, snapshots: new InMemorySnapshotStore() });
		await expect(patcher.apply(Patch.parse(`[${PATH}]\nreplace 1..1:\n+X`))).rejects.toThrow(
			/Missing hashline snapshot tag/,
		);
	});

	it("rejects a tagged edit whose target file does not exist", async () => {
		const fs = new InMemoryFilesystem();
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });
		const failure = patcher.apply(Patch.parse("[ghost.ts#0A3B]\ninsert tail:\n+c"));
		await expect(failure).rejects.toThrow(/File not found/);
		await expect(failure).rejects.toThrow(/write tool/);
	});

	it("applies a head or tail insert with a stale tag and warns instead of hard-failing", async () => {
		const PATH = "a.ts";
		const fs = new InMemoryFilesystem([[PATH, "live\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, "older\n");
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\ninsert tail:\n+c`));
		expect(result.sections[0].op).toBe("update");
		expect(fs.get(PATH)).toBe("live\nc\n");
		expect(result.sections[0].warnings).toContain(HEADTAIL_DRIFT_WARNING);
	});

	it("does not warn when a head or tail insert carries the live tag", async () => {
		const PATH = "a.ts";
		const fs = new InMemoryFilesystem([[PATH, "live\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, "live\n");
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\ninsert tail:\n+c`));
		expect(result.sections[0].warnings).toEqual([]);
	});

	it("returns a noop section result for a single-section no-change apply", async () => {
		const PATH = "a.ts";
		const text = "same\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text);
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nreplace 1..1:\n+same`));
		expect(result.sections[0].op).toBe("noop");
		expect(fs.get(PATH)).toBe(text);
	});

	it("throws on a no-op section inside a multi-section batch", async () => {
		const fs = new InMemoryFilesystem([
			["a.ts", "same\n"],
			["b.ts", "x\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		const tagA = record(snapshots, "a.ts", "same\n");
		const tagB = record(snapshots, "b.ts", "x\n");
		const patcher = new Patcher({ fs, snapshots });
		await expect(
			patcher.apply(Patch.parse(`[a.ts#${tagA}]\nreplace 1..1:\n+same\n[b.ts#${tagB}]\nreplace 1..1:\n+y`)),
		).rejects.toThrow(/no changes/);
		expect(fs.get("b.ts")).toBe("x\n");
	});

	it("preflights write policy for every section before committing a batch", async () => {
		class BlockingFilesystem extends InMemoryFilesystem {
			override async preflightWrite(path: string): Promise<void> {
				if (path === "b.ts") throw new Error(`blocked write: ${path}`);
			}
		}
		const fs = new BlockingFilesystem([
			["a.ts", "a\n"],
			["b.ts", "b\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		const tagA = record(snapshots, "a.ts", "a\n");
		const tagB = record(snapshots, "b.ts", "b\n");
		const patcher = new Patcher({ fs, snapshots });
		await expect(
			patcher.apply(Patch.parse(`[a.ts#${tagA}]\nreplace 1..1:\n+A\n[b.ts#${tagB}]\nreplace 1..1:\n+B`)),
		).rejects.toThrow(/blocked write: b\.ts/);
		expect(fs.get("a.ts")).toBe("a\n");
		expect(fs.get("b.ts")).toBe("b\n");
	});

	it("recovers from an older in-session snapshot after the file advanced", () => {
		const PATH = "/repo/a.ts";
		const v0 = Array.from({ length: 12 }, (_, index) => `L${index + 1}`).join("\n");
		const store = new InMemorySnapshotStore();
		const tag0 = record(store, PATH, v0);
		const v1 = `${v0}\ntrailing`;
		record(store, PATH, v1);
		const { edits } = parsePatch("replace 10..10:\n+L10-EDITED");
		const recovered = new Recovery(store).tryRecover({ path: PATH, currentText: v1, fileHash: tag0, edits });

		expect(recovered).not.toBeNull();
		expect(recovered?.text).toContain("L10-EDITED");
	});

	it("ignores deletion of the trailing phantom newline sentinel", async () => {
		const PATH = "eof.ts";
		const text = "one\ntwo\n";
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, PATH, text);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`[${PATH}#${tag}]\ndelete 3`));
		expect(fs.get(PATH)).toBe(text);
	});

	it("returns null when neither patch recovery nor replay can land", () => {
		const PATH = "/repo/a.ts";
		const store = new InMemorySnapshotStore();
		const tag = record(store, PATH, "one\ntwo\nthree\n");
		const { edits } = parsePatch("replace 2..2:\n+TWO");
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: "completely\nunrelated\ncontent\nnow\n",
			fileHash: tag,
			edits,
		});
		expect(recovered).toBeNull();
	});

	it("returns null when the tagged full-file version has been evicted", () => {
		const PATH = "/repo/a.ts";
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 1 });
		const tag = record(store, PATH, "one\ntwo\nthree\n");
		record(store, PATH, "one\nTWO\nthree\n");
		const { edits } = parsePatch("replace 2..2:\n+TWO-AGAIN");
		expect(
			new Recovery(store).tryRecover({ path: PATH, currentText: "one\nTWO\nthree\n", fileHash: tag, edits }),
		).toBeNull();
	});

	it("recovers anchored edits from a full-file snapshot while preserving unrelated live drift", () => {
		const PATH = "/repo/a.ts";
		const store = new InMemorySnapshotStore();
		const snapshotText = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n";
		const tag = record(store, PATH, snapshotText);
		const currentText = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN-DRIFTED\neleven\n";
		const { edits } = parsePatch("replace 2..2:\n+TWO");
		const recovered = new Recovery(store).tryRecover({ path: PATH, currentText, fileHash: tag, edits });
		expect(recovered).not.toBeNull();
		expect(recovered?.text).toContain("TWO");
		expect(recovered?.text).toContain("TEN-DRIFTED");
	});
});

describe("snapshot store contract", () => {
	it("dedups a re-read of identical content to the same tag", () => {
		const store = new InMemorySnapshotStore();
		const first = record(store, "/repo/a.ts", "one\ntwo\n");
		const second = record(store, "/repo/a.ts", "one\ntwo\n");
		expect(second).toBe(first);
	});

	it("rejects cross-path tag lookups", () => {
		const store = new InMemorySnapshotStore();
		const tag = record(store, "/repo/a.ts", "one\n");
		expect(store.byHash("/repo/b.ts", tag)).toBeNull();
		expect(store.byHash("/repo/a.ts", tag)).not.toBeNull();
	});

	it("invalidate drops every snapshot for a path", () => {
		const store = new InMemorySnapshotStore();
		const tag = record(store, "/repo/a.ts", "one\n");
		store.invalidate("/repo/a.ts");
		expect(store.byHash("/repo/a.ts", tag)).toBeNull();
	});
});

describe("numbered diff and compact preview", () => {
	it("numbers added rows post-edit and removed rows pre-edit with bounded context", () => {
		const { diff, firstChangedLine } = generateNumberedDiff("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n");
		expect(firstChangedLine).toBe(3);
		expect(diff).toBe(" 1|a\n 2|b\n-3|c\n+3|X\n 4|d\n 5|e");
	});

	it("renumbers context rows to post-edit positions and omits removed lines", () => {
		const { diff } = generateNumberedDiff("a\nb\nc\nd\ne\n", "a\nb\nX\nY\nd\ne\n");
		const preview = buildCompactDiffPreview(diff);
		expect(preview.preview).toBe("1:a\n2:b\n3:X\n4:Y\n5:d\n6:e");
		expect(preview.addedLines).toBe(2);
		expect(preview.removedLines).toBe(1);
	});

	it("can generate wider numbered diff context for risky structural edits", () => {
		const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\n";
		const after = "a\nb\nc\nD\ne\nf\ng\nh\ni\n";
		expect(generateNumberedDiff(before, after).diff).toBe(" 2|b\n 3|c\n-4|d\n+4|D\n 5|e\n 6|f");
		expect(generateNumberedDiff(before, after, { contextLines: 4 }).diff).toBe(
			" 1|a\n 2|b\n 3|c\n-4|d\n+4|D\n 5|e\n 6|f\n 7|g\n 8|h",
		);
	});

	it("adds matching block-boundary context rows around partial structural diffs", () => {
		const before = ["function f() {", "  if (x) {", "    a();", "  }", "}", "tail();", ""].join("\n");
		const after = before.replace("if (x)", "if (y)");
		const { diff } = generateNumberedDiff(before, after, { contextLines: 0, path: "x.ts" });
		expect(diff).toContain(" 4|  }");
	});

	it("elides long added runs with a marker", () => {
		const diff = ["+1|l1", "+2|l2", "+3|l3", "+4|l4", "+5|l5", "+6|l6"].join("\n");
		const preview = buildCompactDiffPreview(diff);
		expect(preview.preview).toBe("1:l1\n2:l2\n…\n5:l5\n6:l6");
		expect(preview.addedLines).toBe(6);
	});
});
