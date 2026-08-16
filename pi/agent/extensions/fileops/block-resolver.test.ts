import { beforeAll, describe, expect, it } from "bun:test";
import {
	preloadBlockLanguages,
	summarizeCodeStructure,
	treeSitterBlockResolver,
	treeSitterSyntaxValidator,
} from "./block-resolver.ts";

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

const SWIFT = [
	"import Foundation",
	"",
	"struct Rectangle {",
	"    let width: Double",
	"",
	"    func area() -> Double {",
	"        return width * width",
	"    }",
	"}",
	"",
	"final class Counter {",
	"    private var value = 0",
	"",
	"    func increment(by amount: Int) {",
	"        value += amount",
	"    }",
	"}",
	"",
].join("\n");

beforeAll(async () => {
	await preloadBlockLanguages(["a.rs", "a.ts", "a.py", "a.swift"]);
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

	it("resolves a Swift struct, its method, and a class behind a modifier", () => {
		expect(treeSitterBlockResolver({ path: "a.swift", text: SWIFT, line: 3 })).toEqual({ start: 3, end: 9 });
		expect(treeSitterBlockResolver({ path: "a.swift", text: SWIFT, line: 6 })).toEqual({ start: 6, end: 8 });
		expect(treeSitterBlockResolver({ path: "a.swift", text: SWIFT, line: 11 })).toEqual({ start: 11, end: 17 });
	});

	it("resolves a Swift member that follows another statement in the same body", () => {
		// A zero-width lookup stops at class_body here; block-resolver.ts:900 asks for one column.
		expect(treeSitterBlockResolver({ path: "a.swift", text: SWIFT, line: 14 })).toEqual({ start: 14, end: 16 });
		expect(treeSitterBlockResolver({ path: "a.swift", text: SWIFT, line: 12 })).toEqual({ start: 12, end: 12 });
	});

	it("returns no-block for a lone closing delimiter line", () => {
		expect(treeSitterBlockResolver({ path: "a.rs", text: RUST, line: 4 })).toEqual({ reason: "no_block" });
		expect(treeSitterBlockResolver({ path: "a.ts", text: TYPESCRIPT, line: 6 })).toEqual({ reason: "no_block" });
	});

	it("returns no-block for a blank or out-of-range line", () => {
		expect(treeSitterBlockResolver({ path: "a.rs", text: RUST, line: 5 })).toEqual({ reason: "no_block" });
		expect(treeSitterBlockResolver({ path: "a.rs", text: RUST, line: 999 })).toEqual({ reason: "no_block" });
	});

	it("returns syntax-error when tree-sitter parses error nodes", () => {
		const broken = ["fn main() {", "\tlet x = ;", "}", ""].join("\n");
		expect(treeSitterBlockResolver({ path: "a.rs", text: broken, line: 1 })).toEqual({ reason: "syntax_error" });
	});

	it("returns unsupported-language for unknown extensions", () => {
		expect(treeSitterBlockResolver({ path: "a.unknown-ext", text: RUST, line: 1 })).toEqual({
			reason: "unsupported_language",
		});
	});

	it("returns parser-unavailable for supported languages that were not preloaded", () => {
		expect(treeSitterBlockResolver({ path: "a.go", text: "func main() {}\n", line: 1 })).toEqual({
			reason: "parser_unavailable",
		});
	});

	it("validates full-file syntax with tree-sitter error counts", () => {
		expect(treeSitterSyntaxValidator({ path: "a.ts", text: TYPESCRIPT })).toEqual({ kind: "valid", errorCount: 0 });
		expect(treeSitterSyntaxValidator({ path: "a.ts", text: "const = ;\n" })).toEqual({
			kind: "invalid",
			errorCount: 1,
		});
	});

	it("validates Swift syntax through the same grammar the resolver uses", () => {
		expect(treeSitterSyntaxValidator({ path: "a.swift", text: SWIFT })).toEqual({ kind: "valid", errorCount: 0 });
	});

	it("does not block syntax validation for unsupported or unloaded languages", () => {
		expect(treeSitterSyntaxValidator({ path: "a.unknown-ext", text: "const = ;\n" })).toEqual({
			kind: "unsupported_language",
		});
		expect(treeSitterSyntaxValidator({ path: "a.go", text: "func main() {\n" })).toEqual({
			kind: "parser_unavailable",
		});
	});
});

// Swift's grammar collapses struct, enum, extension and actor into
// `class_declaration`, and every visibility keyword shares one node kind. Both
// mistakes are silent: they yield a plausible outline with the wrong labels.
const SWIFT_MIXED = [
	"import Foundation",
	"import SwiftUI",
	"import Combine",
	"import CoreGraphics",
	"",
	"public struct Rect: Sendable {",
	"    public let width: Double",
	"    public let height: Double",
	"",
	"    public func area() -> Double {",
	"        let scaled = width * height",
	"        return scaled",
	"    }",
	"}",
	"",
	"enum Mode {",
	"    case first",
	"    case second",
	"    case third",
	"    case fourth",
	"}",
	"",
	"public extension Rect {",
	"    var isSquare: Bool {",
	"        width == height",
	"    }",
	"}",
	"",
	"private extension Rect {",
	"    var perimeter: Double {",
	"        2 * (width + height)",
	"    }",
	"}",
	"",
	"open class Widget {",
	"    var count = 0",
	"",
	"    func bump() {",
	"        count += 1",
	"    }",
	"}",
	"",
	"package struct Payload {",
	"    let id: Int",
	"    let body: String",
	"    let retries: Int",
	"}",
	"",
	"actor Cache {",
	"    var items: [Int] = []",
	"",
	"    func append(_ item: Int) {",
	"        items.append(item)",
	"    }",
	"}",
	"",
	"protocol Store {",
	"    func load(key: String) -> Data?",
	"    func save(key: String, value: Data)",
	"}",
	"",
	"public typealias Handler = (Int) -> Void",
	"",
	"func helper(value: Int) -> Int {",
	"    let doubled = value * 2",
	"    return doubled + 1",
	"}",
	"",
	"public private(set) var shared = 0",
	"",
	"@MainActor public final class Root {",
	"    var value = 0",
	"",
	"    func reset() {",
	"        value = 0",
	"    }",
	"}",
	"",
	"fileprivate let secret = 1",
	"internal var counted = 0",
	"",
].join("\n");

describe("summarizeCodeStructure for Swift", () => {
	it("labels every collapsed declaration kind by its keyword", () => {
		const summary = summarizeCodeStructure("a.swift", SWIFT_MIXED, { maxTokens: 260 });
		expect(summary?.counts.byKind).toEqual([
			{ label: "import", count: 4 },
			{ label: "property", count: 3 },
			{ label: "class", count: 2 },
			{ label: "extension", count: 2 },
			{ label: "struct", count: 2 },
			{ label: "actor", count: 1 },
			{ label: "enum", count: 1 },
			{ label: "function", count: 1 },
			{ label: "protocol", count: 1 },
			{ label: "type", count: 1 },
		]);
	});

	it("counts public, open, package and public private(set) as exported", () => {
		const summary = summarizeCodeStructure("a.swift", SWIFT_MIXED, { maxTokens: 260 });
		// Rect, its public extension, Widget, Payload, Handler, shared, Root.
		expect(summary?.counts.exported).toBe(7);
	});

	it("keeps declaration headers visible and elides their bodies", () => {
		const summary = summarizeCodeStructure("a.swift", SWIFT_MIXED, { maxTokens: 260 });
		const visible = (summary?.rows ?? []).flatMap((row) => (row.kind === "line" ? [row.text] : []));
		expect(visible).toContain("public struct Rect: Sendable {");
		expect(visible).toContain("actor Cache {");
		expect(visible).toContain("public typealias Handler = (Int) -> Void");
		expect(visible).not.toContain("        let scaled = width * height");
	});

	it("reports elided ranges a targeted re-read recovers exactly", () => {
		const summary = summarizeCodeStructure("a.swift", SWIFT_MIXED, { maxTokens: 260 });
		expect(summary).toBeDefined();
		const lines = SWIFT_MIXED.split("\n").slice(0, -1);
		expect(summary?.totalLines).toBe(lines.length);
		const rebuilt: string[] = [];
		let cursor = 1;
		for (const row of summary?.rows ?? []) {
			if (row.kind === "line") {
				expect(row.lineNumber).toBe(cursor);
				rebuilt.push(row.text);
				cursor += 1;
				continue;
			}
			expect(row.startLine).toBe(cursor);
			// What a re-read of `path:startLine-endLine` returns.
			rebuilt.push(...lines.slice(row.startLine - 1, row.endLine));
			cursor = row.endLine + 1;
		}
		expect(cursor).toBe(lines.length + 1);
		expect(rebuilt).toEqual(lines);
		expect(summary?.elidedRanges.map((range) => range.endLine - range.startLine + 1).reduce((a, b) => a + b, 0)).toBe(
			summary?.elidedLines,
		);
	});

	it("folds an import run and whole members when the budget is tight", () => {
		const summary = summarizeCodeStructure("a.swift", SWIFT_MIXED, { maxTokens: 100 });
		const elided = summary?.elidedRanges ?? [];
		const lines = SWIFT_MIXED.split("\n");
		const covers = (line: number) => elided.some((range) => range.startLine <= line && range.endLine >= line);
		expect([covers(2), covers(3)]).toEqual([true, true]);
		expect(covers(lines.indexOf("enum Mode {") + 2)).toBe(true);
		const visible = (summary?.rows ?? []).flatMap((row) => (row.kind === "line" ? [row.text] : []));
		expect(visible).toContain("import Foundation");
		expect(visible).toContain("enum Mode {");
	});

	it("falls back to a plain read when the Swift grammar cannot parse the file", () => {
		// `as?` inside a subscript expression is one of the constructs
		// alex-pinkus/tree-sitter-swift 0.7.3 rejects.
		const broken = [
			"import Foundation",
			"",
			"struct Reader {",
			"    let raw: [String: Any]",
			"",
			"    func text() -> String {",
			'        let value = raw["text"] as? String ?? ""',
			"        return value",
			"    }",
			"}",
			"",
		].join("\n");
		expect(treeSitterSyntaxValidator({ path: "a.swift", text: broken }).kind).toBe("invalid");
		expect(summarizeCodeStructure("a.swift", broken)).toBeUndefined();
	});

	it("returns no summary when the language has no summary table", () => {
		expect(summarizeCodeStructure("a.unknown-ext", SWIFT_MIXED)).toBeUndefined();
	});
});
