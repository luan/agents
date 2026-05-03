import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { type Component, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { runCommand as defaultRunCommand } from "../shared/ct-runner";

type TaskCommand = "add" | "list" | "show" | "update" | "delete";

interface Config {
	enabled: boolean;
	command: string;
	hud: {
		enabled: boolean;
		maxTasks: number;
	};
}

interface Runtime {
	runCommand?: typeof defaultRunCommand;
}

interface TaskRecord {
	id: string;
	title: string;
	body: string;
	status: string;
	priority?: number;
	assigned_to?: string | null;
	assigned_label?: string | null;
	blocked_by?: string[];
	created_at: number;
	updated_at: number;
}

interface TaskDetails {
	action: TaskCommand;
	args: string[];
	task?: TaskRecord;
	tasks?: TaskRecord[];
	deleted?: string;
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(extensionDir, "config.json");
const widgetId = "project-tasks";

const defaultConfig: Config = {
	enabled: true,
	command: "ct",
	hud: {
		enabled: true,
		maxTasks: 6,
	},
};

function loadConfig(): Config {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;
		return {
			...defaultConfig,
			...parsed,
			hud: { ...defaultConfig.hud, ...parsed.hud },
		};
	} catch {
		return defaultConfig;
	}
}

function pushOption(args: string[], name: string, value: unknown): void {
	if (typeof value === "number" && Number.isFinite(value)) {
		args.push(name, String(value));
		return;
	}
	if (typeof value !== "string" || value.length === 0) return;
	args.push(name, value);
}

function pushRepeatedOption(args: string[], name: string, value: unknown): void {
	if (!Array.isArray(value)) return;
	for (const item of value) pushOption(args, name, item);
}

export function buildTaskCommand(action: TaskCommand, params: Record<string, unknown>): string[] {
	const args = ["task", action];
	switch (action) {
		case "add":
			args.push(String(params.title ?? ""));
			pushOption(args, "--body", params.body);
			pushOption(args, "--status", params.status);
			pushOption(args, "--priority", params.priority);
			pushOption(args, "--assigned-to", params.assigned_to);
			pushOption(args, "--assigned-label", params.assigned_label);
			pushRepeatedOption(args, "--blocked-by", params.blocked_by);
			break;
		case "list":
			pushOption(args, "--status", params.status);
			pushOption(args, "--assigned-to", params.assigned_to);
			if (params.all === true) args.push("--all");
			break;
		case "show":
		case "delete":
			args.push(String(params.id ?? ""));
			break;
		case "update":
			args.push(String(params.id ?? ""));
			pushOption(args, "--title", params.title);
			pushOption(args, "--body", params.body);
			pushOption(args, "--status", params.status);
			pushOption(args, "--priority", params.priority);
			pushOption(args, "--assigned-to", params.assigned_to);
			pushOption(args, "--assigned-label", params.assigned_label);
			if (params.clear_assignee === true) args.push("--clear-assignee");
			pushRepeatedOption(args, "--blocked-by", params.blocked_by);
			if (params.clear_blockers === true) args.push("--clear-blockers");
			break;
	}
	args.push("--json");
	return args;
}

function parseTaskPayload(text: string, action: TaskCommand, args: string[]): TaskDetails {
	try {
		const parsed = JSON.parse(text || "{}") as {
			task?: TaskRecord;
			tasks?: TaskRecord[];
			deleted?: string;
		};
		return {
			action,
			args,
			task: parsed.task,
			tasks: parsed.tasks,
			deleted: parsed.deleted,
		};
	} catch {
		return { action, args };
	}
}

function textResult(text: string, details: TaskDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function sessionAssignment(ctx?: ExtensionContext): string | undefined {
	const anyCtx = ctx as
		| (ExtensionContext & {
				sessionId?: string;
				session?: { id?: string };
				sessionManager?: { getSessionFile?: () => string | undefined };
		  })
		| undefined;
	const direct = anyCtx?.sessionId ?? anyCtx?.session?.id;
	if (typeof direct === "string" && direct.length > 0) return `session:${direct}`;
	const file = anyCtx?.sessionManager?.getSessionFile?.();
	if (typeof file === "string" && file.length > 0) return `session:${basename(file).replace(/\.jsonl$/, "")}`;
	return undefined;
}

function sessionName(pi?: ExtensionAPI, ctx?: ExtensionContext): string | undefined {
	try {
		const fromPi = (
			pi as (ExtensionAPI & { getSessionName?: () => string | undefined }) | undefined
		)?.getSessionName?.();
		if (typeof fromPi === "string" && fromPi.trim()) return fromPi.trim();
	} catch {}
	try {
		const fromCtx = (
			ctx as (ExtensionContext & { sessionManager?: { getSessionName?: () => string | undefined } }) | undefined
		)?.sessionManager?.getSessionName?.();
		if (typeof fromCtx === "string" && fromCtx.trim()) return fromCtx.trim();
	} catch {}
	return undefined;
}

function normalizeTaskParams(
	params: Record<string, unknown>,
	ctx?: ExtensionContext,
	pi?: ExtensionAPI,
): Record<string, unknown> {
	if (params.assigned_to !== "current") return params;
	const assignedTo = sessionAssignment(ctx);
	if (!assignedTo) return params;
	return { ...params, assigned_to: assignedTo, assigned_label: sessionName(pi, ctx) };
}

async function executeTask(
	command: string,
	runCommand: typeof defaultRunCommand,
	cwd: string,
	action: TaskCommand,
	params: Record<string, unknown>,
	config: Config,
	pi?: ExtensionAPI,
	ctx?: ExtensionContext,
	signal?: AbortSignal,
) {
	const args = buildTaskCommand(action, normalizeTaskParams(params, ctx, pi));
	const result = await runCommand(command, args, cwd, signal);
	const text = result.stdout.trim() || result.stderr.trim();
	const details = parseTaskPayload(text, action, args);
	if (ctx && config.hud.enabled && (action === "add" || action === "update" || action === "delete")) {
		await updateTaskHud(ctx, pi, command, runCommand, config).catch((error) => {
			ctx.ui.notify?.(
				`Task HUD refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		});
	}
	return textResult(text, details);
}

async function loadHudTasks(cwd: string, command: string, runCommand: typeof defaultRunCommand, signal?: AbortSignal) {
	const result = await runCommand(command, ["task", "list", "--all", "--json"], cwd, signal);
	const parsed = JSON.parse(result.stdout || "{}") as { tasks?: TaskRecord[] };
	return parsed.tasks ?? [];
}

async function updateTaskHud(
	ctx: ExtensionContext,
	pi: ExtensionAPI | undefined,
	command: string,
	runCommand: typeof defaultRunCommand,
	config: Config,
): Promise<void> {
	const tasks = await loadHudTasks(ctx.cwd, command, runCommand, ctx.signal);
	const display = assignmentDisplayContext(pi, ctx);
	ctx.ui.setWidget(
		widgetId,
		(_tui, theme) => ({
			render: (width: number) => renderHudLines(tasks, theme, width, config.hud.maxTasks, display),
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
}

function statusGlyph(status: string): string {
	switch (status) {
		case "done":
		case "completed":
			return "✓";
		case "in_progress":
			return "◼";
		case "canceled":
			return "×";
		default:
			return "◻";
	}
}

function statusColor(status: string): string {
	switch (status) {
		case "done":
		case "completed":
			return "success";
		case "canceled":
			return "muted";
		case "in_progress":
			return "accent";
		default:
			return "dim";
	}
}

function compact(value: string, max = 90): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isComplete(task: TaskRecord): boolean {
	return task.status === "done" || task.status === "completed";
}

function isCanceled(task: TaskRecord): boolean {
	return task.status === "canceled";
}

function strikethrough(theme: Theme, text: string): string {
	const maybeTheme = theme as Theme & { strikethrough?: (value: string) => string };
	return typeof maybeTheme.strikethrough === "function" ? maybeTheme.strikethrough(text) : text;
}

function openBlockers(task: TaskRecord, byId: Map<string, TaskRecord>): string[] {
	return (task.blocked_by ?? []).filter((id) => {
		const blocker = byId.get(id);
		return !blocker || !isComplete(blocker);
	});
}

function hasOpenBlockers(task: TaskRecord, byId: Map<string, TaskRecord>): boolean {
	return openBlockers(task, byId).length > 0;
}

function priority(task: TaskRecord): number {
	return typeof task.priority === "number" ? task.priority : 0;
}

function sortTasksForDisplay(tasks: TaskRecord[]): TaskRecord[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	return [...tasks].sort((left, right) => {
		const leftBlocked = hasOpenBlockers(left, byId);
		const rightBlocked = hasOpenBlockers(right, byId);
		if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1;
		const priorityDelta = priority(right) - priority(left);
		if (priorityDelta !== 0) return priorityDelta;
		return right.updated_at - left.updated_at || left.id.localeCompare(right.id);
	});
}

type AssignmentDisplayContext = { currentAssignment?: string; currentLabel?: string };

function assignmentDisplayContext(pi?: ExtensionAPI, ctx?: ExtensionContext): AssignmentDisplayContext {
	return {
		currentAssignment: sessionAssignment(ctx),
		currentLabel: sessionName(pi, ctx),
	};
}

function assignmentLabel(task: TaskRecord, display: AssignmentDisplayContext = {}): string | undefined {
	const assignedTo = task.assigned_to;
	if (!assignedTo) return undefined;
	if (assignedTo === display.currentAssignment && display.currentLabel) return display.currentLabel;
	if (task.assigned_label) return task.assigned_label;
	if (assignedTo.startsWith("session:")) return assignedTo.slice("session:".length);
	return assignedTo;
}

function formatTaskLine(
	task: TaskRecord,
	theme: Theme,
	width: number,
	byId: Map<string, TaskRecord>,
	display: AssignmentDisplayContext = {},
): string {
	const blockers = openBlockers(task, byId);
	const glyph = theme.fg(statusColor(task.status), statusGlyph(task.status));
	const id = theme.fg("accent", theme.bold(task.id.padEnd(4)));
	const blockerText = blockers.join(", ");
	const label = assignmentLabel(task, display);
	const assignee = label ? theme.fg("dim", ` @${compact(label, 28)}`) : "";
	const title = isComplete(task)
		? theme.fg("dim", strikethrough(theme, `${task.id.padEnd(4)} ${compact(task.title, Math.max(20, width - 18))}`))
		: theme.fg("text", compact(task.title, Math.max(20, width - 18)));
	const suffix = blockers.length > 0 ? theme.fg("dim", ` › blocked by ${blockerText}`) : "";
	if (isComplete(task)) return truncateToWidth(`  ${glyph} ${title}${suffix}`, width);
	return truncateToWidth(`  ${glyph} ${id} ${title}${assignee}${suffix}`, width);
}

export function renderHudLines(
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	maxTasks = 6,
	display: AssignmentDisplayContext = {},
): string[] {
	const visibleTasks = sortTasksForDisplay(tasks.filter((task) => !isCanceled(task)));
	if (visibleTasks.length === 0) return [];
	const byId = new Map(visibleTasks.map((task) => [task.id, task]));
	const completed = visibleTasks.filter(isComplete);
	const inProgress = visibleTasks.filter((task) => task.status === "in_progress");
	const open = visibleTasks.filter((task) => !isComplete(task) && task.status !== "in_progress");
	const parts: string[] = [];
	if (completed.length > 0) parts.push(`${completed.length} done`);
	if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
	if (open.length > 0) parts.push(`${open.length} open`);
	const shown = visibleTasks.slice(0, maxTasks);
	const hidden = visibleTasks.length - shown.length;
	const lines = [
		truncateToWidth(
			`${theme.fg("accent", "●")} ${theme.fg("accent", `${visibleTasks.length} tasks (${parts.join(", ")})`)}`,
			width,
		),
		...shown.map((task) => formatTaskLine(task, theme, width, byId, display)),
	];
	if (hidden > 0) lines.push(truncateToWidth(theme.fg("dim", `    … and ${hidden} more`), width));
	return lines;
}

function actionLabel(action: TaskCommand): string {
	switch (action) {
		case "add":
			return "Add task";
		case "list":
			return "List tasks";
		case "show":
			return "Show task";
		case "update":
			return "Update task";
		case "delete":
			return "Delete task";
	}
}

function renderCallText(action: TaskCommand, args: Record<string, unknown>, theme: Theme): string {
	const target =
		typeof args.title === "string"
			? args.title
			: typeof args.id === "string"
				? args.id
				: typeof args.status === "string"
					? args.status
					: "project";
	return `${theme.fg("toolTitle", theme.bold(actionLabel(action)))} ${theme.fg("accent", compact(target, 64))}`;
}

function renderTaskBlock(title: string, task: TaskRecord, theme: Theme): string {
	const label = assignmentLabel(task);
	return [
		theme.fg("toolTitle", theme.bold(title)),
		`  ${theme.fg(statusColor(task.status), statusGlyph(task.status))} ${theme.fg("accent", theme.bold(task.id.padEnd(4)))} ${theme.fg("text", task.title)}`,
		...(label ? [`  ${theme.fg("dim", `@${label}`)}`] : []),
		...(task.blocked_by?.length ? [`  ${theme.fg("dim", `› blocked by ${task.blocked_by.join(", ")}`)}`] : []),
		...(task.body ? [`  ${theme.fg("dim", compact(task.body, 120))}`] : []),
	].join("\n");
}

function renderTaskList(tasks: TaskRecord[], theme: Theme): string {
	if (tasks.length === 0) return `${theme.fg("toolTitle", theme.bold("Tasks"))}\n  ${theme.fg("dim", "No tasks")}`;
	const lines = [theme.fg("toolTitle", theme.bold(`Tasks (${tasks.length})`))];
	const sortedTasks = sortTasksForDisplay(tasks);
	const byId = new Map(sortedTasks.map((task) => [task.id, task]));
	for (const task of sortedTasks.slice(0, 12)) {
		lines.push(formatTaskLine(task, theme, 140, byId));
	}
	if (tasks.length > 12) lines.push(theme.fg("dim", `    … and ${tasks.length - 12} more`));
	return lines.join("\n");
}

export function renderTaskResult(details: TaskDetails | undefined, theme: Theme): string {
	if (!details) return theme.fg("dim", "Task result unavailable");
	switch (details.action) {
		case "add":
			return details.task
				? renderTaskBlock("Task added", details.task, theme)
				: theme.fg("toolTitle", theme.bold("Task added"));
		case "show":
			return details.task ? renderTaskBlock("Task", details.task, theme) : theme.fg("warning", "Task not found");
		case "update":
			return details.task
				? renderTaskBlock("Task updated", details.task, theme)
				: theme.fg("toolTitle", theme.bold("Task updated"));
		case "delete":
			return `${theme.fg("toolTitle", theme.bold("Task deleted"))}\n  ${theme.fg("accent", details.deleted ?? "unknown")}`;
		case "list":
			return renderTaskList(details.tasks ?? [], theme);
	}
}

class TaskText implements Component {
	constructor(private text = "") {}

	setText(text: unknown): void {
		this.text = typeof text === "string" ? text : "";
	}

	render(width: number): string[] {
		return this.text.split("\n").map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}

function taskText(context: { lastComponent?: unknown } | undefined): TaskText {
	return context?.lastComponent instanceof TaskText ? context.lastComponent : new TaskText("");
}

function makeTaskTool(
	action: TaskCommand,
	command: string,
	runCommand: typeof defaultRunCommand,
	config: Config,
	pi: ExtensionAPI,
	getCwd: () => string,
) {
	return {
		renderCall(args: Record<string, unknown>, theme: Theme, context?: { lastComponent?: unknown }) {
			const text = taskText(context);
			text.setText(renderCallText(action, args ?? {}, theme));
			return text;
		},
		renderResult(
			result: { details?: unknown },
			_options: unknown,
			theme: Theme,
			context: { lastComponent?: unknown },
		) {
			const text = taskText(context);
			text.setText(renderTaskResult(result.details as TaskDetails | undefined, theme));
			return text;
		},
		execute: (
			_toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			_onUpdate?: unknown,
			ctx?: ExtensionContext,
		) => executeTask(command, runCommand, getCwd(), action, params, config, pi, ctx, signal),
	};
}

function isActiveTask(task: TaskRecord): boolean {
	return !isComplete(task) && !isCanceled(task);
}

function assignedTaskReminder(tasks: TaskRecord[], assignedTo: string): string | undefined {
	const assigned = sortTasksForDisplay(
		tasks.filter((task) => isActiveTask(task) && task.assigned_to === assignedTo),
	).slice(0, 8);
	if (assigned.length === 0) return undefined;
	const lines = [
		`You have ${assigned.length} assigned task${assigned.length === 1 ? "" : "s"} still open for ${assignedTo}:`,
		...assigned.map((task) => `- ${task.id} [${task.status}] ${task.title}`),
		"",
		"Update status with task_update when you start or finish work.",
	];
	return lines.join("\n");
}

async function remindAssignedTasks(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	runCommand: typeof defaultRunCommand,
	state: { lastReminderFingerprint?: string },
): Promise<void> {
	const assignedTo = sessionAssignment(ctx);
	if (!assignedTo) return;
	const tasks = await loadHudTasks(ctx.cwd, command, runCommand, ctx.signal);
	const assigned = tasks.filter((task) => isActiveTask(task) && task.assigned_to === assignedTo);
	const fingerprint = assigned.map((task) => `${task.id}:${task.status}:${task.updated_at}`).join("|");
	if (fingerprint.length === 0) {
		state.lastReminderFingerprint = undefined;
		return;
	}
	if (state.lastReminderFingerprint === fingerprint) return;
	state.lastReminderFingerprint = fingerprint;
	const reminder = assignedTaskReminder(tasks, assignedTo);
	if (!reminder) return;
	pi.sendMessage(
		{
			customType: "task-reminder",
			content: [{ type: "text", text: reminder }],
			display: true,
			details: { assignedTo },
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

export default function tasksExtension(pi: ExtensionAPI, runtime: Runtime = {}) {
	const config = loadConfig();
	if (!config.enabled) return;

	const runCommand = runtime.runCommand ?? defaultRunCommand;
	let cwd = process.cwd();
	const reminderState: { lastReminderFingerprint?: string } = {};
	const getCwd = () => cwd;
	const common = (action: TaskCommand) => makeTaskTool(action, config.command, runCommand, config, pi, getCwd);

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		if (config.hud.enabled) await updateTaskHud(ctx, pi, config.command, runCommand, config);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await remindAssignedTasks(pi, ctx, config.command, runCommand, reminderState).catch((error) => {
			ctx.ui.notify?.(`Task reminder failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
	});

	pi.registerTool({
		...common("add"),
		name: "task_add",
		label: "Add Task",
		description: "Create a persisted project task via ct task add.",
		promptSnippet: "Create a persisted project task",
		parameters: Type.Object({
			title: Type.String({ description: "Task title" }),
			body: Type.Optional(Type.String({ description: "Task details/body" })),
			status: Type.Optional(Type.String({ description: "Task status (default: open)" })),
			priority: Type.Optional(Type.Number({ description: "Task priority; higher shows first" })),
			assigned_to: Type.Optional(Type.String({ description: "Session/user assignment, or 'current'" })),
			blocked_by: Type.Optional(
				Type.Array(Type.String(), { description: "Task IDs/prefixes that block this task" }),
			),
		}),
	});

	pi.registerTool({
		...common("list"),
		name: "task_list",
		label: "List Tasks",
		description: "List persisted project tasks via ct task list.",
		promptSnippet: "List persisted project tasks",
		parameters: Type.Object({
			status: Type.Optional(Type.String({ description: "Filter by status" })),
			assigned_to: Type.Optional(Type.String({ description: "Filter by assignee/session, or 'current'" })),
			all: Type.Optional(Type.Boolean({ description: "Include completed/canceled tasks" })),
		}),
	});

	pi.registerTool({
		...common("show"),
		name: "task_show",
		label: "Show Task",
		description: "Show one persisted project task by ID or unique prefix.",
		promptSnippet: "Show a persisted project task",
		parameters: Type.Object({
			id: Type.String({ description: "Task ID or unique prefix" }),
		}),
	});

	pi.registerTool({
		...common("update"),
		name: "task_update",
		label: "Update Task",
		description: "Update a persisted project task by ID or unique prefix.",
		promptSnippet: "Update a persisted project task",
		parameters: Type.Object({
			id: Type.String({ description: "Task ID or unique prefix" }),
			title: Type.Optional(Type.String({ description: "New title" })),
			body: Type.Optional(Type.String({ description: "New details/body" })),
			status: Type.Optional(Type.String({ description: "New status" })),
			priority: Type.Optional(Type.Number({ description: "New priority; higher shows first" })),
			assigned_to: Type.Optional(Type.String({ description: "Assign to this session/user, or 'current'" })),
			clear_assignee: Type.Optional(Type.Boolean({ description: "Remove assignee" })),
			blocked_by: Type.Optional(
				Type.Array(Type.String(), { description: "Replace blockers with these task IDs/prefixes" }),
			),
			clear_blockers: Type.Optional(Type.Boolean({ description: "Remove all blockers" })),
		}),
	});

	pi.registerTool({
		...common("delete"),
		name: "task_delete",
		label: "Delete Task",
		description: "Delete a persisted project task by ID or unique prefix.",
		promptSnippet: "Delete a persisted project task",
		parameters: Type.Object({
			id: Type.String({ description: "Task ID or unique prefix" }),
		}),
	});
}
