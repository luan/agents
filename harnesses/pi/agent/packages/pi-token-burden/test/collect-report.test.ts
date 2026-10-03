import { describe, expect, test } from "bun:test";
import { collectReport, usageRecords } from "../src/runtime/collect-report.ts";
import { estimateTokens } from "../src/core/token-estimates.ts";
import { assistant, fixture, missingSummary } from "./fixtures.ts";

describe("public Pi API collection", () => {
	test("reads tool/command inventories from pi, skill metadata from command context", () => {
		const { pi, ctx } = fixture();
		const report = collectReport(pi, ctx);
		expect(report.tools).toHaveLength(2);
		expect(report.commands).toEqual([{ name: "demo", source: "extension", path: "/extensions/example.ts" }]);
		expect(report.skills.map((skill) => skill.modelInvocable)).toEqual([true, false]);
		expect(report.skills[0]?.estimate).toBeGreaterThan(0);
		expect(report.skills[1]?.estimate).toBe(0);
		expect(report.contextFiles[0]?.content).toBe("Be useful");
		expect(report.context?.percent).toBe(50);
	});
	test("includes schemas, guidelines, active state, source, and observed calls", () => {
		const { pi, ctx } = fixture();
		const report = collectReport(pi, ctx);
		const tool = report.tools.find((tool) => tool.name === "lookup")!;
		expect(tool.parameters).toContain('"query"');
		expect(tool.schemaEstimate).toBeGreaterThan(0);
		expect(tool.estimate).toBeGreaterThan(estimateTokens(`${tool.name} ${tool.description}`));
		expect(tool.active).toBe(true);
		expect(tool.branchCalls).toBe(1);
		expect(tool.source).toBe("/extensions/example.ts");
		expect(tool.guidelineEstimate).toBeGreaterThan(0);
		expect(tool.inputCost).toBeNull();
		expect(report.tools.find((tool) => tool.name === "inactive")?.active).toBe(false);
	});
	test("distinguishes branch and full session with nested and compaction usage", () => {
		const { pi, ctx } = fixture();
		const report = collectReport(pi, ctx);
		expect(report.usage.branch.totals).toEqual({
			input: 30,
			output: 60,
			cacheRead: 90,
			cacheWrite: 120,
			total: 300,
			cost: 3,
		});
		expect(report.usage.branch.missing).toBe(1);
		expect(report.usage.session.totals?.total).toBe(400);
		expect(report.usage.branch.records.map((record) => record.kind)).toEqual([
			"assistant",
			"nested tool",
			"compaction",
			"branch summary",
		]);
	});
	test("handles empty sessions and unavailable context without fabricated zeros", () => {
		const { pi, ctx } = fixture();
		ctx.sessionManager = { getBranch: () => [], getEntries: () => [] };
		ctx.getContextUsage = () => undefined;
		const report = collectReport(pi, ctx);
		expect(report.usage.branch.totals).toBeNull();
		expect(report.context).toBeNull();
		ctx.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 1000 });
		expect(collectReport(pi, ctx).context?.tokens).toBeNull();
	});
	test("does not count unreported tool work as zero or duplicate stored usage", () => {
		expect(usageRecords([missingSummary])[0]?.usage).toBeNull();
		expect(usageRecords([assistant])).toHaveLength(1);
	});
	test("takes fresh snapshots rather than retaining session state", () => {
		const { pi, ctx } = fixture();
		expect(collectReport(pi, ctx).tools.filter((tool) => tool.active)).toHaveLength(1);
		pi.getActiveTools = () => [];
		expect(collectReport(pi, ctx).tools.filter((tool) => tool.active)).toHaveLength(0);
	});
});
