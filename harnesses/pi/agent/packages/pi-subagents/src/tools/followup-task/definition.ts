import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_AGENT_MESSAGE_LENGTH, MAX_AGENT_TARGET_LENGTH } from "../limits.ts";
import { AGENT_TOOLS } from "../names.ts";
import type { CollaborationToolScope } from "../scope.ts";
import { followupTaskResult, type FollowupTaskDetails } from "./result.ts";

const PARAMETERS = Type.Object(
	{
		target: Type.String({
			maxLength: MAX_AGENT_TARGET_LENGTH,
			description: "Agent id or canonical task name to receive the follow-up.",
		}),
		message: Type.String({ maxLength: MAX_AGENT_MESSAGE_LENGTH, description: "Follow-up task text." }),
	},
	{ additionalProperties: false },
);

export function createFollowupTaskTool(
	scope: CollaborationToolScope,
): ToolDefinition<typeof PARAMETERS, FollowupTaskDetails> {
	return {
		name: AGENT_TOOLS.followupTask,
		label: "Follow Up Agent",
		description:
			"Send a follow-up task to an existing non-root agent and trigger a turn when it is idle. A running agent receives it at a message boundary or after its pending tool call.",
		promptGuidelines: [
			"Use followup_task to continue an existing agent instead of spawning a duplicate agent for the same owned work.",
		],
		parameters: PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, parameters) {
			const target = parameters.target.trim();
			const message = parameters.message.trim();
			if (target === "/root") throw new Error("Follow-up tasks cannot target the root agent");
			if (!message) throw new Error("followup_task requires message");
			await scope.coordinator().followUp(scope.callerPath(), target, message);
			return followupTaskResult(target, message);
		},
	};
}
