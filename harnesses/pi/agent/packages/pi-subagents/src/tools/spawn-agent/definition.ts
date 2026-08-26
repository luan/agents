import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseForkTurns } from "../../core/fork-history.ts";
import type { AgentConfig } from "../../core/types.ts";
import { MAX_AGENT_MESSAGE_LENGTH, MAX_TASK_NAME_LENGTH } from "../limits.ts";
import { AGENT_TOOLS } from "../names.ts";
import type { CollaborationToolScope } from "../scope.ts";
import { spawnAgentResult, type SpawnAgentDetails } from "./result.ts";

const PARAMETERS = Type.Object(
	{
		task_name: Type.String({
			maxLength: MAX_TASK_NAME_LENGTH,
			description: "Task name for the new agent. Use lowercase letters, digits, and dashes.",
		}),
		message: Type.String({
			maxLength: MAX_AGENT_MESSAGE_LENGTH,
			description: "Initial plain-text task for the new agent.",
		}),
		fork_turns: Type.Optional(
			Type.String({
				maxLength: 16,
				description:
					"Optional number of turns to fork. Defaults to all. Use none, all, or a positive integer string such as 3.",
			}),
		),
		model_role: Type.Optional(
			Type.String({
				maxLength: MAX_TASK_NAME_LENGTH,
				description: "Model role override. Omit to use the configured subagent default role.",
			}),
		),
	},
	{ additionalProperties: false },
);

export function normalizeTaskName(value: string): string {
	const name = value.trim();
	if (name.length > MAX_TASK_NAME_LENGTH)
		throw new Error(`task_name must be at most ${MAX_TASK_NAME_LENGTH} characters`);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		throw new Error("task_name must use lowercase letters, digits, and single dashes between words");
	}
	return name;
}

export function createSpawnAgentTool(
	scope: CollaborationToolScope,
): ToolDefinition<typeof PARAMETERS, SpawnAgentDetails> {
	const catalog = scope.modelRoles();
	const roles = catalog.roles.map((role) => `${role.name}: ${role.description}`).join("; ");
	return {
		name: AGENT_TOOLS.spawnAgent,
		label: "Spawn Agent",
		description:
			`${roles ? `Available model roles: ${roles}.\n` : ""}` +
			"Spawn an agent for one concrete, bounded task that can run independently. The returned canonical task path remains addressable for messages and follow-up turns.",
		promptSnippet: "Spawn a concurrent child agent for independent work",
		promptGuidelines: [
			"Use spawn_agent only when the delegated task is concrete, bounded, and can run independently alongside useful local work.",
			"Define file or responsibility ownership in spawn_agent messages when multiple agents may edit the same codebase.",
		],
		parameters: PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, parameters, signal, _onUpdate, context) {
			const taskName = normalizeTaskName(parameters.task_name);
			const message = parameters.message.trim();
			if (!message) throw new Error("spawn_agent requires message");
			const currentCatalog = scope.modelRoles();
			const modelRole = parameters.model_role?.trim() || currentCatalog.subagentDefaultRole;
			if (modelRole && !currentCatalog.roles.some((role) => role.name === modelRole)) {
				throw new Error(`Unknown model role: ${modelRole}`);
			}
			const forkTurns = parseForkTurns(parameters.fork_turns);
			const agentConfig: AgentConfig = modelRole ? { role: modelRole } : {};
			const coordinator = scope.coordinator();
			const id = coordinator.spawn(scope.callerPath(), {
				taskName,
				message,
				pi: scope.pi,
				ctx: context,
				agentConfig,
				forkTurns,
				signal,
			});
			const agent = coordinator.snapshot().find((candidate) => candidate.id === id);
			if (!agent) throw new Error(`Agent ${id} was not registered`);
			return spawnAgentResult(agent, { taskName, message, forkTurns, modelRole: modelRole || undefined });
		},
	};
}
