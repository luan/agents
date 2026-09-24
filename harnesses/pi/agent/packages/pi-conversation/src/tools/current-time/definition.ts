import { requireModelTool } from "../../contributions/model-tool-policy.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ConversationDetails, conversationResult } from "../result.ts";
import { conversationPresentation } from "../presentation.ts";

export function registerCurrentTimeTool(pi: ExtensionAPI): void {
	const parameters = Type.Object({}, { additionalProperties: false });
	const tool: ToolDefinition<typeof parameters, ConversationDetails> = {
		name: "clock__curr_time",
		label: "Current time",
		description: "Return the current time in UTC.",
		parameters,
		...conversationPresentation<typeof parameters>("clock__curr_time"),
		async execute(_id, _args, _signal, _update, ctx) {
			requireModelTool(ctx.sessionManager.getSessionId(), "clock__curr_time");
			const current_time = `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
			return conversationResult({ tool: "clock__curr_time", output: { current_time } });
		},
	};
	pi.registerTool(tool);
}
