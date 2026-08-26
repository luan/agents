import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface SendMessageDetails {
	version: 1;
	tool: "send_message";
	status: "queued";
	input: { target: string; message: string };
}

export function sendMessageResult(target: string, message: string): AgentToolResult<SendMessageDetails> {
	return {
		content: [{ type: "text", text: `Queued a message for ${target}.` }],
		details: { version: 1, tool: "send_message", status: "queued", input: { target, message } },
	};
}
