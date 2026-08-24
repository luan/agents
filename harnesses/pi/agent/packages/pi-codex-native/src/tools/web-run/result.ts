import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { boundedWebRunDiagnostic } from "./native.ts";
import type { WebRunParameters } from "./schema.ts";

const MAX_OUTPUT_CHARS = 200_000;
const MAX_SEARCH_RESULTS_CHARS = 1_000_000;

export type WebRunResult = Record<string, unknown> & { output_text?: unknown };
export interface WebRunToolDetails {
	version: 1;
	tool: "web__run";
	status: "completed";
	request: WebRunParameters;
	model: string;
	sessionId?: string;
	timing: { startedAtMs: number; durationMs: number };
	output: {
		textChars: number;
		originalTextChars: number;
		textTruncated: boolean;
		searchResultsTruncated: boolean;
		stdoutBytes: number;
	};
	result: WebRunResult;
}

export function createWebRunResult(input: {
	stdout: string;
	request: WebRunParameters;
	model: string;
	sessionId?: string;
	startedAtMs: number;
}): AgentToolResult<WebRunToolDetails> {
	let value: unknown;
	try {
		value = JSON.parse(input.stdout);
	} catch {
		throw new Error(`web_run returned invalid JSON: ${boundedWebRunDiagnostic(input.stdout)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("web_run returned a non-object result");
	const result = { ...(value as WebRunResult) };
	if (typeof result.output_text !== "string" || !result.output_text.trim())
		throw new Error("web_run returned no output_text");
	const originalTextChars = result.output_text.length;
	const textTruncated = originalTextChars > MAX_OUTPUT_CHARS;
	const text = textTruncated
		? `${result.output_text.slice(0, MAX_OUTPUT_CHARS)}\n[web_run output truncated]`
		: result.output_text;
	result.output_text = text;
	const searchResultsTruncated =
		"search_results" in result && JSON.stringify(result.search_results).length > MAX_SEARCH_RESULTS_CHARS;
	if (searchResultsTruncated) {
		result.search_results = [];
		result.search_results_truncated = true;
	}
	return {
		content: [{ type: "text", text }],
		details: {
			version: 1,
			tool: "web__run",
			status: "completed",
			request: { ...input.request },
			model: input.model,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			timing: { startedAtMs: input.startedAtMs, durationMs: Date.now() - input.startedAtMs },
			output: {
				textChars: text.length,
				originalTextChars,
				textTruncated,
				searchResultsTruncated,
				stdoutBytes: Buffer.byteLength(input.stdout),
			},
			result,
		},
	};
}
