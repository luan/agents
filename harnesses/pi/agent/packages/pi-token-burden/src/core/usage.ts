import type { TokenEstimate, UsageRecord, UsageSummary } from "./report.ts";
import { emptyUsage } from "./report.ts";

export const promptTokens = (usage: TokenEstimate): number => usage.input + usage.cacheRead + usage.cacheWrite;

/** Annotate records without turning unavailable usage into fabricated zeroes. */
export function annotateUsage(records: readonly UsageRecord[]): UsageRecord[] {
	let previous: number | undefined;
	let turn = 0;
	return records.map((record) => {
		if (!record.usage) return { ...record, promptTokens: null, growth: null, turn: null };
		const current = promptTokens(record.usage);
		const annotated = {
			...record,
			promptTokens: current,
			growth: previous === undefined ? current : current - previous,
			turn: ++turn,
		};
		previous = current;
		return annotated;
	});
}

export function summarizeUsage(input: readonly UsageRecord[]): UsageSummary {
	const records = annotateUsage(input);
	const recorded = records.filter((record): record is UsageRecord & { usage: TokenEstimate } => record.usage !== null);
	const totals: TokenEstimate | null = recorded.length ? emptyUsage() : null;
	if (totals)
		for (const record of recorded) {
			totals.input += record.usage.input;
			totals.output += record.usage.output;
			totals.cacheRead += record.usage.cacheRead;
			totals.cacheWrite += record.usage.cacheWrite;
			totals.total += record.usage.total;
			totals.cost += record.usage.cost;
		}
	const missingByKind: UsageSummary["missingByKind"] = {
		assistant: 0,
		"nested tool": 0,
		compaction: 0,
		"branch summary": 0,
	};
	for (const record of records) if (!record.usage) missingByKind[record.kind]++;
	const promptTotal = recorded.reduce((sum, record) => sum + (record.promptTokens ?? 0), 0);
	const cacheRead = recorded.reduce((sum, record) => sum + record.usage.cacheRead, 0);
	return {
		records,
		totals,
		missing: records.length - recorded.length,
		missingByKind,
		floorTokens: recorded[0]?.promptTokens ?? null,
		lastContextTokens: recorded.at(-1)?.promptTokens ?? null,
		cachedShare: promptTotal > 0 ? cacheRead / promptTotal : recorded.length ? 0 : null,
	};
}
