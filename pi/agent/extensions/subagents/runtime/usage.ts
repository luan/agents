/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum). cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call — summing across
 * turns counts the prefix N times. See issue #38.
 */
export type AssistantUsage = { input: number; output: number; cacheWrite: number; cost: number };
export type LifetimeUsage = AssistantUsage;

export function readAssistantUsage(message: unknown): AssistantUsage | undefined {
	if (!message || typeof message !== "object") return undefined;
	const usage = (message as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	const cost = record.cost && typeof record.cost === "object" ? (record.cost as Record<string, unknown>).total : 0;
	return {
		input: typeof record.input === "number" ? record.input : 0,
		output: typeof record.output === "number" ? record.output : 0,
		cacheWrite: typeof record.cacheWrite === "number" ? record.cacheWrite : 0,
		cost: typeof cost === "number" ? cost : 0,
	};
}

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
	return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: AssistantUsage): void {
	into.input += delta.input;
	into.output += delta.output;
	into.cacheWrite += delta.cacheWrite;
	into.cost += delta.cost;
}

/** Minimal shape we read from upstream `getSessionStats()`. */
type SessionStatsLike = {
	tokens: { input: number; output: number; cacheWrite: number };
	contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };
