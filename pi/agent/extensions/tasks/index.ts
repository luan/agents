import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	if (typeof value !== "string" || value.length === 0) return;
	args.push(name, value);
}

export function buildTaskCommand(action: TaskCommand, params: Record<string, unknown>): string[] {
	const args = ["task", action];
	switch (action) {
		case "add":
			args.push(String(params.title ?? ""));
			pushOption(args, "--body", params.body);
			pushOption(args, "--status", params.status);
			break;
		case "list":
			pushOption(args, "--status", params.status);
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

async function executeTask(
	command: string,
	runCommand: typeof defaultRunCommand,
	cwd: string,
	action: TaskCommand,
	params: Record<string, unknown>,
	config: Config,
	ctx?: ExtensionContext,
	signal?: AbortSignal,
) {
	const args = buildTaskCommand(action, params);
	const result = await runCommand(command, args, cwd, signal);
	const text = result.stdout.trim() || result.stderr.trim();
	const details = parseTaskPayload(text, action, args);
	if (ctx && config.hud.enabled && (action === "add" || action === "update" || action === "delete")) {
		await updateTaskHud(ctx, command, runCommand, config).catch((error) => {
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
	command: string,
	runCommand: typeof defaultRunCommand,
	config: Config,
): Promise<void> {
	const tasks = await loadHudTasks(ctx.cwd, command, runCommand, ctx.signal);
	ctx.ui.setWidget(widgetId, (_tui, theme) => ({
		render: (width: number) => renderHudLines(tasks, theme, width, config.hud.maxTasks),
		invalidate() {},
	}));
}

function statusGlyph(status: string): string {
	switch (status) {
		case "done":
			return "✓";
		case "blocked":
			return "!";
		case "in_progress":
			return "●";
		case "canceled":
			return "×";
		default:
			return "○";
	}
}

function statusColor(status: string): string {
	switch (status) {
		case "done":
			return "success";
		case "blocked":
			return "warning";
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

function formatTaskLine(task: TaskRecord, theme: Theme, width: number): string {
	const glyph = theme.fg(statusColor(task.status), statusGlyph(task.status));
	const id = theme.fg("accent", task.id);
	const status = theme.fg("muted", task.status);
	const title = theme.fg("text", compact(task.title, Math.max(20, width - 28)));
	return truncateToWidth(`${glyph} ${id} ${status} ${title}`, width);
}

export function renderHudLines(tasks: TaskRecord[], theme: Theme, width: number, maxTasks = 6): string[] {
	const active = tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
	if (active.length === 0) {
		return [truncateToWidth(`${theme.fg("accent", "Tasks")} ${theme.fg("dim", "none open")}`, width)];
	}
	const shown = active.slice(0, maxTasks);
	const hidden = active.length - shown.length;
	const lines = [
		truncateToWidth(
			`${theme.fg("accent", theme.bold(`Tasks ${active.length}`))} ${theme.fg("dim", "persisted project work")}`,
			width,
		),
		...shown.map((task) => formatTaskLine(task, theme, width)),
	];
	if (hidden > 0) lines.push(truncateToWidth(theme.fg("dim", `… ${hidden} more`), width));
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
	return [
		theme.fg("toolTitle", theme.bold(title)),
		`  ${theme.fg(statusColor(task.status), statusGlyph(task.status))} ${theme.fg("accent", task.id)} ${theme.fg("muted", task.status)} ${theme.fg("text", task.title)}`,
		...(task.body ? [`  ${theme.fg("dim", compact(task.body, 120))}`] : []),
	].join("\n");
}

function renderTaskList(tasks: TaskRecord[], theme: Theme): string {
	if (tasks.length === 0) return `${theme.fg("toolTitle", theme.bold("Tasks"))}\n  ${theme.fg("dim", "No tasks")}`;
	const lines = [theme.fg("toolTitle", theme.bold(`Tasks (${tasks.length})`))];
	for (const task of tasks.slice(0, 12)) {
		lines.push(
			`  ${theme.fg(statusColor(task.status), statusGlyph(task.status))} ${theme.fg("accent", task.id)} ${theme.fg("muted", task.status)} ${theme.fg("text", compact(task.title, 96))}`,
		);
	}
	if (tasks.length > 12) lines.push(theme.fg("dim", `  … ${tasks.length - 12} more`));
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
	constructor(private text: string) {}

	setText(text: string): void {
		this.text = text;
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
		) => executeTask(command, runCommand, getCwd(), action, params, config, ctx, signal),
	};
}

export default function tasksExtension(pi: ExtensionAPI, runtime: Runtime = {}) {
	const config = loadConfig();
	if (!config.enabled) return;

	const runCommand = runtime.runCommand ?? defaultRunCommand;
	let cwd = process.cwd();
	const getCwd = () => cwd;
	const common = (action: TaskCommand) => makeTaskTool(action, config.command, runCommand, config, getCwd);

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		if (config.hud.enabled) await updateTaskHud(ctx, config.command, runCommand, config);
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
