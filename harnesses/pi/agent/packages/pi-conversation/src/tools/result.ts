import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
export type ConversationOutput =
	| { accepted: true }
	| { current_time: string }
	| { elapsed_ms: number; reason: "elapsed" | "input" | "cancelled" };
export type ConversationDetails =
	| ConversationCompletedDetails
	| {
			version: 1;
			tool: "clock__sleep";
			status: "running";
			duration_ms: number;
	  };
export interface ConversationCompletedDetails {
	version: 1;
	tool: string;
	status: "completed";
	output: ConversationOutput;
	id?: string;
	message?: string;
	duration_ms?: number;
	questions?: { title: string; options?: string[] }[];
}
export function conversationResult(
	details: Omit<ConversationCompletedDetails, "version" | "status">,
): AgentToolResult<ConversationDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify(details.output) }],
		details: { version: 1, status: "completed", ...details },
	};
}
