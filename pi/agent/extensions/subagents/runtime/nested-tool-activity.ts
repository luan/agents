/**
 * A child session in code-mode dispatches only `exec` and `wait`. The tools it actually called live in
 * the cell result's `details.calls`, so a parent reading only the child's `tool_execution_*` events
 * showed `exec` as the child's whole activity and counted one tool use per cell.
 */

interface NestedCall {
	name: string;
	toolCallId: string;
	status?: string;
}

function nestedCalls(result: unknown): NestedCall[] {
	const calls = (result as { details?: { calls?: unknown } } | undefined)?.details?.calls;
	if (!Array.isArray(calls)) return [];
	const records: NestedCall[] = [];
	for (const entry of calls) {
		const call = entry as { name?: unknown; toolCallId?: unknown; status?: unknown } | undefined;
		if (typeof call?.name !== "string" || typeof call.toolCallId !== "string" || call.toolCallId === "") continue;
		records.push({
			name: call.name,
			toolCallId: call.toolCallId,
			status: typeof call.status === "string" ? call.status : undefined,
		});
	}
	return records;
}

export interface NestedToolActivityReader {
	/** Tool names to report as started, each nested call reported once. */
	started(partialResult: unknown): string[];
	/** Tool names to report as ended, each nested call counted once. */
	ended(result: unknown): string[];
}

/**
 * One reader per event subscription. A cell that outlives its yield reports the same `calls` array from
 * `exec` and again from `wait`, so the ids already reported are remembered rather than counted twice.
 */
export function createNestedToolActivityReader(): NestedToolActivityReader {
	const started = new Set<string>();
	const ended = new Set<string>();
	return {
		started(partialResult) {
			const names: string[] = [];
			for (const call of nestedCalls(partialResult)) {
				if (started.has(call.toolCallId)) continue;
				started.add(call.toolCallId);
				names.push(call.name);
			}
			return names;
		},
		ended(result) {
			const names: string[] = [];
			for (const call of nestedCalls(result)) {
				if (call.status === "running" || ended.has(call.toolCallId)) continue;
				ended.add(call.toolCallId);
				names.push(call.name);
			}
			return names;
		},
	};
}
