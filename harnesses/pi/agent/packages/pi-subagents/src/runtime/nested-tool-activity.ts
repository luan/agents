type ExternalToolResult = object | null | undefined;

interface NestedCall {
	name: string;
	toolCallId: string;
	status?: string;
}

// type-boundary: Pi tool details are heterogeneous; nestedCalls validates the Code Mode trace before use.
function nestedCalls(result: ExternalToolResult): NestedCall[] {
	if (!result || !("details" in result)) return [];
	const details = result.details;
	if (!details || typeof details !== "object" || !("calls" in details) || !Array.isArray(details.calls)) return [];
	const records: NestedCall[] = [];
	for (const entry of details.calls) {
		if (!entry || typeof entry !== "object" || !("name" in entry) || !("toolCallId" in entry)) continue;
		if (typeof entry.name !== "string" || typeof entry.toolCallId !== "string" || entry.toolCallId === "") continue;
		records.push({
			name: entry.name,
			toolCallId: entry.toolCallId,
			status: "status" in entry && typeof entry.status === "string" ? entry.status : undefined,
		});
	}
	return records;
}

export interface NestedToolActivityReader {
	started(partialResult: ExternalToolResult): string[];
	ended(result: ExternalToolResult): string[];
}

/** Deduplicate nested calls repeated across Code Mode exec and wait results. */
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
