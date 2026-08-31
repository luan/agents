import { describe, expect, test } from "bun:test";
import { filterPrompts, queryMatchIndexes } from "../src/index.ts";

const items = [
	{
		kind: "history" as const,
		id: "new",
		text: "Fix the editor cursor",
		timestamp: 2,
		cwd: "/repo",
		sessionName: "cursor",
	},
	{ kind: "history" as const, id: "old", text: "Update the readme", timestamp: 3, cwd: "/repo", sessionName: "docs" },
];

describe("prompt storage search", () => {
	test("matches prompt text and session names by relevance", () => {
		expect(filterPrompts(items, "cursor", 10).map((item) => item.id)).toEqual(["new"]);
		expect(filterPrompts(items, "read", 10).map((item) => item.id)).toEqual(["old"]);
	});
	test("returns highlighted character positions for exact tokens", () => {
		expect([...queryMatchIndexes("Fix the editor", "edit")]).toEqual([8, 9, 10, 11]);
	});
});
