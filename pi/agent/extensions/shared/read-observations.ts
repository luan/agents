/**
 * What `read` saw while serving one call, keyed by toolCallId. fileops/index.ts:4481 parses the selector and
 * fileops/index.ts:4551 learns the line count; `read` returns neither, and session-stamps/index.ts needs both.
 * Each extension gets its own jiti (`moduleCache: false`), so the map hangs off `globalThis` (tool-registry.ts:50).
 */
export type ReadObservation = { sel: boolean; tot?: number };

const MAX_TRACKED = 64;
const READ_OBSERVATIONS = Symbol.for("agents.readObservations");
const globalState = globalThis as typeof globalThis & Record<symbol, Map<string, ReadObservation> | undefined>;
const observations = globalState[READ_OBSERVATIONS] ?? new Map<string, ReadObservation>();
globalState[READ_OBSERVATIONS] = observations;

function evictOverflow(): void {
	while (observations.size > MAX_TRACKED) {
		const oldest = observations.keys().next();
		if (oldest.done) break;
		observations.delete(oldest.value);
	}
}

export function noteReadSelector(toolCallId: string | undefined, sel: boolean): void {
	if (!toolCallId) return;
	observations.set(toolCallId, { sel });
	evictOverflow();
}

export function noteReadLineTotal(toolCallId: string | undefined, tot: number): void {
	if (!toolCallId) return;
	const existing = observations.get(toolCallId);
	if (existing) existing.tot = tot;
}

export function takeReadObservation(toolCallId: string | undefined): ReadObservation | undefined {
	if (!toolCallId) return undefined;
	const observation = observations.get(toolCallId);
	observations.delete(toolCallId);
	return observation;
}
