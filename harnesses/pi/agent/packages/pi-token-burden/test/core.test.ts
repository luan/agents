import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../src/core/token-estimates.ts";
import { promptSections } from "../src/core/prompt-sections.ts";
import { summarizeUsage } from "../src/core/attribution.ts";
import { nextTab } from "../src/core/report-navigation.ts";

describe("estimation and partitioning", () => {
	test("labels the character heuristic with exact boundary behavior", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("1234")).toBe(1);
		expect(estimateTokens("12345")).toBe(2);
	});
	test("retains duplicate headings, preamble, nested headings, and fenced code", () => {
		const prompt = "preamble\n# A\nhello\n```md\n# not a heading\n```\n## A\nworld\n";
		const sections = promptSections(prompt);
		expect(sections.map((section) => section.label)).toEqual(["System prompt", "A", "A"]);
		expect(sections.map((section) => section.content).join("")).toBe(prompt);
		expect(sections[1]?.content).toContain("# not a heading");
		expect(promptSections("")).toEqual([]);
	});
	test("unavailable is distinct from recorded zero", () => {
		expect(summarizeUsage([]).totals).toBeNull();
		expect(summarizeUsage([{ id: "a", label: "a", kind: "compaction", usage: null }]).missing).toBe(1);
		const result = summarizeUsage([
			{
				id: "a",
				label: "a",
				kind: "assistant",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
			},
		]);
		expect(result.totals?.total).toBe(0);
		expect(result.missing).toBe(0);
	});
	test("tabs wrap", () => {
		expect(nextTab("Overview", -1)).toBe("Skills");
		expect(nextTab("Skills", 1)).toBe("Overview");
	});
});
