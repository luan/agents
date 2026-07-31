import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { bold, framedBlock, renderStatusLine, styledSymbol, textComponent, treeGlyphs } from "../shared/tui/omp-card";
import { findRetryableTurn } from "./runtime/agent-runner.js";
import {
	deliverPendingForSession,
	getSessionRuntime,
	getSharedAgentActivity,
	getSharedAgentManager,
	persistAgent,
	registerAgentWidget,
	registerSessionBinding,
	unregisterAgentWidget,
	unregisterSessionBinding,
} from "./runtime/coordinator.js";
import { loadCustomAgents } from "./runtime/custom-agents.js";
import { readAgentRegistry, writeAgentRegistry } from "./runtime/persistence.js";
import type { AgentConfig, AgentRecord, SubagentType } from "./runtime/types.js";
import { openAgentBrowser, openAgentInspector } from "./runtime/ui/agent-browser.js";
import { type AgentActivity, AgentWidget } from "./runtime/ui/agent-widget.js";
import type { AssistantUsage } from "./runtime/usage.js";

type TaskItem = {
	id?: string;
	description?: string;
	role?: string;
	assignment: string;
	isolated?: boolean;
};

type TaskParams = {
	agent: string;
	context?: string;
	tasks?: TaskItem[];
	id?: string;
	description?: string;
	role?: string;
	assignment?: string;
	isolated?: boolean;
	background?: boolean;
};

export type TaskResult = {
	index: number;
	id: string;
	agent: string;
	description?: string;
	role?: string;
	assignment: string;
	status: AgentRecord["status"];
	output?: string;
	error?: string;
	durationMs: number;
	toolUses: number;
	worktree?: AgentRecord["worktree"];
	worktreeResult?: AgentRecord["worktreeResult"];
};

type ToolTheme = ExtensionContext["ui"]["theme"];

function statusMarker(status: AgentRecord["status"] | "pending", theme: ToolTheme): string {
	switch (status) {
		case "completed":
			return styledSymbol(theme, "status.success", "success");
		case "running":
			return styledSymbol(theme, "tool.task", "accent");
		case "queued":
		case "pending":
			return styledSymbol(theme, "status.pending", "muted");
		case "steered":
			return styledSymbol(theme, "status.warning", "warning");
		case "interrupted":
			return styledSymbol(theme, "status.warning", "warning");
		case "aborted":
		case "stopped":
		case "error":
			return styledSymbol(theme, "status.error", "error");
	}
}

function taskCallItems(params: Partial<TaskParams>): TaskItem[] {
	if (Array.isArray(params.tasks)) return params.tasks;
	if (params.assignment || params.id || params.description || params.role) {
		return [
			{
				id: params.id,
				description: params.description,
				role: params.role,
				assignment: params.assignment ?? "",
				isolated: params.isolated,
			},
		];
	}
	return [];
}

function renderTaskCall(args: unknown, theme: ToolTheme): Component {
	const params = args as Partial<TaskParams>;
	const items = taskCallItems(params);
	return textComponent(
		renderStatusLine(theme, {
			icon: "pending",
			title: items.length === 1 ? "Agent" : "Agents",
			description: params.agent,
			meta: items.length ? [`${items.length} ${items.length === 1 ? "agent" : "agents"}`] : undefined,
		}),
	);
}

function compactTaskResults(results: TaskResult[]): string {
	const failed = results.filter((result) => result.status === "error" || result.error).length;
	const suffix = failed > 0 ? `, ${failed} failed` : "";
	return `Completed ${results.length} agent${results.length === 1 ? "" : "s"}${suffix}.`;
}

function renderTaskResult(
	result: { details?: { results?: TaskResult[]; result?: TaskResult; completed?: number; total?: number } },
	_options: { isPartial?: boolean } | undefined,
	theme: ToolTheme,
): Component {
	const results = Array.isArray(result.details?.results)
		? result.details.results
		: result.details?.result
			? [result.details.result]
			: [];
	if (results.length === 0 && result.details?.total) {
		return textComponent(
			renderStatusLine(theme, {
				icon: "pending",
				title: "Subagents",
				description: `${result.details.completed ?? 0}/${result.details.total} subagents`,
			}),
		);
	}
	const failed = results.some((item) => item.status === "error" || item.error);
	const active = results.some((item) => item.status === "running" || item.status === "queued");
	return textComponent(
		renderStatusLine(theme, {
			icon: failed ? "error" : active ? "pending" : "success",
			title: results.length === 1 ? "Agent" : "Agents",
			description: results.length
				? active
					? `Started ${results.length} background agent${results.length === 1 ? "" : "s"}.`
					: compactTaskResults(results)
				: "No agent result.",
		}),
	);
}

function singleLinePreview(text: string, width: number): string {
	const line = text
		.split(/\r?\n/)
		.find((candidate) => candidate.trim())
		?.trim();
	return line ? truncateToWidth(line, width) : "";
}

export function renderSubagentList(
	result: {
		details?: { agents?: Array<Pick<AgentRecord, "id" | "type" | "description" | "status" | "result" | "error">> };
	},
	_options: unknown,
	theme: ToolTheme,
): Component {
	const agents = result.details?.agents ?? [];
	const tree = treeGlyphs(theme);
	const lines: string[] = [];
	if (agents.length === 0) lines.push(theme.fg("dim", "No subagents in this session."));
	agents.forEach((agent, index) => {
		const isLast = index === agents.length - 1;
		lines.push(
			`${theme.fg("dim", isLast ? tree.last : tree.branch)} ${statusMarker(agent.status, theme)} ${theme.fg(
				"accent",
				bold(theme, agent.id),
			)} ${theme.fg("muted", `${agent.type} · ${truncateToWidth(agent.description, 56)}`)}`,
		);
		const output = agent.error || agent.result?.trim();
		if (output)
			lines.push(
				`${theme.fg("dim", isLast ? "  " : `${tree.vertical} `)}${theme.fg("dim", singleLinePreview(output, 82))}`,
			);
	});
	return framedBlock(theme, {
		header: renderStatusLine(theme, {
			iconOverride: styledSymbol(theme, "tool.task", "accent"),
			title: "Subagents",
			meta: [`${agents.length} total`],
		}),
		sections: [{ lines }],
		borderColor: "borderMuted",
	});
}

const taskAgentPrompt = `You are a worker agent for delegated tasks.

You have FULL access to all available tools and MUST use them as needed to complete your task.

<directives>
- Finish only the assigned work and return the minimum useful result.
- Prefer narrow lookups, then read only needed ranges. Avoid full-file reads unless necessary.
- Prefer edits to existing files over creating new files.
- Never create documentation files (*.md) unless explicitly requested.
- Skip project-wide gates, formatters, builds, and broad test suites unless explicitly assigned; the parent agent owns final verification.
- Delegate independent subtasks with spawn_agent when useful, then integrate child results before finishing.
- Be concise. Do not include filler, repetition, or tool transcripts.
</directives>`;
const readOnlyDisallowedTools = [
	"apply_patch",
	"ast_edit",
	"bash",
	"edit",
	"followup_task",
	"send_message",
	"spawn_agent",
	"stop_agent",
	"task_write",
	"write",
	"write_stdin",
];

const bundledAgents: AgentConfig[] = [
	{
		name: "task",
		description: "General-purpose implementation agent",
		modelCategory: "default",
		extensions: true,
		skills: false,
		promptMode: "append",
		systemPrompt: taskAgentPrompt,
		source: "default",
		isDefault: true,
	},
	{
		name: "explore",
		description: "Fast read-only codebase and documentation scout",
		modelCategory: "fast",
		disallowedTools: readOnlyDisallowedTools,
		extensions: true,
		skills: false,
		promptMode: "replace",
		systemPrompt:
			"Investigate rapidly. Search broadly, read key sections, and return concise findings with exact source paths. Read-only: never write, edit, or run state-changing commands.",
		source: "default",
		isDefault: true,
	},
	{
		name: "plan",
		description: "Read-only implementation planner for complex changes",
		modelCategory: "smart",
		disallowedTools: readOnlyDisallowedTools,
		extensions: true,
		skills: false,
		promptMode: "replace",
		systemPrompt:
			"Analyze requirements and code, then produce a concise implementation plan covering changes, sequence, edge cases, verification, and critical files. Read-only: do not modify files.",
		source: "default",
		isDefault: true,
	},
	{
		name: "reviewer",
		description: "Read-only code review agent",
		modelCategory: "smart",
		disallowedTools: readOnlyDisallowedTools,
		extensions: true,
		skills: false,
		promptMode: "replace",
		systemPrompt:
			"Identify bugs the author would want fixed before merge. Report only provable, actionable issues introduced by the change. Never edit files or run state-changing commands.",
		source: "default",
		isDefault: true,
	},
];

function loadAgents(cwd: string): Map<string, AgentConfig> {
	const agents = new Map(bundledAgents.map((agent) => [agent.name, agent]));
	for (const [name, agent] of loadCustomAgents(cwd)) agents.set(name, agent);
	return agents;
}

function normalizeItems(params: TaskParams): TaskItem[] {
	if (!params.agent?.trim()) throw new Error("subagent requires agent");
	if (Array.isArray(params.tasks)) {
		if (params.assignment?.trim()) throw new Error("subagent accepts either tasks[] or assignment, not both");
		if (params.tasks.length === 0) throw new Error("subagent requires at least one tasks[] item");
		if (!params.context?.trim()) throw new Error("batch task calls require non-empty context");
		const ids = new Set<string>();
		return params.tasks.map((item, index) => {
			const assignment = item.assignment?.trim();
			if (!assignment) throw new Error(`tasks[${index}].assignment is required`);
			if (item.id) {
				const normalized = item.id.toLowerCase();
				if (ids.has(normalized)) throw new Error(`duplicate task id: ${item.id}`);
				ids.add(normalized);
			}
			return { ...item, assignment };
		});
	}
	const assignment = params.assignment?.trim();
	if (!assignment) throw new Error("subagent requires assignment or tasks[]");
	return [
		{
			id: params.id,
			description: params.description,
			role: params.role,
			assignment,
			isolated: params.isolated,
		},
	];
}

function taskName(item: TaskItem, index: number): string {
	return item.id?.trim() || item.description?.trim() || item.role?.trim() || `Subagent-${index + 1}`;
}

function assignmentPrompt(context: string | undefined, item: TaskItem): string {
	const sections: string[] = [];
	if (item.role?.trim()) sections.push(`ROLE\n===================================\n${item.role.trim()}`);
	if (context?.trim()) sections.push(`CONTEXT\n===================================\n${context.trim()}`);
	sections.push(`ASSIGNMENT\n===================================\n${item.assignment.trim()}`);
	sections.push(
		`COMPLETION\n===================================\nNo progress updates. Execute the assignment, then return only the useful handoff: files changed, decisions made, verification you performed, blockers, and follow-up needed.`,
	);
	return sections.join("\n\n");
}

function resultFromRecord(record: AgentRecord, item: TaskItem, index: number, agent: string): TaskResult {
	return {
		index,
		id: record.id,
		agent,
		description: item.description,
		role: item.role,
		assignment: item.assignment,
		status: record.status,
		output: record.result,
		error: record.error,
		durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
		toolUses: record.toolUses,
		worktree: record.worktree,
		worktreeResult: record.worktreeResult,
	};
}

const MODEL_VISIBLE_RESULT_LIMIT = 50 * 1024;

export function formatTaskResults(results: TaskResult[]): string {
	return results
		.map((result) => {
			const heading = `## ${result.description?.trim() || result.id} (${result.status})`;
			const fullOutput = result.error ? `Error: ${result.error}` : result.output?.trim() || "No output.";
			const output =
				fullOutput.length > MODEL_VISIBLE_RESULT_LIMIT
					? `${fullOutput.slice(0, MODEL_VISIBLE_RESULT_LIMIT)}\n\n[Output truncated; full output remains in agent history.]`
					: fullOutput;
			return `${heading}\n${output}`;
		})
		.join("\n\n");
}

function ensureActivity(activityByAgent: Map<string, AgentActivity>, id: string): AgentActivity {
	let activity = activityByAgent.get(id);
	if (!activity) {
		activity = {
			activeTools: new Map(),
			toolUses: 0,
			responseText: "",
			turnCount: 0,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
		};
		activityByAgent.set(id, activity);
	}
	return activity;
}

function addActivityUsage(activity: AgentActivity, usage: AssistantUsage): void {
	activity.lifetimeUsage.input += usage.input;
	activity.lifetimeUsage.output += usage.output;
	activity.lifetimeUsage.cacheWrite += usage.cacheWrite;
	activity.lifetimeUsage.cost += usage.cost;
}

const taskItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable agent id, CamelCase, <=32 chars preferred." })),
	description: Type.Optional(Type.String({ description: "UI label only; the subagent never sees it." })),
	role: Type.Optional(Type.String({ description: "Specialist identity for the subagent." })),
	assignment: Type.String({ description: "Complete self-contained instructions." }),
	isolated: Type.Optional(Type.Boolean({ description: "Run in an isolated worktree." })),
});

export function getActiveSubagentDescriptions(): string[] {
	return getSharedAgentManager()
		.listAgents()
		.filter((agent) => agent.status === "running")
		.map((agent) => agent.description.trim())
		.filter(Boolean);
}

function resolveAgentConfig(agents: Map<string, AgentConfig>, requested: string): AgentConfig | undefined {
	const exact = agents.get(requested);
	if (exact?.enabled !== false) return exact;
	const lower = requested.toLowerCase();
	return [...agents.values()].find((agent) => agent.enabled !== false && agent.name.toLowerCase() === lower);
}

export function shouldOwnAgentWidget(
	manager: Pick<ReturnType<typeof getSharedAgentManager>, "findByChildSessionId">,
	sessionId: string,
	hasUI: boolean,
): boolean {
	return hasUI && !manager.findByChildSessionId(sessionId);
}

export default function subagentsExtension(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	const manager = getSharedAgentManager();
	const activityByAgent = getSharedAgentActivity();
	let currentAgents = new Map<string, AgentConfig>();
	const visibleRecords = (ctx: ExtensionContext): AgentRecord[] => {
		const sessionId = ctx.sessionManager.getSessionId();
		const owner = manager.findByChildSessionId(sessionId);
		return manager
			.listAgents(manager.getRootSessionId(sessionId))
			.filter((record) => !owner || record.id.startsWith(`${owner.id}/`));
	};
	const findOwnedRecord = (ctx: ExtensionContext, id: string): AgentRecord | undefined => {
		const records = visibleRecords(ctx);
		return records.find((record) => record.id === id) ?? records.find((record) => record.id.startsWith(id));
	};
	const agentWidget = new AgentWidget(
		manager,
		activityByAgent,
		() => manager.listAgents().filter((agent) => !agent.isBackground),
		() => (currentCtx ? manager.getRootSessionId(currentCtx.sessionManager.getSessionId()) : undefined),
	);

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		const sessionId = ctx.sessionManager.getSessionId();
		const owner = manager.findByChildSessionId(sessionId);
		const rootSessionId = owner?.rootSessionId ?? sessionId;
		if (!owner) manager.restore(readAgentRegistry(rootSessionId));
		writeAgentRegistry(rootSessionId, manager.listAgents(rootSessionId));
		currentAgents = loadAgents(ctx.cwd);
		registerSessionBinding(pi, ctx);
		if (shouldOwnAgentWidget(manager, sessionId, ctx.hasUI)) {
			registerAgentWidget(agentWidget);
			agentWidget.setUICtx(ctx.ui);
			agentWidget.update();
		}
		deliverPendingForSession(sessionId);
	});

	pi.on("session_shutdown", async () => {
		if (currentCtx) unregisterSessionBinding(currentCtx);
		unregisterAgentWidget(agentWidget);
		agentWidget.dispose();
		currentCtx = undefined;
	});

	pi.registerCommand("subagents", {
		description: "Browse and inspect the current agent tree",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await openAgentBrowser(ctx, visibleRecords(ctx));
		},
	});

	pi.registerCommand("subagent", {
		description: "Inspect a subagent by id",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const target = args.trim();
			const record = findOwnedRecord(ctx, target);
			await openAgentInspector(ctx, record);
		},
	});

	pi.registerCommand("retry", {
		description: "Retry the failed main turn, or a failed subagent by id",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await ctx.waitForIdle();
			const target = args.trim();
			const retryMain = !target || target === "main";
			const mainTurn = findRetryableTurn(ctx.sessionManager.getBranch());

			if (retryMain && mainTurn) {
				const navigation = await ctx.navigateTree(mainTurn.userEntryId);
				if (navigation.cancelled) {
					ctx.ui.notify("Retry cancelled.", "warning");
					return;
				}
				ctx.ui.setEditorText("");
				pi.sendUserMessage(mainTurn.content as Parameters<ExtensionAPI["sendUserMessage"]>[0]);
				return;
			}
			if (target === "main") {
				ctx.ui.notify("No failed main-session turn is available to retry.", "warning");
				return;
			}
			const record = target
				? findOwnedRecord(ctx, target)
				: visibleRecords(ctx).find(
						(agent) => agent.session && findRetryableTurn(agent.session.sessionManager.getBranch()),
					);
			if (!record) {
				ctx.ui.notify("No retryable subagent found.", "warning");
				return;
			}
			record.completionDelivered = true;
			const retried = await manager.retry(pi, ctx, record.id, {
				onAssistantUsage: () => {},
			});
			if (!retried) {
				ctx.ui.notify(`Subagent ${record.id} is not retryable.`, "warning");
				return;
			}
			persistAgent(retried);
			agentWidget.update();
			ctx.ui.notify(
				retried.error ? retried.error : `Subagent ${retried.id} completed after retry.`,
				retried.error ? "error" : "info",
			);
		},
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn one or many native Pi agents. Background completion is automatic. After spawning in the background, end the turn instead of polling, listing agents, or sleeping.",
		promptSnippet: "Spawn agents",
		renderShell: "self",
		renderCall: renderTaskCall,
		renderResult: renderTaskResult,
		parameters: Type.Object({
			agent: Type.String({
				description: "Agent type: task, explore, plan, reviewer, or a custom agent.",
			}),
			context: Type.Optional(Type.String({ description: "Shared context prepended to every tasks[] item." })),
			tasks: Type.Optional(Type.Array(taskItemSchema, { description: "One agent per item." })),
			id: Type.Optional(Type.String({ description: "Single-spawn display name." })),
			description: Type.Optional(Type.String({ description: "Single-spawn UI label." })),
			role: Type.Optional(Type.String({ description: "Single-spawn specialist identity." })),
			assignment: Type.Optional(Type.String({ description: "Single-spawn complete assignment." })),
			isolated: Type.Optional(Type.Boolean({ description: "Use an isolated git worktree." })),
			background: Type.Optional(
				Type.Boolean({ description: "Return immediately and notify on completion. Default true." }),
			),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			currentCtx = ctx;
			currentAgents = loadAgents(ctx.cwd);
			const taskParams = params as TaskParams;
			const items = normalizeItems(taskParams);
			const background = taskParams.background !== false;
			const parentSessionId = ctx.sessionManager.getSessionId();
			if (shouldOwnAgentWidget(manager, parentSessionId, ctx.hasUI)) agentWidget.setUICtx(ctx.ui);
			const parentAgent = manager.findByChildSessionId(parentSessionId);
			const rootSessionId = parentAgent?.rootSessionId ?? parentSessionId;
			const agentConfig = resolveAgentConfig(currentAgents, taskParams.agent);
			if (!agentConfig) throw new Error(`Unknown or disabled agent type: ${taskParams.agent}`);
			let completed = 0;
			const spawned = items.map((item, index) => {
				const name = taskName(item, index);
				const prompt = assignmentPrompt(taskParams.context, item);
				let id = name;
				try {
					id = manager.spawn(pi, ctx, agentConfig.name as SubagentType, prompt, {
						description: name,
						id: item.id,
						agentConfig,
						resolveRuntime: () => getSessionRuntime(parentSessionId, rootSessionId),
						rootSessionId,
						parentAgentId: parentAgent?.id,
						parentSessionId,
						assignment: prompt,
						isBackground: background,
						isolation: item.isolated ? "worktree" : undefined,
						signal: background ? undefined : signal,
						onToolActivity: (tool) => {
							const activity = ensureActivity(activityByAgent, id);
							if (tool.type === "start") activity.activeTools.set(tool.toolName, tool.toolName);
							else {
								activity.activeTools.delete(tool.toolName);
								activity.toolUses++;
							}
							agentWidget.update();
						},
						onTextDelta: (_delta, fullText) => {
							ensureActivity(activityByAgent, id).responseText = fullText;
							agentWidget.update();
						},
						onSessionCreated: (session) => {
							ensureActivity(activityByAgent, id).session = session;
							const record = manager.getRecord(id);
							if (record) persistAgent(record);
							agentWidget.update();
						},
						onTurnEnd: (turnCount) => {
							ensureActivity(activityByAgent, id).turnCount = turnCount;
							agentWidget.update();
						},
						onAssistantUsage: (usage) => {
							addActivityUsage(ensureActivity(activityByAgent, id), usage);
							agentWidget.update();
						},
					});
					ensureActivity(activityByAgent, id);
					const record = manager.getRecord(id);
					if (!record) throw new Error(`Subagent record missing after spawn: ${id}`);
					persistAgent(record);
					agentWidget.update();
					return { item, index, record };
				} catch (error) {
					return { item, index, error: error instanceof Error ? error.message : String(error), id };
				}
			});

			if (background) {
				const results = spawned.map(({ item, index, record, error, id }) =>
					record
						? resultFromRecord(record, item, index, taskParams.agent)
						: {
								index,
								id,
								agent: taskParams.agent,
								description: item.description,
								role: item.role,
								assignment: item.assignment,
								status: "error" as const,
								error,
								durationMs: 0,
								toolUses: 0,
							},
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Started ${results.length} background agent${results.length === 1 ? "" : "s"}. Do not poll, call list_agents, or sleep; end this turn. Completion will trigger a follow-up automatically.`,
						},
					],
					details: { results },
				};
			}

			const results = await Promise.all(
				spawned.map(async ({ item, index, record, error, id }) => {
					if (!record) {
						return {
							index,
							id,
							agent: taskParams.agent,
							description: item.description,
							role: item.role,
							assignment: item.assignment,
							status: "error" as const,
							error,
							durationMs: 0,
							toolUses: 0,
						};
					}
					await record.promise;
					completed++;
					agentWidget.update();
					persistAgent(record);
					onUpdate?.({
						content: [{ type: "text" as const, text: `Completed ${completed}/${items.length} agents.` }],
						details: { completed, total: items.length },
					});
					return resultFromRecord(record, item, index, taskParams.agent);
				}),
			);
			const ordered = results.sort((left, right) => left.index - right.index);
			return {
				content: [{ type: "text" as const, text: formatTaskResults(ordered) }],
				details: { results: ordered },
			};
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List agents owned by the current Pi session.",
		promptSnippet: "List agents",
		renderShell: "self",
		renderCall: (_args: unknown, theme: ToolTheme) =>
			textComponent(
				renderStatusLine(theme, { iconOverride: styledSymbol(theme, "tool.task", "accent"), title: "Agents" }),
			),
		renderResult: renderSubagentList,
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const agents = visibleRecords(ctx).map((agent) => ({
				id: agent.id,
				type: agent.type,
				description: agent.description,
				status: agent.status,
				error: agent.error,
			}));
			return { content: [{ type: "text" as const, text: JSON.stringify(agents, null, 2) }], details: { agents } };
		},
	});

	pi.registerTool({
		name: "followup_task",
		label: "Follow Up Agent",
		description: "Run another turn in an existing agent session, or retry its latest failed turn.",
		promptSnippet: "Follow up an agent",
		renderShell: "self",
		renderCall: (args: unknown, theme: ToolTheme) => {
			const params = args as { id?: string };
			return framedBlock(theme, {
				header: renderStatusLine(theme, {
					iconOverride: styledSymbol(theme, "tool.task", "accent"),
					title: "Agent",
					description: params.id ? `follow up ${params.id}` : "follow up",
				}),
				borderColor: "borderMuted",
			});
		},
		renderResult: renderTaskResult,
		parameters: Type.Object({
			id: Type.String({ description: "Agent id." }),
			prompt: Type.Optional(Type.String({ description: "Follow-up assignment." })),
			retry: Type.Optional(Type.Boolean({ description: "Retry the latest failed turn." })),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const { id, prompt, retry } = params as { id: string; prompt?: string; retry?: boolean };
			const record = findOwnedRecord(ctx, id);
			if (!record) throw new Error(`Agent not found in this session: ${id}`);
			record.completionDelivered = true;
			const options = { signal };
			const updated = retry
				? await manager.retry(pi, ctx, record.id, options)
				: await manager.resume(pi, ctx, record.id, prompt?.trim() || "Continue the delegated task.", options);
			if (!updated) throw new Error(`Agent not found or not resumable: ${id}`);
			persistAgent(updated);
			const result = resultFromRecord(updated, { assignment: prompt ?? "retry" }, 0, updated.type);
			return { content: [{ type: "text" as const, text: formatTaskResults([result]) }], details: { result } };
		},
	});

	pi.registerTool({
		name: "send_message",
		label: "Send Agent Message",
		description: "Steer a running agent after its current tool execution.",
		promptSnippet: "Message an agent",
		renderShell: "self",
		renderCall: renderTaskCall,
		renderResult: renderTaskResult,
		parameters: Type.Object({
			id: Type.String({ description: "Running agent id." }),
			message: Type.String({ description: "Steering message." }),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const { id, message } = params as { id: string; message: string };
			const record = findOwnedRecord(ctx, id);
			if (!record || !(await manager.steer(record.id, message))) throw new Error(`Running agent not found: ${id}`);
			return { content: [{ type: "text" as const, text: `Message sent to ${record.id}.` }], details: {} };
		},
	});

	pi.registerTool({
		name: "stop_agent",
		label: "Stop Agent",
		description: "Stop a running or queued agent.",
		promptSnippet: "Stop an agent",
		renderShell: "self",
		renderCall: renderTaskCall,
		renderResult: renderTaskResult,
		parameters: Type.Object({ id: Type.String({ description: "Agent id." }) }),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const { id } = params as { id: string };
			const record = findOwnedRecord(ctx, id);
			if (!record || !manager.abort(record.id)) throw new Error(`Running or queued agent not found: ${id}`);
			persistAgent(record);
			return { content: [{ type: "text" as const, text: `Stopped ${record.id}.` }], details: {} };
		},
	});
}
