import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "../../runtime/coordinator.ts";
import { agentRecords, type AgentRecord, type TruncationDetails } from "../result.ts";

export interface ListAgentsDetails {
	version: 1;
	tool: "list_agents";
	status: "listed";
	input: { pathPrefix?: string };
	agents: AgentRecord[];
	truncation: TruncationDetails;
}

export function listAgentsResult(
	agents: readonly SubagentSnapshot[],
	pathPrefix: string | undefined,
): AgentToolResult<ListAgentsDetails> {
	const bounded = agentRecords(agents);
	return {
		content: [{ type: "text", text: JSON.stringify(bounded.records, null, 2) }],
		details: {
			version: 1,
			tool: "list_agents",
			status: "listed",
			input: { pathPrefix },
			agents: bounded.records,
			truncation: bounded.truncation,
		},
	};
}
