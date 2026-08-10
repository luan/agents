import { describe, expect, test } from "bun:test";
import { createPiToolSpecs, parseToolParams } from "./tool-specs.js";

const specs = createPiToolSpecs();

describe("Context Guard v2 tool schemas", () => {
	test("search accepts only capture-search parameters", () => {
		const parsed = parseToolParams(specs.search.inputSchema, {
			query: "needle",
			artifactId: "artifact-1",
			limit: 3,
			offset: 2,
		}) as Record<string, unknown>;
		expect(parsed).toEqual({ query: "needle", artifactId: "artifact-1", limit: 3, offset: 2, sort: "relevance" });
		expect(() => parseToolParams(specs.search.inputSchema, { query: "needle", extra: true })).toThrow();
	});

	test("status has an empty strict schema", () => {
		expect(parseToolParams(specs.status.inputSchema, {})).toEqual({});
		expect(() => parseToolParams(specs.status.inputSchema, { extra: true })).toThrow();
	});

	test("purge requires one explicit destructive scope", () => {
		expect(parseToolParams(specs.purge.inputSchema, { confirm: true, scope: "project" })).toEqual({
			confirm: true,
			scope: "project",
		});
		expect(() =>
			parseToolParams(specs.purge.inputSchema, { confirm: true, scope: "project", sessionId: "x" }),
		).toThrow();
		expect(() => parseToolParams(specs.purge.inputSchema, { confirm: true, scope: "session" })).toThrow();
	});
});
