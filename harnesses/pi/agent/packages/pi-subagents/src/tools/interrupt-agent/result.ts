import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SubagentStatus } from "../../runtime/coordinator.ts";

export interface InterruptAgentDetails {
	version: 1;
	tool: "interrupt_agent";
	status: "interrupted";
	input: { target: string };
	previousStatus: SubagentStatus;
}

export function interruptAgentResult(
	target: string,
	previousStatus: SubagentStatus,
): AgentToolResult<InterruptAgentDetails> {
	return {
		content: [{ type: "text", text: `Interrupted ${target}. Continue it with followup_task.` }],
		details: {
			version: 1,
			tool: "interrupt_agent",
			status: "interrupted",
			input: { target },
			previousStatus,
		},
	};
}
