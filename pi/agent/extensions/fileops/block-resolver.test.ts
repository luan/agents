import { beforeAll, describe, expect, it } from "bun:test";
import { preloadBlockLanguages, treeSitterBlockResolver } from "./block-resolver.ts";

const RUST = [
	"struct Point {",
	"\tx: i32,",
	"\ty: i32,",
	"}",
	"",
	"fn main() {",
	"\tlet p = Point { x: 1, y: 2 };",
	'\tprintln!("{}", p.x);',
	"}",
	"",
].join("\n");

const TYPESCRIPT = [
	"function greet(name: string) {",
	"\tif (!name) {",
	'\t\tname = "stranger";',
	"\t}",
	'\treturn "hi " + name;',
	"}",
	"const x = 1;",
	"",
].join("\n");

const PYTHON = ["@cache", "def load(key):", "\treturn store[key]", "", 'value = load("a")', ""].join("\n");

beforeAll(async () => {
	await preloadBlockLanguages(["a.rs", "a.ts", "a.py"]);
});

describe("treeSitterBlockResolver", () => {
	it("resolves a Rust struct from its opening line through its closing brace", () => {
		expect(treeSitterBlockResolver({ path: "a.rs", text: RUST, line: 1 })).toEqual({ start: 1, end: 4 });
	});

	it("resolves a Rust function block", () => {
		expect(treeSitterBlockResolver({ path: "a.rs", text: RUST, line: 6 })).toEqual({ start: 6, end: 9 });
	});

	it("resolves a TypeScript function and an inner if-block independently", () => {
		expect(treeSitterBlockResolver({ path: "a.ts", text: TYPESCRIPT, line: 1 })).toEqual({ start: 1, end: 6 });
		expect(treeSitterBlockResolver({ path: "a.ts", text: TYPESCRIPT, line: 2 })).toEqual({ start: 2, end: 4 });
	});

	it("resolves a single-line statement to itself", () => {
		expect(treeSitterBlockResolver({ path: "a.ts", text: TYPESCRIPT, line: 7 })).toEqual({ start: 7, end: 7 });
	});

	it("includes the decorator when anchored on the decorator line and excludes it from the def line", () => {
		expect(treeSitterBlockResolver({ path: "a.py", text: PYTHON, line: 1 })).toEqual({ start: 1, end: 3 });
		expect(treeSitterBlockResolver({ path: "a.py", text: PYTHON, line: 2 })).toEqual({ start: 2, end: 3 });
	});

	it("returns null for a lone closing delimiter line", () => {
		expect(treeSitterBlockResolver({ path: "a.rs", text: RUST, line: 4 })).toBeNull();
		expect(treeSitterBlockResolver({ path: "a.ts", text: TYPESCRIPT, line: 6 })).toBeNull();
	});

	it("returns null for a blank or out-of-range line", () => {
		expect(treeSitterBlockResolver({ path: "a.rs", text: RUST, line: 5 })).toBeNull();
		expect(treeSitterBlockResolver({ path: "a.rs", text: RUST, line: 999 })).toBeNull();
	});

	it("returns null when the resolved subtree contains a syntax error", () => {
		const broken = ["fn main() {", "\tlet x = ;", "}", ""].join("\n");
		expect(treeSitterBlockResolver({ path: "a.rs", text: broken, line: 1 })).toBeNull();
	});

	it("returns null for unsupported or unloaded languages", () => {
		expect(treeSitterBlockResolver({ path: "a.unknown-ext", text: RUST, line: 1 })).toBeNull();
	});
});
