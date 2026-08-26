import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_AGENT_MESSAGE_LENGTH, MAX_AGENT_TARGET_LENGTH } from "../limits.ts";
import { AGENT_TOOLS } from "../names.ts";
import type { CollaborationToolScope } from "../scope.ts";
import { sendMessageResult, type SendMessageDetails } from "./result.ts";

const PARAMETERS = Type.Object(
	{
		target: Type.String({
			maxLength: MAX_AGENT_TARGET_LENGTH,
			description: "Relative or canonical task name to message.",
		}),
		message: Type.String({
			maxLength: MAX_AGENT_MESSAGE_LENGTH,
			description: "Message text to queue on the target agent.",
		}),
	},
	{ additionalProperties: false },
);

export function createSendMessageTool(
	scope: CollaborationToolScope,
): ToolDefinition<typeof PARAMETERS, SendMessageDetails> {
	return {
		name: AGENT_TOOLS.sendMessage,
		label: "Send Agent Message",
		description: "Send an explicit interim coordination message to an existing agent without triggering a new turn.",
		promptGuidelines: [
			"Use send_message for coordination or evidence that should reach an existing agent without assigning a new task.",
			"Do not use send_message to duplicate a final response; successful agent completion is delivered automatically.",
		],
		parameters: PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, parameters) {
			const message = parameters.message.trim();
			if (!message) throw new Error("send_message requires message");
			const coordinator = scope.coordinator();
			const target = parameters.target.trim();
			const canonical = target === "/root" ? "/root" : coordinator.resolve(scope.callerPath(), target);
			const own = scope.callerPath() ?? "/root";
			if (!canonical) throw new Error(`No agent matches ${JSON.stringify(target)}`);
			if (canonical === own) throw new Error(`Agent ${own} cannot target itself`);
			await coordinator.sendMessage(scope.callerPath(), canonical, message);
			return sendMessageResult(canonical, message);
		},
	};
}
