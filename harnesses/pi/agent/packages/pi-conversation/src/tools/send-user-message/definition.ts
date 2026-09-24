import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Conversation } from "../../runtime/conversation.ts";
import { type ConversationDetails, conversationResult } from "../result.ts";
import { conversationPresentation } from "../presentation.ts";

const parameters = Type.Object(
	{
		message: Type.String({ description: "The concise question or update to send to the user." }),
	},
	{ additionalProperties: false },
);
export function registerMessageTool(pi: ExtensionAPI, conversation: Conversation): void {
	const tool: ToolDefinition<typeof parameters, ConversationDetails> = {
		name: "send_message_to_user_async",
		label: "Message user",
		description:
			"Send a concise message that needs the user's attention during ongoing work. The tool returns immediately without ending the turn or waiting for a reply; any reply arrives asynchronously as a new user message. Use this tool to report a critical blocker or a finding that may change the task's direction, or to answer a user question or status request received while work is still in progress. Use this tool when a message needs the user's immediate attention; use commentary for routine progress and intermediate context. Use clear formatting, such as bolding questions, to make requests easy to notice and answer.",
		parameters,
		...conversationPresentation<typeof parameters>("send_message_to_user_async"),
		async execute(id, args, _signal, _update, ctx) {
			conversation.message(ctx, id, args.message);
			return conversationResult({
				tool: "send_message_to_user_async",
				id,
				message: args.message,
				output: { accepted: true },
			});
		},
	};
	pi.registerTool(tool);
}
