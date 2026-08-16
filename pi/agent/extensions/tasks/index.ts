import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundOutput } from "../shared/output-budget.ts";
import { toolRegistrarFor } from "../shared/tool-registry.ts";
import { getCoordinatorForSession } from "../subagents/runtime/coordinator.ts";
import {
	compareTasks,
	displayTaskId,
	gerundTitle,
	isCanceled,
	isComplete,
	maxTaskReminderAttempts,
	minimalTaskIdPrefixes,
	priority,
	renderTaskReminderMessage,
	resetTasksPresentation,
	sessionTaskId,
	showTaskBoard,
	shutdownTasksPresentation,
	type TaskBoardKeybindings,
	type TaskCommand,
	type TaskDetails,
	type TaskRecord,
	type TaskReminderDetails,
	taskToolPresentation,
	toggleTaskHud,
	updateTaskHud,
} from "./presentation";

export { buildTaskBoardItems, TaskBoardOverlay } from "./presentation";

const validTaskStatuses = ["open", "todo", "in_progress", "rejected", "done", "canceled"] as const;
type TaskStatus = (typeof validTaskStatuses)[number];

interface Config {
	enabled: boolean;
	hud: {
		enabled: boolean;
		maxTasks: number;
		minTerminalRows: number;
		toggleShortcut: string;
	};
	keybindings: TaskBoardKeybindings;
}

interface Runtime {}

interface TaskReminderState {
	attempts: number;
	awaitingProgress: boolean;
	toolsUsedThisTurn: boolean;
}

interface TaskStoreData {
	tasks: TaskRecord[];
}

interface TaskSnapshot {
	tasks: TaskRecord[];
}

const defaultConfig: Config = {
	enabled: true,
	hud: {
		enabled: true,
		maxTasks: 10,
		minTerminalRows: 24,
		toggleShortcut: "alt+t",
	},
	keybindings: {
		toggle: "alt+t",
		close: ["escape", "alt+t"],
		up: ["up", "k"],
		down: ["down", "j"],
		cycleStatus: ["space"],
		priorityUp: ["alt+k", "+"],
		priorityDown: ["alt+j", "-"],
		done: ["d"],
		cancel: ["x"],
		delete: ["D"],
		reload: ["r"],
		confirmDelete: ["y", "Y"],
		cancelDelete: ["n", "N"],
	},
};

function loadConfig(): Config {
	try {
		const parsed = JSON.parse(readFileSync(join(import.meta.dirname, "config.json"), "utf8")) as Partial<Config>;
		return {
			...defaultConfig,
			...parsed,
			hud: { ...defaultConfig.hud, ...parsed.hud },
			keybindings: { ...defaultConfig.keybindings, ...parsed.keybindings },
		};
	} catch {
		return defaultConfig;
	}
}

function objectParam(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textResult(text: string, details: TaskDetails) {
	// Single construction point for every task result, so bounding here covers
	// the read actions (`list`, `show`) that grow with the task set. Writes are
	// far below the budget and pass through untouched.
	return { content: [{ type: "text" as const, text: boundOutput(text).text }], details };
}

function taskStorePath(cwd: string, ctx?: ExtensionContext): string {
	return join(cwd, ".pi", "tasks", "sessions", `${sessionTaskFileName(ctx)}.json`);
}

function taskStoreDir(cwd: string): string {
	return join(cwd, ".pi", "tasks", "sessions");
}

function sessionTaskFileName(ctx?: ExtensionContext): string {
	const sessionId = sessionTaskId(ctx);
	if (!sessionId) throw new Error("Task session id is unavailable");
	return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

class TaskStore {
	private tasks = new Map<string, TaskRecord>();

	constructor(
		private readonly cwd: string,
		private readonly ctx?: ExtensionContext,
	) {
		this.load();
	}

	private load(): void {
		const path = taskStorePath(this.cwd, this.ctx);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TaskStoreData>;
			this.tasks.clear();
			for (const task of parsed.tasks ?? []) this.tasks.set(task.id, normalizeStoredTask(task));
			if (this.migrateNumericIds()) this.save();
		} catch {}
	}

	private save(): void {
		const path = taskStorePath(this.cwd, this.ctx);
		mkdirSync(taskStoreDir(this.cwd), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify({ tasks: this.listRaw() }, null, 2));
		renameSync(tmp, path);
	}

	private listRaw(): TaskRecord[] {
		return [...this.tasks.values()].sort(compareTasks);
	}

	add(params: Record<string, unknown>): TaskRecord {
		const now = Date.now();
		const status = normalizeStatus(params.status, "open");
		const task: TaskRecord = {
			id: this.nextId(),
			title: requiredString(params.title, "title"),
			body: stringValue(params.body),
			status,
			type: normalizeTaskType(params.type),
			labels: stringArray(params.labels),
			priority: numberValue(params.priority) ?? 0,
			parent_id: stringOrNull(params.parent_id),
			blocked_by: stringArray(params.blocked_by),
			active_form: stringOrNull(params.active_form),
			started_at: status === "in_progress" ? now : null,
			completed_at: isTerminalStatus(status) ? now : null,
			created_at: now,
			updated_at: now,
		};
		this.tasks.set(task.id, task);
		this.save();
		return task;
	}

	list(filters: Record<string, unknown>): TaskRecord[] {
		this.load();
		return this.listRaw().filter((task) => {
			if (filters.all !== true && isCanceled(task)) return false;
			if (typeof filters.status === "string" && task.status !== filters.status) return false;
			if (typeof filters.type === "string" && task.type !== filters.type) return false;
			if (typeof filters.label === "string" && !(task.labels ?? []).includes(filters.label)) return false;
			return true;
		});
	}

	show(id: string): TaskRecord {
		this.load();
		return this.resolve(id);
	}

	update(id: string, params: Record<string, unknown>): TaskRecord {
		this.load();
		const task = this.resolve(id);
		const now = Date.now();
		const normalized = params;
		if (typeof normalized.title === "string") task.title = normalized.title;
		if (typeof normalized.body === "string") task.body = normalized.body;
		if (typeof normalized.priority === "number") task.priority = normalized.priority;
		if (Array.isArray(normalized.labels)) task.labels = stringArray(normalized.labels);
		if (typeof normalized.type === "string") task.type = normalizeTaskType(normalized.type);
		if (normalized.parent_id !== undefined) task.parent_id = stringOrNull(normalized.parent_id);
		if (normalized.clear_parent === true) task.parent_id = null;
		if (Array.isArray(normalized.blocked_by)) task.blocked_by = stringArray(normalized.blocked_by);
		if (normalized.clear_blockers === true) task.blocked_by = [];
		if (normalized.active_form !== undefined) task.active_form = stringOrNull(normalized.active_form);
		if (typeof normalized.status === "string") {
			const nextStatus = normalizeStatus(normalized.status, task.status);
			if (nextStatus === "in_progress" && task.status !== "in_progress") {
				task.started_at = now;
				if (!task.active_form) task.active_form = gerundTitle(task.title);
			}
			if (isTerminalStatus(nextStatus) && !task.completed_at) task.completed_at = now;
			if (!isTerminalStatus(nextStatus)) task.completed_at = null;
			task.status = nextStatus;
		}
		task.updated_at = now;
		this.tasks.set(task.id, task);
		this.save();
		return task;
	}

	delete(id: string): string {
		this.load();
		const task = this.resolve(id);
		this.tasks.delete(task.id);
		for (const candidate of this.tasks.values()) {
			candidate.blocked_by = (candidate.blocked_by ?? []).filter((blocker) => blocker !== task.id);
			if (candidate.parent_id === task.id) candidate.parent_id = null;
		}
		this.save();
		return task.id;
	}

	private migrateNumericIds(): boolean {
		const remap = new Map<string, string>();
		const taken = new Set(this.tasks.keys());
		for (const id of this.tasks.keys()) {
			if (!/^\d+$/.test(id)) continue;
			const next = uniqueRandomTaskId(taken);
			remap.set(id, next);
			taken.add(next);
		}
		if (remap.size === 0) return false;
		const migrated = new Map<string, TaskRecord>();
		for (const task of this.tasks.values()) {
			const id = remap.get(task.id) ?? task.id;
			migrated.set(id, {
				...task,
				id,
				parent_id: task.parent_id ? (remap.get(task.parent_id) ?? task.parent_id) : task.parent_id,
				blocked_by: (task.blocked_by ?? []).map((blocker) => remap.get(blocker) ?? blocker),
			});
		}
		this.tasks = migrated;
		return true;
	}

	private nextId(): string {
		return uniqueRandomTaskId(new Set(this.tasks.keys()));
	}

	private resolve(idOrPrefix: string): TaskRecord {
		const exact = this.tasks.get(idOrPrefix);
		if (exact) return exact;
		const matches = [...this.tasks.values()].filter((task) => task.id.startsWith(idOrPrefix));
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new Error(`Task id prefix '${idOrPrefix}' is ambiguous`);
		throw new Error(`Task not found: ${idOrPrefix}`);
	}
}

function normalizeStoredTask(task: TaskRecord): TaskRecord {
	return {
		id: task.id,
		title: task.title,
		body: task.body ?? "",
		status: task.status ?? "open",
		type: task.type ?? "chore",
		labels: task.labels ?? [],
		priority: task.priority ?? 0,
		parent_id: task.parent_id ?? null,
		blocked_by: task.blocked_by ?? [],
		active_form: task.active_form ?? null,
		started_at: task.started_at ?? null,
		completed_at: task.completed_at ?? null,
		created_at: task.created_at ?? Date.now(),
		updated_at: task.updated_at ?? task.created_at ?? Date.now(),
	};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function requiredString(value: unknown, name: string): string {
	const text = stringValue(value).trim();
	if (!text) throw new Error(`Task ${name} is required`);
	return text;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.length > 0)
		: [];
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function normalizeStatus(value: unknown, fallback: string): TaskStatus {
	const status = typeof value === "string" && value.length > 0 ? value : fallback;
	if (status === "pending") return "open";
	if (validTaskStatuses.includes(status as TaskStatus)) return status as TaskStatus;
	throw new Error(`Unsupported task status: ${status}. Valid statuses: ${validTaskStatuses.join(", ")}`);
}

function isTerminalStatus(status: string): boolean {
	return status === "done" || status === "completed" || status === "canceled";
}

function normalizeTaskType(value: unknown): string {
	const type = typeof value === "string" && value.length > 0 ? value : "chore";
	if (type === "epic") throw new Error("Epic tasks are no longer supported; create flat tasks with blockers instead.");
	return type;
}

const taskIdAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";

function randomTaskId(): string {
	const bytes = randomBytes(6);
	let id = "";
	for (const byte of bytes) id += taskIdAlphabet[byte % taskIdAlphabet.length];
	return id;
}

function uniqueRandomTaskId(taken: ReadonlySet<string>): string {
	for (let attempt = 0; attempt < 16; attempt++) {
		const id = randomTaskId();
		if (!taken.has(id)) return id;
	}
	throw new Error("Could not generate a unique task id");
}

function taskBody(task: TaskRecord, prefixes: ReadonlyMap<string, string>): string {
	const blocked = task.blocked_by?.length
		? `\nBlocked by: ${task.blocked_by.map((id) => displayTaskId(id, prefixes)).join(", ")}`
		: "";
	return `${displayTaskId(task.id, prefixes)} [${task.status}] ${task.title}${blocked}`;
}

function executeTask(cwd: string, action: TaskCommand, params: Record<string, unknown>, ctx?: ExtensionContext) {
	const store = new TaskStore(cwd, ctx);
	const normalizedParams = normalizeTaskWriteParams(params);
	let details: TaskDetails;
	let text: string;
	switch (action) {
		case "add": {
			const task = store.add(normalizedParams);
			const tasks = store.list({ all: true });
			const prefixes = minimalTaskIdPrefixes(tasks);
			details = { action, args: [], task };
			text = `Created task ${taskBody(task, prefixes)}`;
			break;
		}
		case "list": {
			const tasks = store.list(params);
			const prefixes = minimalTaskIdPrefixes(tasks);
			details = { action, args: [], tasks };
			text = tasks.length ? tasks.map((task) => taskBody(task, prefixes)).join("\n") : "No tasks";
			break;
		}
		case "show": {
			const task = store.show(requiredString(params.id, "id"));
			details = { action, args: [], task };
			const allTasks = store.list({ all: true });
			const prefixes = minimalTaskIdPrefixes(allTasks);
			text = detailedTaskText(task, allTasks, prefixes);
			break;
		}
		case "update": {
			const task = store.update(requiredString(params.id, "id"), normalizedParams);
			const tasks = store.list({ all: true });
			const prefixes = minimalTaskIdPrefixes(tasks);
			details = { action, args: [], task };
			text = `Updated task ${taskBody(task, prefixes)}`;
			break;
		}
		case "delete": {
			const deleted = store.delete(requiredString(params.id, "id"));
			details = { action, args: [], deleted };
			text = `Deleted ${deleted}`;
			break;
		}
	}
	return textResult(text, details);
}

function detailedTaskText(task: TaskRecord, tasks: TaskRecord[], prefixes: ReadonlyMap<string, string>): string {
	const blocked = (task.blocked_by ?? []).map((id) => displayTaskId(id, prefixes)).join(", ") || "none";
	const blocks =
		tasks
			.filter((candidate) => (candidate.blocked_by ?? []).includes(task.id))
			.map((candidate) => displayTaskId(candidate.id, prefixes))
			.join(", ") || "none";
	return [
		`Task ${displayTaskId(task.id, prefixes)}: ${task.title}`,
		`Status: ${task.status}`,
		`Type: ${task.type ?? "chore"}`,
		`Priority: ${priority(task)}`,
		`Blocked by: ${blocked}`,
		`Blocks: ${blocks}`,
		task.body.trim() ? `Description:\n${task.body.trim()}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

async function loadTaskSnapshot(ctx: ExtensionContext): Promise<TaskSnapshot> {
	return { tasks: new TaskStore(ctx.cwd, ctx).list({ all: true }) };
}

async function loadHudTasks(ctx: ExtensionContext) {
	return (await loadTaskSnapshot(ctx)).tasks;
}

function isActiveTask(task: TaskRecord): boolean {
	return !isComplete(task) && !isCanceled(task);
}

const taskReadActions = new Set<TaskCommand>(["list", "show"]);
const taskWriteActions = new Set<TaskCommand>(["add", "update", "delete"]);

function taskReadAction(params: Record<string, unknown>): TaskCommand {
	const mode = String(params.mode ?? (params.id ? "show" : "list"));
	if (!taskReadActions.has(mode as TaskCommand)) throw new Error("task_read mode must be 'list' or 'show'");
	if (mode === "show" && typeof params.id !== "string") throw new Error("task_read mode 'show' requires id");
	return mode as TaskCommand;
}

function taskWriteAction(params: Record<string, unknown>): TaskCommand {
	const op = String(params.op ?? "");
	if (!taskWriteActions.has(op as TaskCommand)) throw new Error("task_write op must be add, update, or delete");
	const data = objectParam(params.data);
	if (op === "add" && typeof params.title !== "string" && typeof data.title !== "string") {
		throw new Error("task_write op 'add' requires title");
	}
	if (op !== "add" && typeof params.id !== "string") throw new Error(`task_write op '${op}' requires id`);
	return op as TaskCommand;
}

function normalizeTaskWriteParams(params: Record<string, unknown>): Record<string, unknown> {
	const data = objectParam(params.data);
	const clear = new Set(Array.isArray(params.clear) ? params.clear.filter((item) => typeof item === "string") : []);
	return {
		...data,
		...params,
		title: params.title ?? data.title,
		clear_parent: params.clear_parent === true || clear.has("parent"),
		clear_blockers: params.clear_blockers === true || clear.has("blockers"),
	};
}

function makeCombinedTaskTool(
	resolveAction: (params: Record<string, unknown>) => TaskCommand,
	config: Config,
	getCwd: () => string,
	onProgress?: (ctx: ExtensionContext | undefined, action: TaskCommand, result: unknown) => void,
) {
	return {
		...taskToolPresentation(),
		execute: async (
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			ctx?: ExtensionContext,
		) => {
			const action = resolveAction(params);
			const result = executeTask(ctx?.cwd ?? getCwd(), action, params, ctx);
			if (action !== "list" && action !== "show") {
				onProgress?.(ctx, action, result);
				if (ctx && config.hud.enabled) await updateTaskHud(ctx, config, await loadHudTasks(ctx)).catch(() => {});
			}
			return result;
		},
	};
}

function sortedReminderTasks(tasks: TaskRecord[]): TaskRecord[] {
	return [...tasks].sort(compareTasks);
}

function activeSessionTasks(tasks: TaskRecord[]): TaskRecord[] {
	return sortedReminderTasks(tasks.filter(isActiveTask));
}

async function taskReminderTasks(ctx: ExtensionContext): Promise<TaskRecord[]> {
	return activeSessionTasks(await loadHudTasks(ctx));
}

function taskReminderContent(tasks: TaskRecord[], prefixes: ReadonlyMap<string, string>, attempt: number): string {
	const count = tasks.length;
	const taskList = tasks
		.map((task) => `- ${displayTaskId(task.id, prefixes)} [${task.status}] ${task.title}`)
		.join("\n");
	return [
		`Task reminder: ${count} active task${count === 1 ? "" : "s"}.`,
		taskList,
		"",
		"Continue the current session's task work or update task status.",
		`Reminder ${attempt}/${maxTaskReminderAttempts}`,
	].join("\n");
}

function resetTaskReminder(state: TaskReminderState): void {
	state.attempts = 0;
	state.awaitingProgress = false;
}

function hasActiveOwnedAgents(ctx: ExtensionContext): boolean {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	if (!sessionId) return false;
	return Boolean(
		getCoordinatorForSession(sessionId)
			?.snapshot()
			.some((agent) => agent.status === "running" || agent.status === "queued"),
	);
}

async function maybeSendTaskReminder(pi: ExtensionAPI, state: TaskReminderState, ctx: ExtensionContext): Promise<void> {
	if (hasActiveOwnedAgents(ctx)) {
		state.awaitingProgress = false;
		return;
	}
	if (state.toolsUsedThisTurn) {
		state.awaitingProgress = false;
		return;
	}
	if (state.awaitingProgress || state.attempts >= maxTaskReminderAttempts) return;
	const tasks = await taskReminderTasks(ctx);
	if (tasks.length === 0) {
		resetTaskReminder(state);
		return;
	}
	state.attempts += 1;
	state.awaitingProgress = true;
	const details = {
		tasks: tasks.map((task) => ({
			id: task.id,
			title: task.title,
			status: task.status,
			blocked_by: task.blocked_by,
		})),
		attempts: state.attempts,
		maxAttempts: maxTaskReminderAttempts,
	} satisfies TaskReminderDetails;
	pi.sendMessage(
		{
			customType: "task-reminder",
			content: [{ type: "text", text: taskReminderContent(tasks, minimalTaskIdPrefixes(tasks), state.attempts) }],
			display: true,
			details,
		},
		undefined,
	);
}

export default function tasksExtension(pi: ExtensionAPI, _runtime: Runtime = {}) {
	const config = loadConfig();
	if (!config.enabled) return;
	const registerTaskTool = toolRegistrarFor(pi);
	resetTasksPresentation();

	let cwd = process.cwd();
	let activeTaskHudSessionId: string | undefined;
	const reminderState: TaskReminderState = { attempts: 0, awaitingProgress: false, toolsUsedThisTurn: false };
	const getCwd = () => cwd;
	const markToolUsed = () => {
		reminderState.toolsUsedThisTurn = true;
		reminderState.awaitingProgress = false;
	};

	pi.registerMessageRenderer?.("task-reminder", renderTaskReminderMessage as never);

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		activeTaskHudSessionId = sessionTaskId(ctx) ?? `cwd:${ctx.cwd}`;
		resetTaskReminder(reminderState);
		reminderState.toolsUsedThisTurn = false;
		if (config.hud.enabled) {
			await updateTaskHud(ctx, config, await loadHudTasks(ctx)).catch((error) => {
				ctx.ui.notify?.(
					`Task HUD refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const sessionId = activeTaskHudSessionId ?? sessionTaskId(ctx) ?? `cwd:${ctx.cwd}`;
		shutdownTasksPresentation(sessionId, event.reason === "reload");
		activeTaskHudSessionId = undefined;
	});

	pi.on("tool_execution_end", () => {
		markToolUsed();
	});

	(pi as unknown as { on(event: string, handler: (event: unknown) => unknown): void }).on("message_end", (event) => {
		const message = (event as { message?: { customType?: unknown; role?: string } }).message;
		if (message?.role === "user" && message.customType !== "task-reminder") {
			resetTaskReminder(reminderState);
			reminderState.toolsUsedThisTurn = false;
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		const usedToolsThisTurn = reminderState.toolsUsedThisTurn;
		reminderState.toolsUsedThisTurn = false;
		if (usedToolsThisTurn) {
			reminderState.awaitingProgress = false;
			return;
		}
		try {
			await maybeSendTaskReminder(pi, reminderState, ctx);
		} catch (error) {
			ctx.ui.notify?.(`Task reminder failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.registerCommand?.("tasks", {
		description: "Open project task list; pass a task id to focus it",
		handler: async (args: string, ctx: ExtensionContext) => {
			const initialTaskId = args.trim().split(/\s+/).filter(Boolean)[0];
			await showTaskBoard(
				ctx,
				config,
				{
					load: () => loadHudTasks(ctx),
					mutate: async (action, params) => {
						executeTask(ctx.cwd, action, params, ctx);
						return loadHudTasks(ctx);
					},
				},
				initialTaskId,
			).catch((error) => {
				ctx.ui.notify?.(`Task board failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
		},
	});

	pi.registerShortcut?.(config.hud.toggleShortcut as never, {
		description: "Toggle project task HUD summary/list view",
		handler: async (ctx: ExtensionContext) => {
			await toggleTaskHud(ctx, config, () => loadHudTasks(ctx)).catch((error) => {
				ctx.ui.notify?.(
					`Task HUD refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		},
	});

	registerTaskTool({
		...makeCombinedTaskTool(taskReadAction, config, getCwd, markToolUsed),
		name: "task_read",
		label: "Read Tasks",
		description: "List/show project tasks.",
		promptSnippet: "Read project tasks",
		parameters: Type.Object({
			mode: Type.Optional(Type.String({ description: "'list' or 'show'. Defaults to list unless id is provided." })),
			id: Type.Optional(Type.String({ description: "Task ID/prefix for show" })),
			status: Type.Optional(Type.String({ description: "List filter" })),
			type: Type.Optional(Type.String({ description: "List filter" })),
			label: Type.Optional(Type.String({ description: "List filter" })),
			all: Type.Optional(Type.Boolean({ description: "Include completed/canceled tasks" })),
		}),
	});

	registerTaskTool({
		...makeCombinedTaskTool(taskWriteAction, config, getCwd, markToolUsed),
		name: "task_write",
		label: "Write Tasks",
		description:
			"Add/update/delete tasks for the current session. Put fields in data: type, body, status, priority, active_form, labels, parent_id, blocked_by. Use clear for parent/blockers.",
		promptSnippet: "Write project tasks",
		parameters: Type.Object({
			op: Type.String({ description: "add, update, or delete" }),
			id: Type.Optional(Type.String({ description: "Task ID/prefix; required except add" })),
			title: Type.Optional(Type.String({ description: "Add title shorthand" })),
			data: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "Add/update fields, e.g. status/priority/labels/blocked_by/active_form",
				}),
			),
			clear: Type.Optional(Type.Array(Type.String(), { description: "parent, blockers" })),
		}),
	});
}
