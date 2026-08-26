import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ForkTurns } from "../../core/fork-history.ts";
import type { SubagentSnapshot } from "../../runtime/coordinator.ts";
import { agentRecord, type AgentRecord, type TruncationDetails } from "../result.ts";

export interface SpawnAgentDetails {
	version: 1;
	tool: "spawn_agent";
	status: "queued" | "running";
	input: {
		taskName: string;
		message: string;
		forkTurns: ForkTurns;
		modelRole?: string;
	};
	agent: AgentRecord;
	truncation: TruncationDetails;
}

export function spawnAgentResult(
	agent: SubagentSnapshot,
	input: SpawnAgentDetails["input"],
): AgentToolResult<SpawnAgentDetails> {
	const bounded = agentRecord(agent);
	return {
		content: [{ type: "text", text: `Started agent ${agent.id} asynchronously. Use wait_agent for updates.` }],
		details: {
			version: 1,
			tool: "spawn_agent",
			status: agent.status === "queued" ? "queued" : "running",
			input,
			agent: bounded.record,
			truncation: { agentsOmitted: 0, textCharactersOmitted: bounded.textCharactersOmitted },
		},
	};
}
