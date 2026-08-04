import { describe, expect, test } from "bun:test";
import { createPiToolSpecs, parseToolParams } from "./tool-specs.js";

const specs = createPiToolSpecs();

function parse(spec: { inputSchema: Parameters<typeof parseToolParams>[0]; coerce?: never }, params: unknown) {
	return parseToolParams(spec.inputSchema, (spec as { coerce?: never }).coerce, params) as Record<string, unknown>;
}

describe("search params", () => {
	test("fills defaults for omitted optionals", () => {
		const parsed = parse(specs.search, { queries: ["needle"] });
		expect(parsed.limit).toBe(3);
		expect(parsed.sort).toBe("relevance");
	});

	test("recovers a JSON-encoded queries array", () => {
		const parsed = parse(specs.search, { queries: '["alpha","beta"]' });
		expect(parsed.queries).toEqual(["alpha", "beta"]);
	});

	test("treats a bare queries string as a single query", () => {
		expect(parse(specs.search, { queries: "not json" }).queries).toEqual(["not json"]);
	});

	test("rejects an unknown contentType", () => {
		expect(() => parse(specs.search, { queries: ["q"], contentType: "diagrams" })).toThrow();
	});
});

describe("processFile params", () => {
	test("coerces a stringified timeout to a number", () => {
		const parsed = parse(specs.processFile, {
			path: "a.log",
			language: "shell",
			code: "wc -l",
			timeout: "5000",
		});
		expect(parsed.timeout).toBe(5000);
	});

	test("rejects a language outside the enum", () => {
		expect(() => parse(specs.processFile, { path: "a.log", language: "brainfuck", code: "x" })).toThrow();
	});

	test("rejects a missing required field", () => {
		expect(() => parse(specs.processFile, { path: "a.log", language: "shell" })).toThrow();
	});

	test("drops keys the schema does not declare", () => {
		const parsed = parse(specs.processFile, {
			path: "a.log",
			language: "shell",
			code: "wc -l",
			nonsense: "dropped",
		});
		expect(parsed).not.toHaveProperty("nonsense");
	});
});

describe("fetch params", () => {
	test("defaults concurrency and enforces its ceiling", () => {
		expect(parse(specs.fetch, { url: "https://example.com" }).concurrency).toBe(1);
		expect(() => parse(specs.fetch, { url: "https://example.com", concurrency: 9 })).toThrow();
	});

	test("rejects an empty requests batch", () => {
		expect(() => parse(specs.fetch, { requests: [] })).toThrow();
	});
});

describe("purge params", () => {
	test("requires confirm", () => {
		expect(() => parse(specs.purge, { scope: "project" })).toThrow();
		expect(parse(specs.purge, { confirm: true, scope: "project" }).confirm).toBe(true);
	});
});
