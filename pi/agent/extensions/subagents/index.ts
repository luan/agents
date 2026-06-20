import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AgentManager } from "../mosaic/agent-manager.js";
import { registerAgents } from "../mosaic/agent-types.js";
import { loadCustomAgents } from "../mosaic/custom-agents.js";
import { loadSettings } from "../mosaic/settings.js";
import type { AgentConfig, AgentRecord, SubagentType, ThinkingLevel } from "../mosaic/types.js";
import { type AgentActivity, AgentWidget } from "../mosaic/ui/agent-widget.js";
import { bold, framedBlock, renderStatusLine, styledSymbol, textComponent, treeGlyphs } from "../shared/tui/omp-card";

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
};

type TaskResult = {
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
			title: items.length === 1 ? "Subagent" : "Subagents",
			description: params.agent,
			meta: items.length ? [`${items.length} ${items.length === 1 ? "agent" : "agents"}`] : undefined,
		}),
	);
}

function compactTaskResults(results: TaskResult[]): string {
	const failed = results.filter((result) => result.status === "error" || result.error).length;
	const suffix = failed > 0 ? `, ${failed} failed` : "";
	return `Completed ${results.length} subagent${results.length === 1 ? "" : "s"}${suffix}.`;
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
	return textComponent(
		renderStatusLine(theme, {
			icon: failed ? "error" : "success",
			title: results.length === 1 ? "Subagent" : "Subagents",
			description: results.length ? compactTaskResults(results) : "No subagent result.",
		}),
	);
}

function renderSubagentList(
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
				`${theme.fg("dim", isLast ? "  " : `${tree.vertical} `)}${theme.fg("dim", truncateToWidth(output, 82))}`,
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
- Be concise. Do not include filler, repetition, or tool transcripts.
</directives>`;

const bundledAgents: AgentConfig[] = [
	{
		name: "task",
		description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
		extensions: true,
		skills: false,
		promptMode: "append",
		systemPrompt: taskAgentPrompt,
		source: "default",
		isDefault: true,
	},
	{
		name: "quick_task",
		description: "Low-reasoning agent for strictly mechanical updates or data collection only",
		extensions: true,
		skills: false,
		promptMode: "append",
		systemPrompt: taskAgentPrompt,
		thinking: "medium",
		source: "default",
		isDefault: true,
	},
	{
		name: "explore",
		description: "Fast read-only codebase scout returning compressed context for handoff",
		toolNames: ["read", "search", "grep", "find", "web_search"],
		extensions: true,
		skills: false,
		promptMode: "replace",
		systemPrompt:
			"Investigate the codebase rapidly. Use broad search, read key sections, identify relevant files and architecture, and return concise findings. Read-only: never write, edit, or run state-changing commands.",
		thinking: "medium",
		source: "default",
		isDefault: true,
	},
	{
		name: "plan",
		description: "Software architect for complex multi-file architectural decisions",
		toolNames: ["read", "search", "grep", "find", "bash", "web_search", "ast_grep"],
		extensions: true,
		skills: false,
		promptMode: "replace",
		systemPrompt:
			"Analyze requirements and code, then produce an implementation plan with summary, concrete changes, sequence, edge cases, verification, and critical files. Read-only: do not modify files.",
		thinking: "high",
		source: "default",
		isDefault: true,
	},
	{
		name: "designer",
		description: "UI/UX specialist for design implementation, review, and visual refinement",
		extensions: true,
		skills: false,
		promptMode: "append",
		systemPrompt:
			"Implement and review UI designs with attention to design systems, accessibility, responsive behavior, visual hierarchy, and explicit states. Prefer existing components and tokens over one-off styling.",
		source: "default",
		isDefault: true,
	},
	{
		name: "reviewer",
		description: "Code review specialist for quality and security analysis",
		toolNames: ["read", "search", "grep", "find", "bash", "web_search", "ast_grep", "report_finding"],
		extensions: true,
		skills: false,
		promptMode: "replace",
		systemPrompt:
			"Identify bugs the author would want fixed before merge. Report only provable, actionable issues introduced by the change. Bash is read-only; never edit files or run builds.",
		thinking: "high",
		source: "default",
		isDefault: true,
	},
	{
		name: "oracle",
		description: "Deep reasoning agent for hard implementation or architecture work",
		extensions: true,
		skills: false,
		promptMode: "append",
		systemPrompt: `${taskAgentPrompt}\n\nUse deep reasoning for ambiguous, cross-cutting, or architecture-sensitive work.`,
		thinking: "high",
		source: "default",
		isDefault: true,
	},
	{
		name: "librarian",
		description: "Read-only documentation and repository research specialist",
		toolNames: ["read", "search", "grep", "find", "web_search"],
		extensions: true,
		skills: false,
		promptMode: "replace",
		systemPrompt:
			"Research docs and repository context. Return cited, compressed findings. Read-only: never write, edit, or run state-changing commands.",
		source: "default",
		isDefault: true,
	},
];

function parseList(value: unknown): string[] | undefined {
	if (Array.isArray(value))
		return value
			.map(String)
			.map((item) => item.trim())
			.filter(Boolean);
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "none") return [];
	if (trimmed === "all" || trimmed === "inherit") return undefined;
	return trimmed
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function inheritField(value: unknown): true | string[] | false {
	if (value === undefined || value === null || value === true) return true;
	if (value === false || value === "none") return false;
	return parseList(value) ?? false;
}

function parseAgentFile(path: string, source: "project" | "global"): AgentConfig | undefined {
	try {
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8"));
		const name =
			typeof frontmatter.name === "string" && frontmatter.name.trim()
				? frontmatter.name.trim()
				: basename(path, ".md");
		const description =
			typeof frontmatter.description === "string" && frontmatter.description.trim()
				? frontmatter.description.trim()
				: name;
		return {
			name,
			displayName: typeof frontmatter.display_name === "string" ? frontmatter.display_name : undefined,
			description,
			toolNames: parseList(frontmatter.tools),
			disallowedTools: parseList(frontmatter.disallowed_tools),
			extensions: inheritField(frontmatter.extensions ?? frontmatter.inherit_extensions),
			skills: inheritField(frontmatter.skills ?? frontmatter.inherit_skills),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: (frontmatter.thinking ?? frontmatter["thinking-level"]) as ThinkingLevel | undefined,
			maxTurns: typeof frontmatter.max_turns === "number" ? frontmatter.max_turns : undefined,
			systemPrompt: body.trim(),
			promptMode: frontmatter.prompt_mode === "append" ? "append" : "replace",
			enabled: frontmatter.enabled !== false,
			source,
		};
	} catch (error) {
		console.warn(
			`[omp-subagents] Ignoring invalid agent file ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function loadAgentsFromDir(dir: string, source: "project" | "global"): AgentConfig[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md"))
			.sort()
			.map((file) => parseAgentFile(join(dir, file), source))
			.filter((agent): agent is AgentConfig => Boolean(agent));
	} catch {
		return [];
	}
}

function loadOmpAgents(cwd: string): Map<string, AgentConfig> {
	const agents = new Map<string, AgentConfig>();
	for (const agent of bundledAgents) agents.set(agent.name, agent);
	for (const agent of loadAgentsFromDir(join(homedir(), ".omp", "agent", "agents"), "global"))
		agents.set(agent.name, agent);
	for (const agent of loadAgentsFromDir(join(cwd, ".omp", "agents"), "project")) agents.set(agent.name, agent);
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

function formatTaskResults(results: TaskResult[]): string {
	return compactTaskResults(results);
}

function ensureActivity(activityByAgent: Map<string, AgentActivity>, id: string): AgentActivity {
	let activity = activityByAgent.get(id);
	if (!activity) {
		activity = {
			activeTools: new Map(),
			toolUses: 0,
			responseText: "",
			turnCount: 0,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
		};
		activityByAgent.set(id, activity);
	}
	return activity;
}

function addActivityUsage(activity: AgentActivity, usage: { input: number; output: number; cacheWrite: number }): void {
	activity.lifetimeUsage.input += usage.input;
	activity.lifetimeUsage.output += usage.output;
	activity.lifetimeUsage.cacheWrite += usage.cacheWrite;
}

function finishWidgetAgent(agentWidget: AgentWidget, record: AgentRecord): void {
	agentWidget.markFinished(record.id);
	agentWidget.update();
}

const taskItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable agent id, CamelCase, <=32 chars preferred." })),
	description: Type.Optional(Type.String({ description: "UI label only; the subagent never sees it." })),
	role: Type.Optional(Type.String({ description: "Specialist identity for the subagent." })),
	assignment: Type.String({ description: "Complete self-contained instructions." }),
	isolated: Type.Optional(Type.Boolean({ description: "Run in an isolated worktree." })),
});

let activeAgentManager: AgentManager | undefined;

export function getActiveSubagentDescriptions(): string[] {
	return (
		activeAgentManager
			?.listAgents()
			.filter((agent) => agent.status === "running")
			.map((agent) => agent.description.trim())
			.filter(Boolean) ?? []
	);
}

function registerCurrentAgents(cwd: string, manager: AgentManager): void {
	registerAgents(loadOmpAgents(cwd));
	const settings = loadSettings(cwd);
	if (settings.maxConcurrent) manager.setMaxConcurrent(settings.maxConcurrent);
}

export default function ompSubagentsExtension(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	const activityByAgent = new Map<string, AgentActivity>();
	let agentWidget: AgentWidget;
	const manager = new AgentManager(
		(record) => finishWidgetAgent(agentWidget, record),
		undefined,
		() => agentWidget.update(),
		() => agentWidget.update(),
	);
	activeAgentManager = manager;
	agentWidget = new AgentWidget(manager, activityByAgent, () =>
		manager.listAgents().filter((agent) => !agent.isBackground),
	);

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		manager.clearCompleted();
		activityByAgent.clear();
		registerCurrentAgents(ctx.cwd, manager);
		agentWidget.setUICtx(ctx.ui);
		agentWidget.update();
	});

	pi.on("session_shutdown", async () => {
		manager.abortAll();
		agentWidget.dispose();
		activityByAgent.clear();
		currentCtx = undefined;
	});

	pi.registerCommand("subagents", {
		description: "List oh-my-pi style subagents",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const agents = manager.listAgents();
			ctx.ui.notify(
				agents.length
					? agents.map((agent) => `${agent.id} ${agent.type} ${agent.status} — ${agent.description}`).join("\n")
					: "No subagents in this session.",
				"info",
			);
		},
	});

	pi.registerTool({
		name: "task",
		label: "Subagent",
		description:
			"Spawn subagents. Use tasks[] plus shared context for parallel fan-out; use a single assignment for one subagent. Subagents have no conversation history, so include all facts, paths, constraints, and acceptance criteria.",
		promptSnippet: "Spawn subagents",
		renderShell: "self",
		renderCall: renderTaskCall,
		renderResult: renderTaskResult,
		parameters: Type.Object({
			agent: Type.String({
				description:
					"Agent type to spawn: task, quick_task, explore, plan, designer, reviewer, oracle, librarian, or a custom .omp/.pi agent.",
			}),
			context: Type.Optional(
				Type.String({
					description: "Shared background prepended to every tasks[] item. Required for batch calls.",
				}),
			),
			tasks: Type.Optional(
				Type.Array(taskItemSchema, { description: "One subagent per item; all run in parallel." }),
			),
			id: Type.Optional(Type.String({ description: "Single-spawn stable id." })),
			description: Type.Optional(Type.String({ description: "Single-spawn UI label." })),
			role: Type.Optional(Type.String({ description: "Single-spawn specialist identity." })),
			assignment: Type.Optional(Type.String({ description: "Single-spawn complete self-contained instructions." })),
			isolated: Type.Optional(Type.Boolean({ description: "Single-spawn isolated worktree." })),
		}),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			currentCtx = ctx;
			agentWidget.setUICtx(ctx.ui);
			registerCurrentAgents(ctx.cwd, manager);
			const taskParams = params as TaskParams;
			const items = normalizeItems(taskParams);
			let completed = 0;
			const results = await Promise.all(
				items.map(async (item, index) => {
					const name = taskName(item, index);
					let id = name;
					try {
						id = manager.spawn(
							pi,
							ctx,
							taskParams.agent as SubagentType,
							assignmentPrompt(taskParams.context, item),
							{
								description: name,
								isolation: item.isolated ? "worktree" : undefined,
								signal,
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
							},
						);
						ensureActivity(activityByAgent, id);
						agentWidget.update();
						const record = manager.getRecord(id);
						if (!record) throw new Error(`Subagent record missing after spawn: ${id}`);
						await record.promise;
						completed++;
						finishWidgetAgent(agentWidget, record);
						onUpdate?.({
							content: [
								{
									type: "text" as const,
									text: `Completed ${completed}/${items.length} subagent${items.length === 1 ? "" : "s"}.`,
								},
							],
							details: { completed, total: items.length },
						});
						return resultFromRecord(record, item, index, taskParams.agent);
					} catch (error) {
						completed++;
						agentWidget.update();
						onUpdate?.({
							content: [
								{
									type: "text" as const,
									text: `Completed ${completed}/${items.length} subagent${items.length === 1 ? "" : "s"}.`,
								},
							],
							details: { completed, total: items.length },
						});
						return {
							index,
							id,
							agent: taskParams.agent,
							description: item.description,
							role: item.role,
							assignment: item.assignment,
							status: "error" as const,
							error: error instanceof Error ? error.message : String(error),
							durationMs: 0,
							toolUses: 0,
						};
					}
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
		name: "subagent_list",
		label: "List Subagents",
		description: "List subagents in the current session.",
		promptSnippet: "List subagents",
		renderShell: "self",
		renderCall: (_args: unknown, theme: ToolTheme) =>
			textComponent(
				renderStatusLine(theme, { iconOverride: styledSymbol(theme, "tool.task", "accent"), title: "Subagents" }),
			),
		renderResult: renderSubagentList,
		parameters: Type.Object({}),
		execute: async () => {
			const agents = manager.listAgents().map((agent) => ({
				id: agent.id,
				type: agent.type,
				description: agent.description,
				status: agent.status,
				result: agent.result,
				error: agent.error,
			}));
			return { content: [{ type: "text" as const, text: JSON.stringify(agents, null, 2) }], details: { agents } };
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Send Subagent Message",
		description: "Send a follow-up prompt to an existing live subagent session by id.",
		promptSnippet: "Message a subagent",
		renderShell: "self",
		renderCall: (args: unknown, theme: ToolTheme) => {
			const params = args as { id?: string };
			return framedBlock(theme, {
				header: renderStatusLine(theme, {
					iconOverride: styledSymbol(theme, "tool.task", "accent"),
					title: "Subagent",
					description: params.id ? `message ${params.id}` : "message",
				}),
				borderColor: "borderMuted",
			});
		},
		renderResult: renderTaskResult,
		parameters: Type.Object({
			id: Type.String({ description: "Subagent id." }),
			message: Type.String({ description: "Follow-up prompt." }),
		}),
		execute: async (_toolCallId, params, signal) => {
			if (!currentCtx) throw new Error("No active session");
			const record = await manager.resume(
				(params as { id: string }).id,
				(params as { message: string }).message,
				signal,
			);
			if (!record) throw new Error(`Subagent not found or not resumable: ${(params as { id: string }).id}`);
			const result = resultFromRecord(
				record,
				{ assignment: (params as { message: string }).message },
				0,
				record.type,
			);
			return { content: [{ type: "text" as const, text: formatTaskResults([result]) }], details: { result } };
		},
	});
}
