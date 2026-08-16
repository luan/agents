/**
 * What the provider actually charged, read back out of the transcript.
 *
 * Every assistant message carries the usage the provider reported. This extension
 * used to re-tokenize the prompt with a BPE encoder instead, which cannot see
 * caching at all: a turn reporting `input: 288` against `cacheRead: 8,704` sent
 * the same nine thousand tokens as the turn before it and paid about a tenth as
 * much. An estimated cost is wrong by an order of magnitude here.
 *
 * Two quantities answer different questions:
 *
 *   - `promptTokens` (input + cacheRead + cacheWrite) is the context the provider
 *     saw. Compare it against the context window.
 *   - `input` alone was billed at the full rate. Compare it against the bill.
 *
 * The first turn's `promptTokens` is the session floor: system prompt, tool array,
 * and everything the provider adds, measured rather than modelled.
 */

import type { SessionUsageTotals, TurnUsage } from "./types.ts";

/** The slice of an assistant message this module reads. Structural, so no pi import. */
interface UsageRecord {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageOf(message: unknown): UsageRecord | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return undefined;
	const usage = record.usage;
	return usage && typeof usage === "object" ? (usage as UsageRecord) : undefined;
}

/**
 * Every turn on the current branch, in order.
 *
 * A turn whose prompt totals zero is dropped. An aborted or failed request
 * carries a zeroed usage block, which would chart as a dip in spend.
 */
export function readTurnUsage(messages: readonly unknown[]): TurnUsage[] {
	const turns: TurnUsage[] = [];
	let previousPrompt: number | undefined;

	for (const [index, message] of messages.entries()) {
		const usage = usageOf(message);
		if (!usage) continue;

		const input = count(usage.input);
		const cacheRead = count(usage.cacheRead);
		const cacheWrite = count(usage.cacheWrite);
		const promptTokens = input + cacheRead + cacheWrite;
		if (promptTokens === 0) continue;

		turns.push({
			index: turns.length + 1,
			messageIndex: index,
			input,
			cacheRead,
			cacheWrite,
			output: count(usage.output),
			cost: count(usage.cost?.total),
			promptTokens,
			growth: previousPrompt === undefined ? promptTokens : promptTokens - previousPrompt,
		});
		previousPrompt = promptTokens;
	}

	return turns;
}

export function summarizeTurns(turns: readonly TurnUsage[]): SessionUsageTotals | undefined {
	const first = turns.at(0);
	const last = turns.at(-1);
	if (!first || !last) return undefined;

	const cacheRead = turns.reduce((sum, turn) => sum + turn.cacheRead, 0);
	const promptTokens = turns.reduce((sum, turn) => sum + turn.promptTokens, 0);

	return {
		turns: turns.length,
		floorTokens: first.promptTokens,
		contextTokens: last.promptTokens,
		freshInput: turns.reduce((sum, turn) => sum + turn.input, 0),
		cacheRead,
		cacheWrite: turns.reduce((sum, turn) => sum + turn.cacheWrite, 0),
		output: turns.reduce((sum, turn) => sum + turn.output, 0),
		cost: turns.reduce((sum, turn) => sum + turn.cost, 0),
		/** Share of everything ever sent that the provider served from cache. */
		cachedShare: promptTokens > 0 ? cacheRead / promptTokens : 0,
	};
}

export function formatCost(cost: number): string {
	if (cost <= 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}
