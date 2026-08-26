import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface FollowupTaskDetails {
	version: 1;
	tool: "followup_task";
	status: "accepted";
	input: { target: string; message: string };
}

export function followupTaskResult(target: string, message: string): AgentToolResult<FollowupTaskDetails> {
	return {
		content: [{ type: "text", text: `Queued a follow-up task for ${target}.` }],
		details: { version: 1, tool: "followup_task", status: "accepted", input: { target, message } },
	};
}
