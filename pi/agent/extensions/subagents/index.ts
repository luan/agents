import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { onOpenAIFastRequest } from "../shared/openai-fast-state";
import { registerResourceProvider } from "../shared/resources.ts";
import { registerRootSessionHub } from "../shared/root-session-hub";
import { attachRuntimeTerminal, openRuntimeHub, registerRuntimeHubSource } from "../shared/runtime-hub";
import { bold, framedBlock, renderStatusLine, styledSymbol, textComponent, treeGlyphs } from "../shared/tui/card";
import { agentResourceProvider } from "./runtime/agent-resources.ts";
import { findRetryableError } from "./runtime/agent-runner.js";
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
import { readAgentRegistry, readRetainedAgentRegistries, writeAgentRegistry } from "./runtime/persistence.js";
import { type AgentConfig, type AgentRecord, agentKey, type SubagentType } from "./runtime/types.js";
import { openAgentInspector } from "./runtime/ui/agent-browser.js";
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
		skills: true,
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
		skills: true,
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
		skills: true,
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
		skills: true,
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

export function routeForegroundInput(
	manager: Pick<ReturnType<typeof getSharedAgentManager>, "listAgents" | "background">,
	sessionId: string,
	event: { source: string; streamingBehavior?: "steer" | "followUp" },
): { action: "continue"; backgrounded: number } {
	if (event.source === "extension" || event.streamingBehavior !== "steer") {
		return { action: "continue", backgrounded: 0 };
	}
	const backgrounded = manager
		.listAgents()
		.filter(
			(record) =>
				record.parentSessionId === sessionId && record.status === "running" && record.isBackground !== true,
		)
		.filter((record) => manager.background(record.id, record.rootSessionId)).length;
	return { action: "continue", backgrounded };
}

export function mergeHubAgentRecords(
	saved: AgentRecord[],
	live: AgentRecord[],
	currentRootSessionId: string,
): AgentRecord[] {
	const records = new Map<string, AgentRecord>();
	const visible = (record: AgentRecord) => record.rootSessionId === currentRootSessionId;
	for (const record of saved) {
		if (visible(record)) records.set(agentKey(record.rootSessionId, record.id), record);
	}
	for (const record of live) {
		if (visible(record)) records.set(agentKey(record.rootSessionId, record.id), record);
	}
	return [...records.values()].sort((left, right) => right.startedAt - left.startedAt);
}

export async function attachAgentTerminal(
	record: AgentRecord,
	tui: Pick<TUI, "requestRender" | "start" | "stop" | "terminal">,
): Promise<boolean> {
	const attachment = record.attachment;
	if (!attachment?.command || !Array.isArray(attachment.args)) return false;
	return attachRuntimeTerminal(attachment, tui);
}

const RETRY_MESSAGE = "retry-failed-request";

export default function subagentsExtension(pi: ExtensionAPI) {
	registerResourceProvider("agent", agentResourceProvider());
	let currentCtx: ExtensionContext | undefined;
	let unregisterHubSource: (() => void) | undefined;
	const unregisterRootSessionHub = registerRootSessionHub();
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
	/** Retry candidates for completions and error messages: the main turn plus failed subagents. */
	const retryTargets = (ctx: ExtensionContext) => {
		const mainError = findRetryableError(ctx.sessionManager.getBranch());
		const targets = mainError ? [{ value: "main", label: "main", description: mainError }] : [];
		for (const record of visibleRecords(ctx)) {
			if (record.status !== "error") continue;
			targets.push({ value: record.id, label: record.id, description: record.error ?? record.description ?? "" });
		}
		return targets;
	};
	const hubRecords = (ctx: ExtensionContext): AgentRecord[] => {
		const sessionId = ctx.sessionManager.getSessionId();
		return mergeHubAgentRecords(
			readRetainedAgentRegistries() as AgentRecord[],
			manager.listAgents(),
			manager.getRootSessionId(sessionId),
		);
	};

	const hubActions = (ctx: ExtensionCommandContext) => {
		const liveRecord = (target: AgentRecord) =>
			manager
				.listAgents()
				.find((record) => record.id === target.id && record.rootSessionId === target.rootSessionId);
		const ensureLiveRecord = (target: AgentRecord) => {
			const current = liveRecord(target);
			if (current) return current;
			manager.restore(readAgentRegistry(target.rootSessionId), false);
			return liveRecord(target);
		};
		return {
			steer: (target: AgentRecord, message: string) => {
				const record = ensureLiveRecord(target);
				return record ? manager.steer(record.id, message, record.rootSessionId) : Promise.resolve(false);
			},
			stop: (target: AgentRecord) => {
				const record = ensureLiveRecord(target);
				if (!record) return false;
				const stopped = manager.abort(record.id, record.rootSessionId);
				if (stopped) persistAgent(record);
				agentWidget.update();
				return stopped;
			},
			followUp: async (target: AgentRecord, prompt: string) => {
				const record = ensureLiveRecord(target);
				if (!record) return false;
				const runtime = getSessionRuntime(record.parentSessionId, record.rootSessionId) ?? { pi, ctx };
				const updated = await manager.resume(runtime.pi, runtime.ctx, record.id, prompt, {
					rootSessionId: record.rootSessionId,
				});
				if (!updated) return false;
				persistAgent(updated);
				agentWidget.update();
				return true;
			},
			attach: (target: AgentRecord, tui: Pick<TUI, "requestRender" | "start" | "stop" | "terminal">) =>
				attachAgentTerminal(target, tui),
		};
	};
	const hubSource = {
		list: (sourceCtx: ExtensionContext) => {
			const ctx = sourceCtx as ExtensionCommandContext;
			const actions = hubActions(ctx);
			return hubRecords(ctx).map((record) => ({
				key: `agent:${record.rootSessionId}:${record.id}`,
				kind: "agent" as const,
				label: record.id,
				status: record.status === "completed" ? "idle" : record.status,
				description: record.description,
				parent: record.parentAgentId,
				parentKey: record.parentAgentId ? `agent:${record.rootSessionId}:${record.parentAgentId}` : undefined,
				lastActivity: record.completedAt ?? record.startedAt,
				open: async () => {
					const live = manager.getRecord(record.id, record.rootSessionId) ?? record;
					await openAgentInspector(ctx, live, actions);
				},
				attach: record.attachment
					? (tui: Pick<TUI, "requestRender" | "start" | "stop" | "terminal">) => actions.attach(record, tui)
					: undefined,
				stop: () => actions.stop(record),
			}));
		},
	};

	const agentWidget = new AgentWidget(
		manager,
		activityByAgent,
		() => manager.listAgents().filter((agent) => !agent.isBackground),
		() => (currentCtx ? manager.getRootSessionId(currentCtx.sessionManager.getSessionId()) : undefined),
	);

	const unsubscribeFastRequests = onOpenAIFastRequest((event) => {
		if (!event.sessionFile) return;
		const record = manager.listAgents().find((agent) => agent.sessionFile === event.sessionFile);
		if (!record) return;
		record.fastModeActive = event.active;
		agentWidget.update();
	});

	pi.on("input", (event, ctx) => {
		const result = routeForegroundInput(manager, ctx.sessionManager.getSessionId(), event);
		if (result.backgrounded > 0) ctx.ui.notify("Backgrounded foreground subagent.", "info");
		return { action: result.action };
	});

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
			unregisterHubSource?.();
			unregisterHubSource = registerRuntimeHubSource("subagents", hubSource);
			registerAgentWidget(agentWidget);
			agentWidget.setUICtx(ctx.ui);
			agentWidget.update();
		}
		deliverPendingForSession(sessionId);
	});

	pi.on("session_shutdown", async () => {
		unregisterHubSource?.();
		unregisterHubSource = undefined;
		unregisterRootSessionHub();
		unsubscribeFastRequests();
		if (currentCtx) unregisterSessionBinding(currentCtx);
		unregisterAgentWidget(agentWidget);
		agentWidget.dispose();
		currentCtx = undefined;
	});

	pi.registerCommand("hub", {
		description: "Open the shared Hub",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await openRuntimeHub(ctx);
		},
	});

	pi.registerShortcut?.("alt+a", {
		description: "Open the shared Hub",
		handler: async (ctx: ExtensionContext) => {
			await openRuntimeHub(ctx);
		},
	});

	pi.registerCommand("retry", {
		description: "Re-issue the failed request: /retry [main|<subagent id>]",
		getArgumentCompletions: (prefix: string) => {
			if (!currentCtx) return null;
			const value = prefix.trim();
			const items = retryTargets(currentCtx).filter((target) => target.value.startsWith(value));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await ctx.waitForIdle();
			const target = args.trim();
			const report = (message: string, level: "info" | "warning" | "error") => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
				else console.error(`[retry] ${message}`);
			};
			const targets = retryTargets(ctx);
			const usage = targets.length
				? `Retryable: ${targets.map((candidate) => candidate.value).join(", ")}.`
				: "Nothing failed in this session; there is no request to re-issue.";

			const mainError = findRetryableError(ctx.sessionManager.getBranch());
			if ((!target && mainError) || target === "main") {
				if (!mainError) {
					report(`No failed main-session request to re-issue. ${usage}`, "warning");
					return;
				}
				// The failed request is re-issued from the intact transcript: completed tool calls
				// stay in context and only a hidden nudge is added, so no work is repeated.
				pi.sendMessage(
					{
						customType: RETRY_MESSAGE,
						content: `The previous request failed (${mainError}). Continue from the last completed step without repeating finished work.`,
						display: false,
					},
					{ triggerTurn: true },
				);
				report(`Re-issuing the failed main request (${mainError}).`, "info");
				return;
			}

			const record = target
				? findOwnedRecord(ctx, target)
				: visibleRecords(ctx).find((agent) => agent.status === "error");
			if (!record) {
				report(
					target ? `No subagent matches "${target}". ${usage}` : `No retryable subagent found. ${usage}`,
					"warning",
				);
				return;
			}
			record.completionDelivered = true;
			const retried = await manager.retry(pi, ctx, record.id, {
				onAssistantUsage: () => {},
				rootSessionId: record.rootSessionId,
			});
			if (!retried) {
				report(`Subagent ${record.id} has no failed request to re-issue.`, "warning");
				return;
			}
			persistAgent(retried);
			agentWidget.update();
			report(
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
							const activity = ensureActivity(activityByAgent, agentKey(rootSessionId, id));
							if (tool.type === "start") activity.activeTools.set(tool.toolName, tool.toolName);
							else {
								activity.activeTools.delete(tool.toolName);
								activity.toolUses++;
							}
							agentWidget.update();
						},
						onTextDelta: (_delta, fullText) => {
							ensureActivity(activityByAgent, agentKey(rootSessionId, id)).responseText = fullText;
						},
						onSessionCreated: (session) => {
							ensureActivity(activityByAgent, agentKey(rootSessionId, id)).session = session;
							const record = manager.getRecord(id, rootSessionId);
							if (record) persistAgent(record);
						},
						onTurnEnd: (turnCount) => {
							const activity = ensureActivity(activityByAgent, agentKey(rootSessionId, id));
							activity.turnCount = turnCount;
						},
						onAssistantUsage: (usage) => {
							addActivityUsage(ensureActivity(activityByAgent, agentKey(rootSessionId, id)), usage);
							agentWidget.update();
						},
					});
					ensureActivity(activityByAgent, agentKey(rootSessionId, id));
					const record = manager.getRecord(id, rootSessionId);
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
					await manager.waitForForeground(record.id, record.rootSessionId);
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
			const options = { signal, rootSessionId: record.rootSessionId };
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
			if (!record || !(await manager.steer(record.id, message, record.rootSessionId))) {
				throw new Error(`Running agent not found: ${id}`);
			}
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
			if (!record || !manager.abort(record.id, record.rootSessionId)) {
				throw new Error(`Running or queued agent not found: ${id}`);
			}
			persistAgent(record);
			return { content: [{ type: "text" as const, text: `Stopped ${record.id}.` }], details: {} };
		},
	});
}
