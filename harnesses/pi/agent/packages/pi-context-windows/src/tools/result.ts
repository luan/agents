import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type JsonValue, jsonValue } from "../core/state.ts";
export interface ContextToolDetails {
	version: 1;
	tool: string;
	status: "completed";
	input: JsonValue;
	output: JsonValue;
	history?: { itemId: string; text: string }[];
}
// type-boundary: tool schemas and typed operation results enter here; normalize once into serializable presentation data.
type ToolBoundary = unknown;
export function contextResult(
	tool: string,
	input: ToolBoundary,
	output: ToolBoundary,
	history?: ContextToolDetails["history"],
): AgentToolResult<ContextToolDetails> {
	const normalized = jsonValue(output);
	return {
		content: [{ type: "text", text: JSON.stringify(normalized) }],
		details: {
			version: 1,
			tool,
			status: "completed",
			input: jsonValue(input),
			output: normalized,
			...(history ? { history } : {}),
		},
	};
}
