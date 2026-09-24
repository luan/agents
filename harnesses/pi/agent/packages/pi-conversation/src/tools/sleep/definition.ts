import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Conversation } from "../../runtime/conversation.ts";
import { type ConversationDetails, conversationResult } from "../result.ts";
import { conversationPresentation } from "../presentation.ts";

const parameters = Type.Object(
	{
		duration_ms: Type.Integer({
			minimum: 1,
			maximum: 43200000,
			description: "How long to sleep in milliseconds. Must be between 1 and 43200000.",
		}),
	},
	{ additionalProperties: false },
);
export function registerSleepTool(pi: ExtensionAPI, conversation: Conversation): void {
	const tool: ToolDefinition<typeof parameters, ConversationDetails> = {
		name: "clock__sleep",
		label: "Wait",
		description:
			"Pause execution for a specified duration. The sleep ends early when new input arrives for the active turn. Returns the elapsed wall-clock time.",
		parameters,
		...conversationPresentation<typeof parameters>("clock__sleep"),
		executionMode: "sequential",
		async execute(_id, args, signal, update, ctx) {
			update?.({
				content: [],
				details: { version: 1, tool: "clock__sleep", status: "running", duration_ms: args.duration_ms },
			});
			const output = await conversation.sleep(ctx, args.duration_ms, signal);
			const result = conversationResult({
				tool: "clock__sleep",
				duration_ms: args.duration_ms,
				output,
			});
			result.content = [
				{
					type: "text",
					text: `Wall time: ${(output.elapsed_ms / 1000).toFixed(4)} seconds\n${output.reason === "elapsed" ? "Sleep completed." : output.reason === "input" ? "Sleep interrupted by new input." : "Sleep cancelled."}`,
				},
			];
			return result;
		},
	};
	pi.registerTool(tool);
}
