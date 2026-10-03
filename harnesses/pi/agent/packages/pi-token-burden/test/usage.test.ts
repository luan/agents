import { describe, expect, test } from "bun:test";
import type { UsageRecord } from "../src/core/report.ts";
import { summarizeUsage } from "../src/core/usage.ts";

const usage = (input: number, cacheRead = 0, cacheWrite = 0): NonNullable<UsageRecord["usage"]> => ({
	input,
	output: 5,
	cacheRead,
	cacheWrite,
	total: input + cacheRead + cacheWrite + 5,
	cost: 1,
});
const record = (kind: UsageRecord["kind"], value: UsageRecord["usage"]): UsageRecord => ({
	id: kind,
	label: kind,
	kind,
	usage: value,
});

describe("usage model", () => {
	test("reports provider context, growth, floor, last context, and cache share", () => {
		const summary = summarizeUsage([
			record("assistant", usage(100)),
			record("nested tool", usage(20, 80)),
			record("compaction", usage(10, 40)),
		]);
		expect(summary.records.map(({ promptTokens, growth, turn }) => ({ promptTokens, growth, turn }))).toEqual([
			{ promptTokens: 100, growth: 100, turn: 1 },
			{ promptTokens: 100, growth: 0, turn: 2 },
			{ promptTokens: 50, growth: -50, turn: 3 },
		]);
		expect(summary.floorTokens).toBe(100);
		expect(summary.lastContextTokens).toBe(50);
		expect(summary.cachedShare).toBeCloseTo(120 / 250);
	});

	test("keeps unavailable records out of totals while counting their kind", () => {
		const summary = summarizeUsage([record("assistant", null), record("branch summary", usage(0))]);
		expect(summary.totals?.input).toBe(0);
		expect(summary.missing).toBe(1);
		expect(summary.missingByKind).toEqual({ assistant: 1, "nested tool": 0, compaction: 0, "branch summary": 0 });
		expect(summary.floorTokens).toBe(0);
		expect(summary.cachedShare).toBe(0);
	});

	test("uses null rather than fabricated zeroes for an empty report", () => {
		const summary = summarizeUsage([]);
		expect(summary.totals).toBeNull();
		expect(summary.floorTokens).toBeNull();
		expect(summary.lastContextTokens).toBeNull();
		expect(summary.cachedShare).toBeNull();
	});
});
