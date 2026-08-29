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
			"Spawn an agent for one concrete, bounded task that can run independently. The returned canonical task path remains addressable for messages and follow-up turns. Successful completion is delivered automatically to the direct parent as a hidden FINAL_ANSWER mailbox message.",
		promptSnippet: "Spawn a concurrent child agent for independent work",
		promptGuidelines: [
			"Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.",
			"Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn.",
			"First, quickly analyze the overall user task and form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path, and which tasks are sidecar tasks that are needed but can run in parallel without blocking the next local step. As part of that plan, explicitly decide what immediate task you should do locally right now. Do this planning step before delegating to agents so you do not hand off the immediate blocking task to a submodel and then waste time waiting on it.",
			"Use a subagent when a subtask is easy enough for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounded sidecar tasks that materially advance the main task without blocking your immediate next local step.",
			"Do not delegate urgent blocking work when your immediate next step depends on that result. If the very next action is blocked on that task, the main rollout should usually do it locally to keep the critical path moving.",
			"Keep work local when the subtask is too difficult to delegate well and when it is tightly coupled, urgent, or likely to block your immediate next step.",
			"Subtasks must be concrete, well-defined, and self-contained.",
			"Delegated subtasks must materially advance the main task.",
			"Do not duplicate work between the main rollout and delegated subtasks.",
			"Avoid issuing multiple delegate calls on the same unresolved thread unless the new delegated task is genuinely different and necessary.",
			"Narrow the delegated ask to the concrete output you need next.",
			"Define file or responsibility ownership in spawn_agent messages when multiple agents may edit the same codebase.",
			"Call wait_agent very sparingly. Only call wait_agent when you need the result immediately for the next critical-path step and you are blocked until it returns.",
			"Do not redo delegated subagent tasks yourself; focus on integrating results or tackling non-overlapping work.",
			"While the subagent is running in the background, do meaningful non-overlapping work immediately.",
			"Do not ask the child to send its final response; successful completion is delivered automatically to its direct parent.",
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
