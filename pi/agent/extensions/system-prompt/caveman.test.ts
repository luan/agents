import { describe, expect, test } from "bun:test";
import { buildCavemanPrompt } from "./caveman";

describe("Caveman prompt modes", () => {
	test("keeps mode instructions materially distinct", () => {
		const lite = buildCavemanPrompt("lite");
		const full = buildCavemanPrompt("full");
		const ultra = buildCavemanPrompt("ultra");

		expect(lite).toContain("# Caveman (lite)");
		expect(full).toContain("# Caveman (full)");
		expect(ultra).toContain("# Caveman (ultra)");
		expect(ultra).toContain("Strip conjunctions when cause-then-effect stay unambiguous.");
		expect(ultra).toContain("Default: **full**. Switch: `/caveman lite|full|ultra|off`.");
		expect(ultra).not.toContain("| **lite** |");
		expect(ultra).not.toContain("| **full** |");
		expect(ultra).not.toContain("| **ultra** |");
		expect(new Set([lite, full, ultra]).size).toBe(3);
	});
});
