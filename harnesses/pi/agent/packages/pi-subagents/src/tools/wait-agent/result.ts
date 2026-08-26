import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export type WaitOutcome = "none" | "aborted" | "updated" | "timeout";

export interface WaitAgentDetails {
	version: 1;
	tool: "wait_agent";
	status: WaitOutcome;
	input: { timeoutMs: number };
	update?: { target?: string; agentStatus?: string };
	timing: { durationMs: number };
}

export function waitAgentResult(input: {
	text: string;
	outcome: WaitOutcome;
	timeoutMs: number;
	durationMs: number;
	target?: string;
	agentStatus?: string;
}): AgentToolResult<WaitAgentDetails> {
	return {
		content: [{ type: "text", text: input.text }],
		details: {
			version: 1,
			tool: "wait_agent",
			status: input.outcome,
			input: { timeoutMs: input.timeoutMs },
			update: input.target || input.agentStatus ? { target: input.target, agentStatus: input.agentStatus } : undefined,
			timing: { durationMs: input.durationMs },
		},
	};
}
