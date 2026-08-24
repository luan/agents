import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { NestedToolResult, NestedToolTrace, TraceValue } from "../protocol/types.ts";

const MAX_TRACE_TEXT_CHARS = 32_768;
const MAX_TRACE_DETAILS_CHARS = 65_536;
const MAX_TRACE_INPUT_CHARS = 16_384;
const MAX_TRACE_ERROR_CHARS = 4_096;
const MAX_SERIALIZED_NODES = 4_096;

export function sanitizeTraceInput(value: unknown): TraceValue {
	return sanitizeValue(value, { remaining: MAX_TRACE_INPUT_CHARS });
}

export function boundTraceValue(value: unknown): TraceValue {
	return sanitizeValue(value, { remaining: MAX_TRACE_DETAILS_CHARS });
}

export function boundTraceResult(result: AgentToolResult<unknown>): NestedToolResult {
	let textRemaining = MAX_TRACE_TEXT_CHARS;
	const content = result.content.map((item) => {
		if (item.type === "text") {
			const text = truncateText(item.text, textRemaining);
			textRemaining = Math.max(0, textRemaining - text.length);
			return { ...item, text };
		}
		if (item.type === "image") {
			return { type: "image" as const, mimeType: item.mimeType, dataChars: item.data.length };
		}
		return sanitizeValue(item, { remaining: MAX_TRACE_TEXT_CHARS });
	});
	return {
		content,
		...(result.details === undefined
			? {}
			: {
					details:
						boundPresentationDetails(result.details) ??
						sanitizeValue(result.details, { remaining: MAX_TRACE_DETAILS_CHARS }),
				}),
	};
}

export function cloneTrace(trace: NestedToolTrace): NestedToolTrace {
	return {
		version: 1,
		id: trace.id,
		name: trace.name,
		kind: trace.kind,
		input: sanitizeTraceInput(trace.input),
		status: trace.status,
		startedAtMs: trace.startedAtMs,
		...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
		...(trace.result === undefined
			? {}
			: {
					result: {
						content: trace.result.content.map((item) => sanitizeValue(item, { remaining: MAX_TRACE_TEXT_CHARS })),
						...(trace.result.details === undefined
							? {}
							: {
									details:
										boundPresentationDetails(trace.result.details) ??
										sanitizeValue(trace.result.details, { remaining: MAX_TRACE_DETAILS_CHARS }),
								}),
					},
				}),
		...(trace.value === undefined ? {} : { value: boundTraceValue(trace.value) }),
		...(trace.error === undefined ? {} : { error: trace.error }),
	};
}

export function truncateTraceError(error: unknown): string {
	return truncateText(error instanceof Error ? error.message : String(error), MAX_TRACE_ERROR_CHARS);
}

/** Preserve the exec presentation envelope while bounding only its untrusted payload. */
function boundPresentationDetails(value: unknown): TraceValue | undefined {
	const details = asRecord(value);
	if (details?.contract !== "pi-exec-command/tool-presentation") return undefined;
	const progress = asRecord(details.progress);
	if (!progress) return undefined;
	return {
		contract: "pi-exec-command/tool-presentation",
		version: sanitizeValue(details.version, { remaining: 32 }),
		tool: sanitizeValue(details.tool, { remaining: 32 }),
		phase: sanitizeValue(details.phase, { remaining: 32 }),
		arguments: sanitizeValue(details.arguments, { remaining: MAX_TRACE_INPUT_CHARS }),
		command: sanitizeValue(details.command, { remaining: 4_096 }),
		timing: sanitizeValue(details.timing, { remaining: 1_024 }),
		progress: {
			output: truncateText(typeof progress.output === "string" ? progress.output : "", MAX_TRACE_TEXT_CHARS),
			outputChars: sanitizeValue(progress.outputChars, { remaining: 64 }),
			originalTokenCount: sanitizeValue(progress.originalTokenCount, { remaining: 64 }),
			outputTruncated: sanitizeValue(progress.outputTruncated, { remaining: 32 }),
		},
		identifiers: sanitizeValue(details.identifiers, { remaining: 2_048 }),
		outcome: sanitizeValue(details.outcome, { remaining: 2_048 }),
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function truncateText(text: string, maximum: number): string {
	if (text.length <= maximum) return text;
	const marker = "\n[Trace value truncated]";
	return `${text.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

interface SerializationBudget {
	remaining: number;
	nodesRemaining?: number;
	seen?: WeakSet<object>;
	depth?: number;
}

function sanitizeValue(value: unknown, budget: SerializationBudget): TraceValue {
	const depth = budget.depth ?? 0;
	const nodesRemaining = budget.nodesRemaining ?? MAX_SERIALIZED_NODES;
	if (nodesRemaining <= 0 || budget.remaining <= 0) return "[value limit]";
	budget.nodesRemaining = nodesRemaining - 1;
	budget.remaining = Math.max(0, budget.remaining - 1);
	if (value === null || typeof value === "boolean") return value;
	if (value === undefined) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "string") {
		const available = Math.max(0, budget.remaining);
		budget.remaining -= Math.min(value.length, available);
		return value.length <= available ? value : `${value.slice(0, Math.max(0, available - 17))}[value truncated]`;
	}
	if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
		return String(value);
	}
	if (depth >= 12) return "[depth limit]";
	if (typeof value !== "object") return String(value);
	const seen = budget.seen ?? new WeakSet<object>();
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (value instanceof Date) return value.toISOString();
	const child = { ...budget, seen, depth: depth + 1 };
	if (Array.isArray(value)) {
		const output: TraceValue[] = [];
		for (const item of value) {
			if (child.remaining <= 0) {
				output.push("[values omitted]");
				break;
			}
			output.push(sanitizeValue(item, child));
		}
		budget.remaining = child.remaining;
		budget.nodesRemaining = child.nodesRemaining;
		return output;
	}
	const output: Record<string, TraceValue> = {};
	let entries: Array<[string, unknown]>;
	try {
		entries = Object.entries(value);
	} catch {
		return "[unavailable object]";
	}
	for (const [key, item] of entries) {
		if (child.remaining <= 0) {
			output.traceTruncated = true;
			break;
		}
		child.remaining = Math.max(0, child.remaining - key.length - 1);
		output[key] = sanitizeValue(item, child);
	}
	budget.remaining = child.remaining;
	budget.nodesRemaining = child.nodesRemaining;
	return output;
}
