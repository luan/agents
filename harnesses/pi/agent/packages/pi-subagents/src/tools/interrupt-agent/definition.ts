import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_AGENT_TARGET_LENGTH } from "../limits.ts";
import { AGENT_TOOLS } from "../names.ts";
import type { CollaborationToolScope } from "../scope.ts";
import { interruptAgentResult, type InterruptAgentDetails } from "./result.ts";

const PARAMETERS = Type.Object(
	{
		target: Type.String({
			maxLength: MAX_AGENT_TARGET_LENGTH,
			description: "Agent id or canonical task name to interrupt.",
		}),
	},
	{ additionalProperties: false },
);

export function createInterruptAgentTool(
	scope: CollaborationToolScope,
): ToolDefinition<typeof PARAMETERS, InterruptAgentDetails> {
	return {
		name: AGENT_TOOLS.interruptAgent,
		label: "Interrupt Agent",
		description:
			"Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
		parameters: PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, parameters) {
			const coordinator = scope.coordinator();
			const requested = parameters.target.trim();
			const canonical = coordinator.resolve(scope.callerPath(), requested);
			if (!canonical) throw new Error(`No agent matches ${JSON.stringify(requested)}`);
			const previous = await coordinator.interrupt(scope.callerPath(), canonical);
			return interruptAgentResult(canonical, previous);
		},
	};
}
