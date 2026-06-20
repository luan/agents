import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	type ExtensionAPI,
	type ExtensionContext,
	type ThemeColor,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	truncateToWidth as truncateAnsiToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { hasEnoughTerminalRows } from "../shared/terminal";
import {
	defineExtensionTui,
	EmptyComponent,
	setOrderedAboveEditorWidget,
	padToVisibleWidth as sharedPadToVisibleWidth,
} from "../shared/tui";

const tasksTui = defineExtensionTui({ id: "tasks" });
type TaskCommand = "add" | "list" | "show" | "update" | "delete";
type TaskStatus = "open" | "todo" | "in_progress" | "in_review" | "rejected" | "done" | "canceled";

interface Theme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	strikethrough?(text: string): string;
}

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

interface GuardState {
	enabled: boolean;
	toolsUsedThisTurn: boolean;
	noToolNudges: number;
	reviewNudgeKeys: Set<string>;
}

interface TaskRecord {
	id: string;
	title: string;
	body: string;
	status: string;
	type?: string;
	labels?: string[];
	priority?: number;
	assigned_to?: string | null;
	assigned_label?: string | null;
	parent_id?: string | null;
	blocked_by?: string[];
	active_form?: string | null;
	started_at?: number | null;
	completed_at?: number | null;
	created_at: number;
	updated_at: number;
}
interface TaskStoreData {
	tasks: TaskRecord[];
}

interface TaskSnapshot {
	tasks: TaskRecord[];
}

interface TaskDetails {
	action: TaskCommand;
	args: string[];
	task?: TaskRecord;
	tasks?: TaskRecord[];
	deleted?: string;
}

interface TaskBoardKeybindings {
	toggle: string;
	close: string[];
	up: string[];
	down: string[];
	cycleStatus: string[];
	assignCurrent: string[];
	clearAssignee: string[];
	priorityUp: string[];
	priorityDown: string[];
	done: string[];
	cancel: string[];
	delete: string[];
	reload: string[];
	confirmDelete: string[];
	cancelDelete: string[];
}

const widgetId = "project-tasks";
const taskHudPulseFrameMs = 160;
const silentTaskToolNames = new Set(["task_read", "task_write"]);
const silentTaskToolPatchKey = Symbol.for("agents.tasks.silent-tool-render-patch");
const spinnerFrames = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
let activeTaskBoard: { close: () => void } | undefined;
let taskHudExpanded = true;
let taskHudPulseTimer: ReturnType<typeof setInterval> | undefined;
let requestTaskHudRender: (() => void) | undefined;
let taskHudWidget: TaskHudWidget | undefined;
let taskHudWidgetCtx: ExtensionContext | undefined;
let latestTaskHudState: TaskHudState | undefined;
let taskHudFrame = 0;

interface TaskHudState {
	tasks: TaskRecord[];
	display: AssignmentDisplayContext;
	config: Config;
	taskGuardEnabled: boolean;
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
		assignCurrent: ["a"],
		clearAssignee: ["u"],
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
	return { content: [{ type: "text" as const, text }], details };
}

function taskStorePath(cwd: string): string {
	return join(cwd, ".pi", "tasks", "tasks.json");
}

class TaskStore {
	private tasks = new Map<string, TaskRecord>();

	constructor(private readonly cwd: string) {
		this.load();
	}

	private load(): void {
		try {
			const parsed = JSON.parse(readFileSync(taskStorePath(this.cwd), "utf8")) as Partial<TaskStoreData>;
			this.tasks.clear();
			for (const task of parsed.tasks ?? []) this.tasks.set(task.id, normalizeStoredTask(task));
			if (this.migrateNumericIds()) this.save();
		} catch {}
	}

	private save(): void {
		const path = taskStorePath(this.cwd);
		mkdirSync(join(this.cwd, ".pi", "tasks"), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify({ tasks: this.listRaw() }, null, 2));
		renameSync(tmp, path);
	}

	private listRaw(): TaskRecord[] {
		return [...this.tasks.values()].sort(compareTasks);
	}

	add(params: Record<string, unknown>, ctx?: ExtensionContext, pi?: ExtensionAPI): TaskRecord {
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
			assigned_to: stringOrNull(params.assigned_to),
			assigned_label: stringOrNull(params.assigned_label),
			parent_id: stringOrNull(params.parent_id),
			blocked_by: stringArray(params.blocked_by),
			active_form: stringOrNull(params.active_form),
			started_at: status === "in_progress" ? now : null,
			completed_at: isTerminalStatus(status) ? now : null,
			created_at: now,
			updated_at: now,
		};
		const normalized = normalizeTaskParams(task as unknown as Record<string, unknown>, ctx, pi);
		Object.assign(task, normalized);
		this.tasks.set(task.id, task);
		this.save();
		return task;
	}

	list(filters: Record<string, unknown>, ctx?: ExtensionContext): TaskRecord[] {
		this.load();
		const assignedFilter =
			filters.assigned_to === "current" ? sessionAssignmentAliases(ctx) : stringValue(filters.assigned_to);
		return this.listRaw().filter((task) => {
			if (filters.all !== true && isCanceled(task)) return false;
			if (typeof filters.status === "string" && task.status !== filters.status) return false;
			if (typeof filters.type === "string" && task.type !== filters.type) return false;
			if (typeof filters.label === "string" && !(task.labels ?? []).includes(filters.label)) return false;
			if (Array.isArray(assignedFilter)) {
				if (assignedFilter.length === 0 || !assignedFilter.includes(task.assigned_to ?? "")) return false;
			} else if (assignedFilter && task.assigned_to !== assignedFilter) return false;
			return true;
		});
	}

	show(id: string): TaskRecord {
		this.load();
		return this.resolve(id);
	}

	update(id: string, params: Record<string, unknown>, ctx?: ExtensionContext, pi?: ExtensionAPI): TaskRecord {
		this.load();
		const task = this.resolve(id);
		guardTaskCompletion(task, params);
		const now = Date.now();
		const normalized = normalizeTaskParams(params, ctx, pi);
		if (typeof normalized.title === "string") task.title = normalized.title;
		if (typeof normalized.body === "string") task.body = normalized.body;
		if (typeof normalized.priority === "number") task.priority = normalized.priority;
		if (Array.isArray(normalized.labels)) task.labels = stringArray(normalized.labels);
		if (typeof normalized.type === "string") task.type = normalizeTaskType(normalized.type);
		if (normalized.assigned_to !== undefined) task.assigned_to = stringOrNull(normalized.assigned_to);
		if (normalized.assigned_label !== undefined) task.assigned_label = stringOrNull(normalized.assigned_label);
		if (normalized.clear_assignee === true) {
			task.assigned_to = null;
			task.assigned_label = null;
		}
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
		...task,
		body: task.body ?? "",
		status: task.status ?? "open",
		type: task.type ?? "chore",
		labels: task.labels ?? [],
		priority: task.priority ?? 0,
		blocked_by: task.blocked_by ?? [],
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
	if (["open", "todo", "in_progress", "in_review", "rejected", "done", "canceled"].includes(status)) {
		return status as TaskStatus;
	}
	throw new Error(`Unsupported task status: ${status}`);
}

function isTerminalStatus(status: string): boolean {
	return status === "done" || status === "completed" || status === "canceled";
}

function isComplete(task: TaskRecord): boolean {
	return task.status === "done" || task.status === "completed";
}

function isCanceled(task: TaskRecord): boolean {
	return task.status === "canceled";
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

function minimalTaskIdPrefixes(tasks: readonly TaskRecord[]): Map<string, string> {
	const ids = tasks.map((task) => task.id);
	const prefixes = new Map<string, string>();
	for (const id of ids) {
		let prefix = id;
		for (let length = 1; length <= id.length; length++) {
			const candidate = id.slice(0, length);
			if (ids.filter((other) => other.startsWith(candidate)).length === 1) {
				prefix = candidate;
				break;
			}
		}
		prefixes.set(id, prefix);
	}
	return prefixes;
}

function displayTaskId(id: string, prefixes: ReadonlyMap<string, string>): string {
	return prefixes.get(id) ?? id;
}

function isStoryTaskType(value: unknown): boolean {
	return value === "feature" || value === "bug";
}

function guardTaskCompletion(task: TaskRecord, params: Record<string, unknown>): void {
	if (params.status !== "done" || !isStoryTaskType(params.type ?? task.type)) return;
	if (params.user_approved_completion === true || params.auto_verified_completion === true) return;
	throw new Error(
		"Mark feature/bug tasks done only after user approval with user_approved_completion=true, or in auto mode with auto_verified_completion=true.",
	);
}

function compareTasks(left: TaskRecord, right: TaskRecord): number {
	return (
		taskStatusRank(left) - taskStatusRank(right) ||
		priority(right) - priority(left) ||
		left.id.localeCompare(right.id)
	);
}

function taskStatusRank(task: TaskRecord): number {
	if (task.status === "in_progress") return 0;
	if (task.status === "rejected") return 1;
	if (task.status === "in_review") return 2;
	if (isComplete(task)) return 4;
	if (isCanceled(task)) return 5;
	return 3;
}

function priority(task: TaskRecord): number {
	return typeof task.priority === "number" ? task.priority : 0;
}

function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function gerundTitle(title: string): string {
	const trimmed = title.trim();
	const [verb = "Working", ...rest] = trimmed.split(/\s+/);
	const object = rest.join(" ");
	const lower = verb.toLowerCase();
	const gerunds: Record<string, string> = {
		add: "Adding",
		build: "Building",
		create: "Creating",
		debug: "Debugging",
		delete: "Deleting",
		diagnose: "Diagnosing",
		fix: "Fixing",
		implement: "Implementing",
		investigate: "Investigating",
		move: "Moving",
		remove: "Removing",
		render: "Rendering",
		review: "Reviewing",
		run: "Running",
		test: "Testing",
		update: "Updating",
		write: "Writing",
	};
	const gerund = gerunds[lower] ?? (lower.endsWith("ing") ? verb : "Working on");
	return object ? `${gerund} ${object}` : gerund;
}

function sessionAssignmentAliases(ctx?: ExtensionContext): string[] {
	const anyCtx = ctx as
		| (ExtensionContext & {
				sessionId?: string;
				session?: { id?: string };
				sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined };
		  })
		| undefined;
	const aliases: string[] = [];
	const add = (value: unknown) => {
		if (typeof value !== "string" || value.length === 0) return;
		const alias = `session:${value}`;
		if (!aliases.includes(alias)) aliases.push(alias);
	};
	add(anyCtx?.sessionId);
	add(anyCtx?.session?.id);
	const file = anyCtx?.sessionManager?.getSessionFile?.();
	if (typeof file === "string" && file.length > 0)
		add(
			file
				.split("/")
				.at(-1)
				?.replace(/\.jsonl$/, ""),
		);
	add(anyCtx?.sessionManager?.getSessionId?.());
	return aliases;
}

function sessionAssignment(ctx?: ExtensionContext): string | undefined {
	return sessionAssignmentAliases(ctx)[0];
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
			ctx as
				| (ExtensionContext & {
						sessionManager?: { getSessionName?: () => string | undefined };
				  })
				| undefined
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
	return {
		...params,
		assigned_to: assignedTo,
		assigned_label: sessionName(pi, ctx),
	};
}

function taskBody(task: TaskRecord, prefixes: ReadonlyMap<string, string>): string {
	const blocked = task.blocked_by?.length
		? `\nBlocked by: ${task.blocked_by.map((id) => displayTaskId(id, prefixes)).join(", ")}`
		: "";
	const assignee = assignmentLabel(task);
	const assigned = assignee ? `\nAssignee: ${assignee}` : "";
	return `${displayTaskId(task.id, prefixes)} [${task.status}] ${task.title}${assigned}${blocked}`;
}

function executeTask(
	cwd: string,
	action: TaskCommand,
	params: Record<string, unknown>,
	pi?: ExtensionAPI,
	ctx?: ExtensionContext,
) {
	const store = new TaskStore(cwd);
	const normalizedParams = normalizeTaskWriteParams(params);
	let details: TaskDetails;
	let text: string;
	switch (action) {
		case "add": {
			const task = store.add(normalizedParams, ctx, pi);
			const tasks = store.list({ all: true });
			const prefixes = minimalTaskIdPrefixes(tasks);
			details = { action, args: [], task };
			text = `Created task ${taskBody(task, prefixes)}`;
			break;
		}
		case "list": {
			const tasks = store.list(params, ctx);
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
			const task = store.update(requiredString(params.id, "id"), normalizedParams, ctx, pi);
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
		`Assigned: ${assignmentLabel(task) ?? "none"}`,
		`Blocked by: ${blocked}`,
		`Blocks: ${blocks}`,
		task.body.trim() ? `Description:\n${task.body.trim()}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

async function loadTaskSnapshot(cwd: string): Promise<TaskSnapshot> {
	return { tasks: new TaskStore(cwd).list({ all: true }) };
}

async function loadHudTasks(cwd: string) {
	return (await loadTaskSnapshot(cwd)).tasks;
}

class TaskHudWidget implements Component {
	constructor(
		private readonly tui: { requestRender?: () => void },
		private readonly theme: Theme,
		private state?: TaskHudState,
	) {}

	setState(state: TaskHudState): void {
		this.state = state;
		this.tui.requestRender?.();
	}

	render(width: number): string[] {
		const state = this.state;
		if (!state || !hasEnoughTerminalRows(state.config.hud.minTerminalRows)) return [];
		return renderHudLines(state.tasks, this.theme, width, state.config.hud.maxTasks, state.display, {
			compact: !taskHudExpanded,
			frame: taskHudFrame,
			taskGuardEnabled: state.taskGuardEnabled,
		});
	}

	invalidate() {}
}

function ensureTaskHudWidget(ctx: ExtensionContext): void {
	if (taskHudWidget && taskHudWidgetCtx === ctx) return;
	taskHudWidget = undefined;
	taskHudWidgetCtx = ctx;
	setOrderedAboveEditorWidget(ctx, widgetId, (tui, theme) => {
		requestTaskHudRender = typeof tui.requestRender === "function" ? () => tui.requestRender() : undefined;
		taskHudWidget = new TaskHudWidget(tui, theme, latestTaskHudState);
		return taskHudWidget;
	});
}

async function updateTaskHud(
	ctx: ExtensionContext,
	pi: ExtensionAPI | undefined,
	config: Config,
	taskGuardEnabled = latestTaskHudState?.taskGuardEnabled ?? false,
	preloadedTasks?: TaskRecord[],
): Promise<void> {
	const tasks = preloadedTasks ?? (await loadHudTasks(ctx.cwd));
	const display = assignmentDisplayContext(pi, ctx, tasks);
	const state = { tasks, display, config, taskGuardEnabled };
	latestTaskHudState = state;
	ensureTaskHudWidget(ctx);
	taskHudWidget?.setState(state);
	updateHudTimer(tasks);
}

function updateHudTimer(tasks: TaskRecord[]): void {
	const needsAnimation = tasks.some((task) => task.status === "in_progress");
	if (needsAnimation && !taskHudPulseTimer) {
		taskHudPulseTimer = setInterval(() => {
			taskHudFrame++;
			requestTaskHudRender?.();
		}, taskHudPulseFrameMs);
		taskHudPulseTimer.unref?.();
	} else if (!needsAnimation && taskHudPulseTimer) {
		clearInterval(taskHudPulseTimer);
		taskHudPulseTimer = undefined;
	}
}

async function showTaskBoard(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	config: Config,
	initialTaskId?: string,
): Promise<void> {
	if (activeTaskBoard) {
		activeTaskBoard.close();
		return;
	}
	const load = () => loadHudTasks(ctx.cwd);
	const tasks = await load();
	try {
		await tasksTui.bind(ctx).overlays.openComponent(
			(tui, theme, _keybindings, done) => {
				const close = () => done(undefined);
				activeTaskBoard = { close };
				const board = new TaskBoardOverlay({
					tasks,
					theme,
					keybindings: config.keybindings,
					initialTaskId,
					onClose: close,
					onReload: load,
					onMutate: async (action, params) => {
						executeTask(ctx.cwd, action, params, pi, ctx);
						return load();
					},
					onEditBody: async (task) => {
						const edited = await ctx.ui.editor(`Edit task ${task.id} body`, task.body ?? "");
						if (edited !== task.body) executeTask(ctx.cwd, "update", { id: task.id, body: edited }, pi, ctx);
						return load();
					},
					onChange: () => tui.requestRender(),
				});
				return {
					render: (width: number) => board.render(width),
					handleInput: (data: string) => {
						board.handleInput(data);
						tui.requestRender();
					},
					waitForIdle: () => board.waitForIdle(),
					invalidate: () => board.invalidate(),
				};
			},
			{
				overlay: true,
				overlayOptions: {
					width: "92%",
					maxHeight: "85%",
					minWidth: 70,
					anchor: "center",
					margin: 1,
				},
			},
		);
	} finally {
		activeTaskBoard = undefined;
	}
	if (config.hud.enabled) await updateTaskHud(ctx, pi, config).catch(() => {});
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

function isActiveTask(task: TaskRecord): boolean {
	return !isComplete(task) && !isCanceled(task);
}

export interface TaskBoardItem {
	task: TaskRecord;
	blocked: boolean;
}

export interface TaskBoardSelection {
	row: number;
}

export function buildTaskBoardItems(tasks: TaskRecord[]): TaskBoardItem[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	return [...tasks]
		.filter((task) => !isCanceled(task))
		.sort(compareTasks)
		.map((task) => ({ task, blocked: hasOpenBlockers(task, byId) }));
}

function clampSelection(items: TaskBoardItem[], selection: TaskBoardSelection): TaskBoardSelection {
	const row = Math.max(0, Math.min(Math.max(0, items.length - 1), selection.row));
	return { row };
}

function selectedTask(items: TaskBoardItem[], selection: TaskBoardSelection): TaskRecord | undefined {
	return items[clampSelection(items, selection).row]?.task;
}

function selectionForTask(items: TaskBoardItem[], taskId: string): TaskBoardSelection | undefined {
	const row = items.findIndex((item) => item.task.id === taskId);
	return row >= 0 ? { row } : undefined;
}

function truncateLine(text: string, width: number): string {
	return truncateAnsiToWidth(text, width, "…");
}

function padToVisibleWidth(text: string, width: number): string {
	return sharedPadToVisibleWidth(truncateLine(text, width), width, { truncate: false });
}

function matchesAnyKey(data: string, keys: readonly string[]): boolean {
	return keys.some((key) => data === key || (key === "space" && data === " ") || matchesKey(data, key as never));
}

function keyLabel(key: string): string {
	return key
		.replace(/^alt\+/, "alt+")
		.replace("escape", "esc")
		.replace("space", "space");
}

function keyLabels(keys: readonly string[]): string {
	return keys.map(keyLabel).join("/");
}

function taskBoardHelp(bindings: TaskBoardKeybindings): string {
	return [
		`${keyLabel(bindings.toggle)}/${keyLabels(bindings.close.filter((key) => key !== bindings.toggle))} close`,
		`${keyLabels(bindings.up)}/${keyLabels(bindings.down)} move`,
		`${keyLabels(bindings.cycleStatus)} status`,
		`${keyLabels(bindings.assignCurrent)} assign`,
		`${keyLabels(bindings.clearAssignee)} unassign`,
		`${keyLabels(bindings.priorityUp)}/${keyLabels(bindings.priorityDown)} priority`,
		`${keyLabels(bindings.done)} done`,
		`${keyLabels(bindings.cancel)} cancel`,
		`${keyLabels(bindings.delete)} delete`,
		`${keyLabels(bindings.reload)} reload`,
	].join(" · ");
}

function borderLine(theme: Theme, width: number, left: string, fill: string, right: string, title = ""): string {
	const label = title ? ` ${title} ` : "";
	const fillCount = Math.max(0, width - 2 - visibleWidth(label));
	return truncateLine(theme.fg("borderAccent", `${left}${label}${fill.repeat(fillCount)}${right}`), width);
}

function boxedTaskBoard(theme: Theme, width: number, lines: string[]): string[] {
	const safeWidth = Math.max(20, width);
	const innerWidth = Math.max(1, safeWidth - 4);
	return [
		borderLine(theme, safeWidth, "╭", "─", "╮", "Tasks"),
		...lines.map((line) => {
			const inner = padToVisibleWidth(line, innerWidth);
			return truncateLine(`${theme.fg("borderAccent", "│")} ${inner} ${theme.fg("borderAccent", "│")}`, safeWidth);
		}),
		borderLine(theme, safeWidth, "╰", "─", "╯"),
	];
}

function statusColor(task: TaskRecord, blocked = false): ThemeColor {
	if (blocked) return "muted";
	if (isComplete(task)) return "success";
	if (task.status === "in_progress") return "accent";
	if (task.status === "in_review") return "warning";
	if (task.status === "rejected") return "error";
	return "text";
}

function statusIcon(task: TaskRecord, blocked = false, frame = 0): string {
	if (task.status === "in_progress") return spinnerFrames[frame % spinnerFrames.length] ?? "✳";
	if (isComplete(task)) return "✔";
	if (blocked) return "◻";
	return task.status === "in_review" ? "◼" : "◻";
}

function taskPrefix(task: TaskRecord, theme: Theme, prefixes: ReadonlyMap<string, string>): string {
	return theme.fg("dim", displayTaskId(task.id, prefixes));
}

function assignmentLabel(task: TaskRecord): string | undefined {
	return task.assigned_label || task.assigned_to?.replace(/^session:/, "");
}

interface AssignmentDisplayContext {
	currentAssignments?: string[];
	currentLabel?: string;
}

function assignmentDisplayContext(
	pi: ExtensionAPI | undefined,
	ctx: ExtensionContext | undefined,
	_tasks: TaskRecord[],
) {
	return { currentAssignments: sessionAssignmentAliases(ctx), currentLabel: sessionName(pi, ctx) };
}

function isAssignedToCurrentSession(task: TaskRecord, display: AssignmentDisplayContext): boolean {
	return Boolean((display.currentAssignments ?? []).includes(task.assigned_to ?? ""));
}

function formatAssignee(task: TaskRecord, theme: Theme, display: AssignmentDisplayContext): string {
	const label = assignmentLabel(task);
	if (!label) return "";
	const marker = isAssignedToCurrentSession(task, display) ? "@me" : `@${label}`;
	return ` ${theme.fg("mdLink", marker)}`;
}

function strike(theme: Theme, text: string): string {
	return theme.strikethrough?.(text) ?? text;
}

function bold(theme: Theme, text: string): string {
	return theme.bold?.(text) ?? text;
}

function taskLine(
	task: TaskRecord,
	theme: Theme,
	width: number,
	byId: Map<string, TaskRecord>,
	prefixes: ReadonlyMap<string, string>,
	display: AssignmentDisplayContext = {},
	selected = false,
	frame = 0,
	now = Date.now(),
): string {
	const blocked = hasOpenBlockers(task, byId);
	const icon = theme.fg(statusColor(task, blocked), statusIcon(task, blocked, frame));
	const blockers = openBlockers(task, byId).map((id) => displayTaskId(id, prefixes));
	const suffix = blockers.length > 0 ? theme.fg("dim", ` › blocked by ${blockers.join(", ")}`) : "";
	const assignee = formatAssignee(task, theme, display);
	const marker = selected ? "›" : " ";
	let subject = task.title;
	let stats = "";
	if (task.status === "in_progress") {
		subject = `${task.active_form || gerundTitle(task.title)}…`;
		stats = ` ${theme.fg("dim", `(${formatDuration(now - (task.started_at ?? task.updated_at ?? now))})`)}`;
	}
	let text = `${marker} ${icon} ${taskPrefix(task, theme, prefixes)} ${subject}${assignee}${stats}${suffix}`;
	if (isComplete(task))
		text = `${marker} ${icon} ${theme.fg("dim", strike(theme, `${displayTaskId(task.id, prefixes)} ${task.title}`))}`;
	return truncateLine(text, width);
}

function taskBodyDetailLines(body: string, theme: Theme): string[] {
	const trimmed = body.trim();
	if (!trimmed) return [];
	const lines = [theme.fg("dim", "Body:"), ""];
	for (const line of trimmed.split(/\r?\n/)) {
		const clean = line.trimEnd();
		if (!clean.trim()) {
			lines.push("");
		} else if (
			/^#{1,6}\s+\S/.test(clean) ||
			(/^[A-Z][A-Za-z0-9 /-]+:$/.test(clean.trim()) && clean.trim().length <= 80)
		) {
			lines.push(theme.fg("mdHeading", clean.trim().replace(/^#{1,6}\s+/, "")));
		} else if (/^\s*[-*]\s+/.test(clean)) {
			lines.push(`  ${theme.fg("dim", "•")} ${clean.replace(/^\s*[-*]\s+/, "")}`);
		} else {
			lines.push(clean);
		}
	}
	return lines;
}

function detailLines(
	task: TaskRecord,
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	prefixes: ReadonlyMap<string, string>,
): string[] {
	const blocked = tasks
		.filter((candidate) => (candidate.blocked_by ?? []).includes(task.id))
		.map((candidate) => displayTaskId(candidate.id, prefixes));
	const assignee = assignmentLabel(task) ?? "none";
	const raw = [
		theme.fg("toolTitle", bold(theme, `${displayTaskId(task.id, prefixes)} ${task.title}`)),
		"",
		`${theme.fg("dim", "Status:")} ${task.status}   ${theme.fg("dim", "Priority:")} ${priority(task)}   ${theme.fg("dim", "Assignee:")} ${assignee}`,
		`${theme.fg("dim", "Blockers:")} ${(task.blocked_by ?? []).map((id) => displayTaskId(id, prefixes)).join(", ") || "none"}`,
		`${theme.fg("dim", "Parent:")} ${task.parent_id ? displayTaskId(task.parent_id, prefixes) : "none"}`,
		`${theme.fg("dim", "Blocks:")} ${blocked.join(", ") || "none"}`,
		...(task.body.trim() ? ["", ...taskBodyDetailLines(task.body, theme)] : []),
	];
	return raw.flatMap((line) => wrapTextWithAnsi(line, width)).map((line) => truncateLine(line, width));
}

export function renderTaskBoardLines(
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	selection: TaskBoardSelection = { row: 0 },
	bindings: TaskBoardKeybindings = defaultConfig.keybindings,
): string[] {
	const safeWidth = Math.max(20, width);
	const innerWidth = Math.max(1, safeWidth - 4);
	const items = buildTaskBoardItems(tasks);
	const clamped = clampSelection(items, selection);
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const prefixes = minimalTaskIdPrefixes(tasks);
	const lines = [
		truncateLine(`${theme.fg("mdHeading", "Tasks")} ${theme.fg("dim", taskBoardHelp(bindings))}`, innerWidth),
		"",
	];
	if (items.length === 0) {
		lines.push(truncateLine(theme.fg("dim", "No tasks"), innerWidth));
	} else {
		for (let row = 0; row < items.length; row++) {
			const item = items[row]!;
			lines.push(taskLine(item.task, theme, innerWidth, byId, prefixes, {}, row === clamped.row));
		}
	}
	lines.push(
		"",
		truncateLine(theme.fg("borderMuted", "─".repeat(innerWidth)), innerWidth),
		theme.fg("mdHeading", "Details"),
		"",
	);
	const task = selectedTask(items, clamped);
	if (task) lines.push(...detailLines(task, tasks, theme, innerWidth, prefixes));
	else lines.push(truncateLine(theme.fg("dim", "No task selected"), innerWidth));
	return boxedTaskBoard(
		theme,
		safeWidth,
		lines.map((line) => truncateLine(line, innerWidth)),
	);
}

export class TaskBoardOverlay implements Component {
	private tasks: TaskRecord[];
	private boardSelection: TaskBoardSelection = { row: 0 };
	private pendingReload?: Promise<void>;
	private pendingMutation?: Promise<void>;
	private confirmingDeleteId?: string;
	private errorMessage?: string;

	constructor(
		private readonly options: {
			tasks: TaskRecord[];
			theme: Theme;
			keybindings?: TaskBoardKeybindings;
			onClose: () => void;
			onReload: () => Promise<TaskRecord[]>;
			onMutate?: (action: "update" | "delete", params: Record<string, unknown>) => Promise<TaskRecord[]>;
			onEditBody?: (task: TaskRecord) => Promise<TaskRecord[]>;
			onChange?: () => void;
			initialTaskId?: string;
		},
	) {
		this.tasks = options.tasks;
		const items = buildTaskBoardItems(this.tasks);
		this.boardSelection = options.initialTaskId
			? (selectionForTask(items, options.initialTaskId) ?? clampSelection(items, this.boardSelection))
			: clampSelection(items, this.boardSelection);
	}

	selection(): TaskBoardSelection {
		return { ...this.boardSelection };
	}

	waitForIdle(): Promise<void> {
		return this.pendingMutation ?? this.pendingReload ?? Promise.resolve();
	}

	private isBusy(): boolean {
		return Boolean(this.pendingMutation ?? this.pendingReload);
	}

	private setSelection(next: TaskBoardSelection): void {
		this.boardSelection = clampSelection(buildTaskBoardItems(this.tasks), next);
	}

	private preserveSelection(taskId: string | undefined): void {
		const items = buildTaskBoardItems(this.tasks);
		this.boardSelection = taskId
			? (selectionForTask(items, taskId) ?? clampSelection(items, this.boardSelection))
			: clampSelection(items, this.boardSelection);
	}

	private moveRow(delta: number): void {
		this.setSelection({ row: this.boardSelection.row + delta });
	}

	private reload(): void {
		const taskId = this.currentTask()?.id;
		this.errorMessage = undefined;
		this.pendingReload = this.options
			.onReload()
			.then((tasks) => {
				this.tasks = tasks;
				this.preserveSelection(taskId);
			})
			.catch((error) => {
				this.errorMessage = taskBoardErrorMessage("Reload failed", error);
			})
			.finally(() => {
				this.pendingReload = undefined;
				this.options.onChange?.();
			});
	}

	private currentTask(): TaskRecord | undefined {
		return selectedTask(buildTaskBoardItems(this.tasks), this.boardSelection);
	}

	private mutate(action: "update" | "delete", params: Record<string, unknown>): void {
		if (!this.options.onMutate) return;
		const taskId = action === "delete" ? undefined : this.currentTask()?.id;
		this.errorMessage = undefined;
		this.pendingMutation = this.options
			.onMutate(action, params)
			.then((tasks) => {
				this.tasks = tasks;
				this.preserveSelection(taskId);
			})
			.catch((error) => {
				this.errorMessage = taskBoardErrorMessage(`${action === "delete" ? "Delete" : "Update"} failed`, error);
			})
			.finally(() => {
				this.pendingMutation = undefined;
				this.confirmingDeleteId = undefined;
				this.options.onChange?.();
			});
		this.options.onChange?.();
	}

	private updateSelected(params: Record<string, unknown>): void {
		const task = this.currentTask();
		if (!task) return;
		this.mutate("update", { id: task.id, ...params });
	}

	private cycleSelectedStatus(): void {
		const task = this.currentTask();
		if (!task) return;
		const byId = new Map(this.tasks.map((item) => [item.id, item]));
		if (hasOpenBlockers(task, byId)) return;
		this.updateSelected({ status: nextCycledStatus(task) });
	}

	private confirmDeleteSelected(): void {
		const task = this.currentTask();
		if (!task) return;
		this.confirmingDeleteId = task.id;
		this.options.onChange?.();
	}

	private deleteConfirmed(): void {
		if (!this.confirmingDeleteId) return;
		this.mutate("delete", { id: this.confirmingDeleteId });
	}

	handleInput(data: string): void {
		const bindings = this.options.keybindings ?? defaultConfig.keybindings;
		if (this.confirmingDeleteId) {
			if (matchesAnyKey(data, bindings.confirmDelete)) {
				this.deleteConfirmed();
				return;
			}
			if (matchesAnyKey(data, bindings.cancelDelete)) {
				this.confirmingDeleteId = undefined;
				this.options.onChange?.();
				return;
			}
		}
		if (matchesAnyKey(data, bindings.close)) {
			this.options.onClose();
			return;
		}
		if (matchesAnyKey(data, bindings.up)) {
			this.moveRow(-1);
			return;
		}
		if (matchesAnyKey(data, bindings.down)) {
			this.moveRow(1);
			return;
		}
		if (this.isBusy()) return;
		if (data === "e") {
			this.editBody();
			return;
		}
		if (matchesAnyKey(data, bindings.assignCurrent)) {
			this.updateSelected({ assigned_to: "current" });
			return;
		}
		if (matchesAnyKey(data, bindings.clearAssignee)) {
			this.updateSelected({ clear_assignee: true });
			return;
		}
		if (matchesAnyKey(data, bindings.priorityUp)) {
			const task = this.currentTask();
			if (task) this.updateSelected({ priority: priority(task) + 1 });
			return;
		}
		if (matchesAnyKey(data, bindings.priorityDown)) {
			const task = this.currentTask();
			if (task) this.updateSelected({ priority: priority(task) - 1 });
			return;
		}
		if (matchesAnyKey(data, bindings.done)) {
			const task = this.currentTask();
			if (task) this.updateSelected({ status: doneKeyStatus(task) });
			return;
		}
		if (matchesAnyKey(data, bindings.cancel)) {
			this.updateSelected({ status: "canceled" });
			return;
		}
		if (matchesAnyKey(data, bindings.cycleStatus)) {
			this.cycleSelectedStatus();
			return;
		}
		if (matchesAnyKey(data, bindings.delete)) {
			this.confirmDeleteSelected();
			return;
		}
		if (matchesAnyKey(data, bindings.reload)) this.reload();
	}

	private editBody(): void {
		const task = this.currentTask();
		if (!task || !this.options.onEditBody) return;
		this.pendingMutation = this.options
			.onEditBody(task)
			.then((tasks) => {
				this.tasks = tasks;
				this.boardSelection = selectionForTask(buildTaskBoardItems(tasks), task.id) ?? this.boardSelection;
			})
			.catch((error) => {
				this.errorMessage = taskBoardErrorMessage("Edit failed", error);
			})
			.finally(() => {
				this.pendingMutation = undefined;
				this.options.onChange?.();
			});
	}

	render(width: number): string[] {
		const lines = renderTaskBoardLines(
			this.tasks,
			this.options.theme,
			width,
			this.boardSelection,
			this.options.keybindings ?? defaultConfig.keybindings,
		);
		const prefix: string[] = [];
		if (this.confirmingDeleteId) {
			prefix.push(
				truncateLine(this.options.theme.fg("warning", `Confirm delete ${this.confirmingDeleteId}? y/N`), width),
			);
		}
		if (this.errorMessage) prefix.push(truncateLine(this.options.theme.fg("warning", this.errorMessage), width));
		return [...prefix, ...lines];
	}

	invalidate(): void {}
}

function taskBoardErrorMessage(prefix: string, error: unknown): string {
	return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function nextCycledStatus(task: TaskRecord): string {
	if (task.status === "rejected") return "in_progress";
	if (task.status === "in_progress") return "in_review";
	if (task.status === "in_review") return "open";
	return "in_progress";
}

function doneKeyStatus(task: TaskRecord): string {
	return isStoryTaskType(task.type) ? "in_review" : "done";
}

function taskGuardHudLine(theme: Theme, width: number): string {
	return truncateLine(`${theme.fg("accent", "󰌾")} ${theme.fg("warning", "Task guard on")}`, width);
}

function taskHudSummary(tasks: TaskRecord[]): string[] {
	const visible = tasks.filter((task) => !isCanceled(task));
	const done = visible.filter(isComplete).length;
	const inProgress = visible.filter((task) => task.status === "in_progress").length;
	const inReview = visible.filter((task) => task.status === "in_review").length;
	const open = visible.length - done - inProgress - inReview;
	const parts: string[] = [];
	if (done > 0) parts.push(`${done} done`);
	if (inProgress > 0) parts.push(`${inProgress} in progress`);
	if (inReview > 0) parts.push(`${inReview} in review`);
	if (open > 0) parts.push(`${open} open`);
	return parts;
}

export function renderHudLines(
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	maxTasks = 10,
	display: AssignmentDisplayContext = {},
	options: {
		compact?: boolean;
		frame?: number;
		now?: number;
		taskGuardEnabled?: boolean;
	} = {},
): string[] {
	const now = options.now ?? Date.now();
	const guardLines = options.taskGuardEnabled ? [taskGuardHudLine(theme, width)] : [];
	const visibleTasks = tasks.filter((task) => !isCanceled(task));
	if (visibleTasks.length === 0) return guardLines;
	const parts = taskHudSummary(visibleTasks);
	const summaryLine = truncateLine(
		`${theme.fg("accent", "●")} ${theme.fg("accent", `${visibleTasks.length} tasks`)} ${theme.fg("muted", `(${parts.join(", ")})`)}`,
		width,
	);
	if (options.compact) return [...guardLines, summaryLine];
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const prefixes = minimalTaskIdPrefixes(tasks);
	const lines = [summaryLine];
	const sorted = buildTaskBoardItems(visibleTasks).map((item) => item.task);
	for (const task of sorted.slice(0, maxTasks)) {
		lines.push(taskLine(task, theme, width, byId, prefixes, display, false, options.frame ?? 0, now));
	}
	const hidden = sorted.length - Math.min(sorted.length, maxTasks);
	if (hidden > 0) lines.push(truncateLine(theme.fg("dim", `    … and ${hidden} more`), width));
	return [...guardLines, ...lines].map((line) => truncateLine(line, width));
}

const emptyTaskRender = new EmptyComponent();
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
		clear_assignee: params.clear_assignee === true || clear.has("assignee"),
		clear_parent: params.clear_parent === true || clear.has("parent"),
		clear_blockers: params.clear_blockers === true || clear.has("blockers"),
	};
}

function taskResultTask(result: unknown): TaskRecord | undefined {
	const task = (result as { details?: { task?: unknown } } | undefined)?.details?.task;
	return task && typeof task === "object" ? (task as TaskRecord) : undefined;
}

function taskWriteMayInvalidateQueuedGuard(action: TaskCommand, result: unknown): boolean {
	if (action === "delete") return true;
	const task = taskResultTask(result);
	return Boolean(task && (isTerminalStatus(task.status) || isCanceled(task)));
}

function clearQueuedMessages(ctx: ExtensionContext | undefined): void {
	if (!ctx) return;
	const maybeClear = (ctx as ExtensionContext & { clearQueue?: () => void }).clearQueue;
	if (typeof maybeClear === "function") {
		maybeClear.call(ctx);
		return;
	}
	try {
		if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) ctx.abort?.();
	} catch {
		// Queue clearing is best-effort; task writes must still succeed.
	}
}

function makeCombinedTaskTool(
	resolveAction: (params: Record<string, unknown>) => TaskCommand,
	config: Config,
	pi: ExtensionAPI,
	getCwd: () => string,
	onProgress?: (ctx: ExtensionContext | undefined, action: TaskCommand, result: unknown) => void,
) {
	return {
		renderShell: "self" as const,
		renderCall() {
			return emptyTaskRender;
		},
		renderResult() {
			return emptyTaskRender;
		},
		execute: async (
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			ctx?: ExtensionContext,
		) => {
			const action = resolveAction(params);
			const result = executeTask(getCwd(), action, params, pi, ctx);
			if (action !== "list" && action !== "show") {
				onProgress?.(ctx, action, result);
				if (ctx && config.hud.enabled) await updateTaskHud(ctx, pi, config).catch(() => {});
			}
			return result;
		},
	};
}

function installSilentTaskToolRenderPatch(): void {
	const prototype = ToolExecutionComponent.prototype as typeof ToolExecutionComponent.prototype & {
		[silentTaskToolPatchKey]?: boolean;
		render(width: number): string[];
	};
	if (prototype[silentTaskToolPatchKey]) return;
	const originalRender = prototype.render;
	prototype.render = function renderSilentTaskTool(width: number): string[] {
		if (silentTaskToolNames.has((this as unknown as { toolName?: string }).toolName ?? "")) return [];
		return originalRender.call(this, width);
	};
	prototype[silentTaskToolPatchKey] = true;
}

const maxGuardNudgesWithoutTools = 2;

interface TaskGuardDecision {
	task: TaskRecord;
	content: string;
	reviewKey?: string;
}

function isAssignedTo(assignments: readonly string[], task: TaskRecord): boolean {
	return assignments.includes(task.assigned_to ?? "");
}

function sortedGuardTasks(tasks: TaskRecord[]): TaskRecord[] {
	return [...tasks].sort(compareTasks);
}

function assignedSessionTasks(tasks: TaskRecord[], assignedTo: readonly string[]): TaskRecord[] {
	return sortedGuardTasks(tasks.filter((task) => isActiveTask(task) && isAssignedTo(assignedTo, task)));
}

function guardInstruction(task: TaskRecord, prefixes: ReadonlyMap<string, string> = new Map()): string {
	if (task.status === "in_progress")
		return `Continue in-progress task ${displayTaskId(task.id, prefixes)}: ${task.title}`;
	return `Continue assigned task ${displayTaskId(task.id, prefixes)} [${task.status}]: ${task.title}`;
}

function reviewGuardContent(task: TaskRecord, prefixes: ReadonlyMap<string, string>): string {
	return [
		"Review clarification needed: this session has a task in review.",
		"",
		`Suggested next step: Ask what needs to be reviewed and how for task ${displayTaskId(task.id, prefixes)}: ${task.title}`,
		"",
		"Clarify the review scope, expected evidence, and approval path before doing more implementation work.",
	].join("\n");
}

function guardContent(task: TaskRecord, prefixes: ReadonlyMap<string, string>): string {
	return [
		"Task nudge: this session has assigned task work.",
		"",
		`Suggested next step: ${guardInstruction(task, prefixes)}`,
	].join("\n");
}

function reviewNudgeKey(task: TaskRecord): string {
	return `${task.id}:${task.status}:${task.updated_at}`;
}

function isTaskGuardMessage(message: { customType?: unknown; details?: unknown } | undefined): boolean {
	return message?.customType === "task-guard";
}

function isTaskGuardInputText(text: unknown): text is string {
	return (
		typeof text === "string" &&
		(text.startsWith("Task nudge: this session has assigned task work.") ||
			text.startsWith("Review clarification needed: this session has a task in review."))
	);
}
function taskGuardMessageText(message: { content?: unknown } | undefined): string | undefined {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
			return undefined;
		})
		.filter((part): part is string => part !== undefined)
		.join("\n");
	return text || undefined;
}

function hiddenStaleTaskGuardMessage<T extends { content?: unknown; display?: boolean; details?: unknown }>(
	message: T,
): T {
	const details = message.details && typeof message.details === "object" ? message.details : {};
	return {
		...message,
		content: [{ type: "text", text: "Task guard skipped because the referenced task is no longer active." }],
		display: false,
		details: { ...details, stale: true },
	};
}

async function shouldHandleStaleTaskGuardMessage(
	message: { content?: unknown },
	state: GuardState,
	ctx: ExtensionContext,
): Promise<boolean> {
	const text = taskGuardMessageText(message);
	return isTaskGuardInputText(text) && shouldHandleStaleTaskGuardInput(text, state, ctx);
}

async function shouldHandleStaleTaskGuardInput(
	text: string,
	state: GuardState,
	ctx: ExtensionContext,
): Promise<boolean> {
	if (!state.enabled) return true;
	const decision = await evaluateTaskGuard(ctx);
	return !decision || decision.content !== text;
}

async function evaluateTaskGuard(ctx: ExtensionContext): Promise<TaskGuardDecision | undefined> {
	const assignedTo = sessionAssignmentAliases(ctx);
	if (assignedTo.length === 0) return undefined;
	const tasks = await loadHudTasks(ctx.cwd);
	const task = assignedSessionTasks(tasks, assignedTo)[0];
	if (!task) return undefined;
	if (task.status === "in_review")
		return { task, content: reviewGuardContent(task, minimalTaskIdPrefixes(tasks)), reviewKey: reviewNudgeKey(task) };
	return { task, content: guardContent(task, minimalTaskIdPrefixes(tasks)) };
}

function sendTaskGuard(
	pi: ExtensionAPI,
	state: GuardState,
	decision: TaskGuardDecision,
	usedToolsThisTurn: boolean,
): boolean {
	if (!state.enabled) return false;
	if (!usedToolsThisTurn && state.noToolNudges >= maxGuardNudgesWithoutTools) return false;
	if (decision.reviewKey && state.reviewNudgeKeys.has(decision.reviewKey)) return false;
	pi.sendMessage(
		{
			customType: "task-guard",
			content: [{ type: "text", text: decision.content }],
			display: true,
			details: { taskId: decision.task.id },
		},
		undefined,
	);
	if (decision.reviewKey) state.reviewNudgeKeys.add(decision.reviewKey);
	state.noToolNudges = usedToolsThisTurn ? 0 : state.noToolNudges + 1;
	return true;
}
function canSendTaskGuardNow(ctx: ExtensionContext): boolean {
	try {
		return typeof ctx.isIdle !== "function" || ctx.isIdle();
	} catch {
		return true;
	}
}

function scheduleTaskGuardWhenIdle(
	pi: ExtensionAPI,
	state: GuardState,
	ctx: ExtensionContext,
	usedToolsThisTurn: boolean,
	setPendingTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void,
): void {
	const run = async () => {
		if (!canSendTaskGuardNow(ctx)) {
			setPendingTimer(setTimeout(run, 10));
			return;
		}
		setPendingTimer(undefined);
		try {
			const decision = state.enabled ? await evaluateTaskGuard(ctx) : undefined;
			if (decision) sendTaskGuard(pi, state, decision, usedToolsThisTurn);
		} catch (error) {
			ctx.ui.notify?.(`Task guard failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};
	setPendingTimer(setTimeout(run, 0));
}

function setTaskGuardEnabled(state: GuardState, enabled: boolean): void {
	state.enabled = enabled;
	state.toolsUsedThisTurn = false;
	state.noToolNudges = 0;
	state.reviewNudgeKeys.clear();
	if (latestTaskHudState) {
		latestTaskHudState = { ...latestTaskHudState, taskGuardEnabled: enabled };
		taskHudWidget?.setState(latestTaskHudState);
		requestTaskHudRender?.();
	}
}

function taskGuardCommandMessage(state: GuardState, args: string): { message: string; type: "info" | "warning" } {
	const mode = args.trim().toLowerCase();
	if (!mode || mode === "status") {
		return {
			message: `Task guard is ${state.enabled ? "enabled" : "disabled"} for this session. Use /task-guard [on/off] to change it.`,
			type: "info",
		};
	}
	if (mode === "on") {
		setTaskGuardEnabled(state, true);
		return { message: "Task guard enabled for this session.", type: "info" };
	}
	if (mode === "off") {
		setTaskGuardEnabled(state, false);
		return { message: "Task guard disabled for this session.", type: "info" };
	}
	return { message: "Usage: /task-guard [on|off|status]", type: "warning" };
}

function taskGuardPreferencePath(cwd: string): string {
	return join(cwd, ".pi", "tasks", "task-guard.json");
}

function readTaskGuardPreference(ctx: ExtensionContext): boolean | undefined {
	try {
		const parsed = JSON.parse(readFileSync(taskGuardPreferencePath(ctx.cwd), "utf8")) as { enabled?: unknown };
		return typeof parsed.enabled === "boolean" ? parsed.enabled : undefined;
	} catch {
		return undefined;
	}
}

function writeTaskGuardPreference(ctx: ExtensionContext, enabled: boolean): void {
	const tasksDir = join(ctx.cwd, ".pi", "tasks");
	mkdirSync(tasksDir, { recursive: true });
	const path = taskGuardPreferencePath(ctx.cwd);
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, JSON.stringify({ enabled }, null, 2));
	renameSync(tmpPath, path);
}

export default function tasksExtension(pi: ExtensionAPI, _runtime: Runtime = {}) {
	const config = loadConfig();
	if (!config.enabled) return;
	installSilentTaskToolRenderPatch();
	activeTaskBoard = undefined;
	taskHudWidget = undefined;
	taskHudWidgetCtx = undefined;
	latestTaskHudState = undefined;
	requestTaskHudRender = undefined;
	taskHudExpanded = true;

	let cwd = process.cwd();
	const guardState: GuardState = {
		enabled: false,
		toolsUsedThisTurn: false,
		noToolNudges: 0,
		reviewNudgeKeys: new Set(),
	};
	const getCwd = () => cwd;
	let pendingTaskGuardTimer: ReturnType<typeof setTimeout> | undefined;
	const setPendingTaskGuardTimer = (timer: ReturnType<typeof setTimeout> | undefined) => {
		pendingTaskGuardTimer = timer;
	};
	const markToolUsed = (ctx: ExtensionContext | undefined, action: TaskCommand, result: unknown) => {
		guardState.toolsUsedThisTurn = true;
		if (pendingTaskGuardTimer) clearTimeout(pendingTaskGuardTimer);
		pendingTaskGuardTimer = undefined;
		if (taskWriteMayInvalidateQueuedGuard(action, result)) clearQueuedMessages(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		setTaskGuardEnabled(guardState, readTaskGuardPreference(ctx) ?? false);
		if (config.hud.enabled) {
			await updateTaskHud(ctx, pi, config, guardState.enabled).catch((error) => {
				ctx.ui.notify?.(
					`Task HUD refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		}
	});

	pi.on("session_shutdown", async () => {
		if (pendingTaskGuardTimer) clearTimeout(pendingTaskGuardTimer);
		pendingTaskGuardTimer = undefined;
		if (taskHudPulseTimer) clearInterval(taskHudPulseTimer);
		taskHudPulseTimer = undefined;
		taskHudWidget = undefined;
		taskHudWidgetCtx = undefined;
		latestTaskHudState = undefined;
		requestTaskHudRender = undefined;
	});

	pi.on("tool_execution_end", () => {
		guardState.toolsUsedThisTurn = true;
	});

	(pi as unknown as { on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void }).on(
		"message_end",
		async (event, ctx) => {
			const message = (
				event as { message?: { content?: unknown; customType?: unknown; details?: unknown; role?: string } }
			).message;
			if (
				message &&
				isTaskGuardMessage(message) &&
				(await shouldHandleStaleTaskGuardMessage(message, guardState, ctx))
			) {
				return { message: hiddenStaleTaskGuardMessage(message) };
			}
			if (message?.role === "user" && !isTaskGuardMessage(message)) {
				guardState.noToolNudges = 0;
				guardState.toolsUsedThisTurn = false;
			}
			return undefined;
		},
	);

	(pi as unknown as { on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void }).on(
		"message_start",
		async (event, ctx) => {
			const message = (event as { message?: { content?: unknown; customType?: unknown; details?: unknown } })
				.message;
			if (!message || !isTaskGuardMessage(message)) return undefined;
			if (await shouldHandleStaleTaskGuardMessage(message, guardState, ctx)) ctx.abort?.();
			return undefined;
		},
	);

	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension" || !isTaskGuardInputText(event.text)) return undefined;
		if (await shouldHandleStaleTaskGuardInput(event.text, guardState, ctx)) return { action: "handled" as const };
		return { action: "continue" as const };
	});

	const hasQueuedMessages = (ctx: ExtensionContext) => {
		try {
			return typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages();
		} catch {
			return false;
		}
	};

	pi.on("turn_end", async (_event, ctx) => {
		const usedToolsThisTurn = guardState.toolsUsedThisTurn;
		guardState.toolsUsedThisTurn = false;
		if (hasQueuedMessages(ctx)) return;
		if (pendingTaskGuardTimer) clearTimeout(pendingTaskGuardTimer);
		if (!canSendTaskGuardNow(ctx)) {
			scheduleTaskGuardWhenIdle(pi, guardState, ctx, usedToolsThisTurn, setPendingTaskGuardTimer);
			return;
		}
		try {
			const decision = guardState.enabled ? await evaluateTaskGuard(ctx) : undefined;
			if (decision) sendTaskGuard(pi, guardState, decision, usedToolsThisTurn);
		} catch (error) {
			ctx.ui.notify?.(`Task guard failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.registerCommand?.("tasks", {
		description: "Open project task list; pass a task id to focus it",
		handler: async (args: string, ctx: ExtensionContext) => {
			const initialTaskId = args.trim().split(/\s+/).filter(Boolean)[0];
			await showTaskBoard(ctx, pi, config, initialTaskId).catch((error) => {
				ctx.ui.notify?.(`Task board failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
		},
	});

	pi.registerCommand?.("task-guard", {
		description: "Show task guard status; use [on/off] to change it",
		handler: async (args: string, ctx: ExtensionContext) => {
			const result = taskGuardCommandMessage(guardState, args);
			const mode = args.trim().toLowerCase();
			if (mode === "on" || mode === "off") {
				try {
					writeTaskGuardPreference(ctx, guardState.enabled);
				} catch (error) {
					ctx.ui.notify?.(
						`Task guard preference save failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
			}
			ctx.ui.notify?.(result.message, result.type);
		},
	});

	pi.registerShortcut?.(config.hud.toggleShortcut as never, {
		description: "Toggle project task HUD summary/list view",
		handler: async (ctx: ExtensionContext) => {
			taskHudExpanded = !taskHudExpanded;
			const tasks =
				(taskHudWidgetCtx === ctx ? latestTaskHudState?.tasks : undefined) ?? (await loadHudTasks(ctx.cwd));
			await updateTaskHud(ctx, pi, config, undefined, tasks).catch((error) => {
				ctx.ui.notify?.(
					`Task HUD refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		},
	});

	pi.registerTool({
		...makeCombinedTaskTool(taskReadAction, config, pi, getCwd, markToolUsed),
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
			assigned_to: Type.Optional(Type.String({ description: "List filter, or 'current'" })),
			all: Type.Optional(Type.Boolean({ description: "Include completed/canceled tasks" })),
		}),
	});

	pi.registerTool({
		...makeCombinedTaskTool(taskWriteAction, config, pi, getCwd, markToolUsed),
		name: "task_write",
		label: "Write Tasks",
		description:
			"Add/update/delete tasks. Put fields in data: type, body, status, priority, assigned_to ('current' ok), active_form, labels, parent_id, blocked_by. Use clear for assignee/parent/blockers. There are no accept/reject commands: after user approval in normal mode, agents complete accepted feature/bug tasks with status=done and user_approved_completion=true; in auto mode use auto_verified_completion=true when automated evidence proves acceptance.",
		promptSnippet: "Write project tasks",
		parameters: Type.Object({
			op: Type.String({ description: "add, update, or delete" }),
			id: Type.Optional(Type.String({ description: "Task ID/prefix; required except add" })),
			title: Type.Optional(Type.String({ description: "Add title shorthand" })),
			data: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "Add/update fields, e.g. status/priority/assigned_to/labels/blocked_by/active_form",
				}),
			),
			clear: Type.Optional(Type.Array(Type.String(), { description: "assignee, parent, blockers" })),
			user_approved_completion: Type.Optional(
				Type.Boolean({ description: "Set true only after the user approves completion in non-auto mode." }),
			),
			auto_verified_completion: Type.Optional(
				Type.Boolean({ description: "Set true in auto mode only when automated evidence proves completion." }),
			),
		}),
	});
}
