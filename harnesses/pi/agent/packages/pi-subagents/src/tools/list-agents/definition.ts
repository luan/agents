import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_PATH_PREFIX_LENGTH } from "../limits.ts";
import { AGENT_TOOLS } from "../names.ts";
import type { CollaborationToolScope } from "../scope.ts";
import { listAgentsResult, type ListAgentsDetails } from "./result.ts";

const PARAMETERS = Type.Object(
	{
		path_prefix: Type.Optional(
			Type.String({
				maxLength: MAX_PATH_PREFIX_LENGTH,
				description: "Task-path prefix filter without a trailing slash. Omit to list all live agents.",
			}),
		),
	},
	{ additionalProperties: false },
);

export function createListAgentsTool(
	scope: CollaborationToolScope,
): ToolDefinition<typeof PARAMETERS, ListAgentsDetails> {
	return {
		name: AGENT_TOOLS.listAgents,
		label: "List Agents",
		description: "List agents in the current root task tree, optionally filtered by task-path prefix.",
		parameters: PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, parameters) {
			const pathPrefix = parameters.path_prefix?.trim() || undefined;
			if (pathPrefix?.endsWith("/")) throw new Error("path_prefix must not end with /");
			const agents = scope
				.coordinator()
				.snapshot()
				.filter((agent) => !pathPrefix || agent.id.startsWith(pathPrefix));
			return listAgentsResult(agents, pathPrefix);
		},
	};
}
