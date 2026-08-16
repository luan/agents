import { expect, it } from "bun:test";

import { globMatcher } from "./glob.ts";

it("refuses an empty glob so prune never matches everything by default", () => {
	expect(() => globMatcher("")).toThrow("Notebook glob is required");
});

it("matches wildcards and treats regex characters as literals", () => {
	const matches = globMatcher("draft-*");
	expect(matches("draft-one")).toBe(true);
	expect(matches("DRAFT-one")).toBe(true);
	expect(matches("release-one")).toBe(false);

	expect(globMatcher("a.b")("a.b")).toBe(true);
	expect(globMatcher("a.b")("axb")).toBe(false);
	expect(globMatcher("a+b")("a+b")).toBe(true);
	expect(globMatcher("a?c")("abc")).toBe(true);
	expect(globMatcher("a?c")("ac")).toBe(false);
});

it("anchors the whole value", () => {
	const matches = globMatcher("api");
	expect(matches("api")).toBe(true);
	expect(matches("api-v2")).toBe(false);
	expect(matches("my-api")).toBe(false);
});
