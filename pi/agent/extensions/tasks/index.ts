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
	progressSerial: number;
	lastGuardFingerprint?: string;
	lastGuardProgressSerial?: number;
	autoLoopTaskId?: string;
	autoLoopTurns: number;
	pending?: TaskGuardDecision;
	pauseResponses: number;
	lastUserText?: string;
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
const maxGuardAutoTurnsWithoutProgress = 2;
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
			filters.assigned_to === "current" ? sessionAssignment(ctx) : stringValue(filters.assigned_to);
		return this.listRaw().filter((task) => {
			if (filters.all !== true && isCanceled(task)) return false;
			if (typeof filters.status === "string" && task.status !== filters.status) return false;
			if (typeof filters.type === "string" && task.type !== filters.type) return false;
			if (typeof filters.label === "string" && !(task.labels ?? []).includes(filters.label)) return false;
			if (assignedFilter && task.assigned_to !== assignedFilter) return false;
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
	if (typeof file === "string" && file.length > 0)
		return `session:${file
			.split("/")
			.at(-1)
			?.replace(/\.jsonl$/, "")}`;
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

function isReadyForWork(task: TaskRecord, byId: Map<string, TaskRecord>): boolean {
	return (
		isActiveTask(task) && task.status !== "in_progress" && task.status !== "in_review" && !hasOpenBlockers(task, byId)
	);
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
	currentAssignment?: string;
	currentLabel?: string;
}

function assignmentDisplayContext(
	pi: ExtensionAPI | undefined,
	ctx: ExtensionContext | undefined,
	_tasks: TaskRecord[],
) {
	return { currentAssignment: sessionAssignment(ctx), currentLabel: sessionName(pi, ctx) };
}

function isAssignedToCurrentSession(task: TaskRecord, display: AssignmentDisplayContext): boolean {
	return Boolean(display.currentAssignment && task.assigned_to === display.currentAssignment);
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

function makeCombinedTaskTool(
	resolveAction: (params: Record<string, unknown>) => TaskCommand,
	config: Config,
	pi: ExtensionAPI,
	getCwd: () => string,
	onProgress?: () => void,
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
				onProgress?.();
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

type TaskGuardActionKind = "continue" | "revise" | "start" | "claim" | "fix_dependency";

interface TaskGuardAction {
	kind: TaskGuardActionKind;
	task: TaskRecord;
	source?: TaskRecord;
	invalidBlocker?: string;
}

interface TaskGuardDecision {
	kind: "continue";
	fingerprint: string;
	action: TaskGuardAction;
	content: string;
}

function unresolvedBlockers(task: TaskRecord, byId: Map<string, TaskRecord>): Array<TaskRecord | string> {
	const blockers: Array<TaskRecord | string> = [];
	for (const id of task.blocked_by ?? []) {
		const blocker = byId.get(id);
		if (!blocker) blockers.push(id);
		else if (!isComplete(blocker)) blockers.push(blocker);
	}
	return blockers;
}

function selectDependencyAction(
	task: TaskRecord,
	assignedTo: string,
	byId: Map<string, TaskRecord>,
	seen = new Set<string>(),
): TaskGuardAction | undefined {
	if (!seen.add(task.id)) return undefined;
	for (const dependency of unresolvedBlockers(task, byId)) {
		if (typeof dependency === "string") return { kind: "fix_dependency", task, invalidBlocker: dependency };
		if (isAssignedTo(assignedTo, dependency)) {
			if (dependency.status === "in_progress") return { kind: "continue", task: dependency, source: task };
			const nested = selectDependencyAction(dependency, assignedTo, byId, seen);
			if (nested) return nested;
			if (isReadyForWork(dependency, byId)) return { kind: "start", task: dependency, source: task };
		}
		if (isUnassigned(dependency) && isReadyForWork(dependency, byId))
			return { kind: "claim", task: dependency, source: task };
	}
	return undefined;
}

function isAssignedTo(assignment: string, task: TaskRecord): boolean {
	return task.assigned_to === assignment;
}

function isUnassigned(task: TaskRecord): boolean {
	return !task.assigned_to;
}

function sortedGuardTasks(tasks: TaskRecord[]): TaskRecord[] {
	return [...tasks].sort(compareTasks);
}

function selectGuardAction(tasks: TaskRecord[], assignedTo: string): TaskGuardAction | undefined {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const assigned = sortedGuardTasks(tasks.filter((task) => isAssignedTo(assignedTo, task) && isActiveTask(task)));
	for (const task of assigned) {
		const action = selectDependencyAction(task, assignedTo, byId);
		if (action) return action;
	}
	const inProgress = assigned.find((task) => task.status === "in_progress" && !hasOpenBlockers(task, byId));
	if (inProgress) return { kind: "continue", task: inProgress };
	const rejected = assigned.find((task) => task.status === "rejected" && !hasOpenBlockers(task, byId));
	if (rejected) return { kind: "revise", task: rejected };
	const assignedReady = assigned.find((task) => isReadyForWork(task, byId));
	if (assignedReady) return { kind: "start", task: assignedReady };
	const unassignedReady = sortedGuardTasks(
		tasks.filter((task) => isUnassigned(task) && isReadyForWork(task, byId)),
	)[0];
	if (unassignedReady) return { kind: "claim", task: unassignedReady };
	return undefined;
}

function guardFingerprint(tasks: TaskRecord[], action: TaskGuardAction, assignedTo: string): string {
	const activeAssigned = tasks
		.filter((task) => isActiveTask(task) && task.assigned_to === assignedTo)
		.map((task) => `${task.id}:${task.status}:${task.updated_at}:${(task.blocked_by ?? []).join(",")}`)
		.sort()
		.join("|");
	return `${action.kind}:${action.task.id}:${action.invalidBlocker ?? ""}:${activeAssigned}`;
}

function guardInstruction(action: TaskGuardAction, prefixes: ReadonlyMap<string, string> = new Map()): string {
	const source = action.source ? ` to unblock ${displayTaskId(action.source.id, prefixes)}` : "";
	switch (action.kind) {
		case "continue":
			return `Continue in-progress task ${displayTaskId(action.task.id, prefixes)}${source}: ${action.task.title}`;
		case "revise":
			return `Revise rejected task ${displayTaskId(action.task.id, prefixes)}${source}: ${action.task.title}.`;
		case "start":
			return `Start assigned task ${displayTaskId(action.task.id, prefixes)}${source}: ${action.task.title}.`;
		case "claim":
			return `Claim task ${displayTaskId(action.task.id, prefixes)}${source}: ${action.task.title}.`;
		case "fix_dependency":
			return `Fix invalid blocker ${displayTaskId(action.invalidBlocker ?? "", prefixes)} on task ${displayTaskId(action.task.id, prefixes)}: update blocked_by or choose a replacement blocker.`;
	}
}

function guardContent(action: TaskGuardAction, prefixes: ReadonlyMap<string, string>): string {
	return [
		"Task nudge: this session has a ready next step.",
		"",
		`Suggested next step: ${guardInstruction(action, prefixes)}`,
		"",
		"Continue with tools when this matches the user's direction; otherwise switch tasks or dismiss this nudge.",
	].join("\n");
}

function userTextAllowsGuardAutoTurn(text: string | undefined): boolean {
	if (!text) return true;
	if (pausesGuard(text)) return false;
	if (/\btask[- ]guard\b|\bguard\b/i.test(text)) return false;
	if (/[?]\s*$/.test(text)) return false;
	if (/^\s*(why|what|when|where|who|how|do|does|did|can|could|should|would|is|are)\b/i.test(text)) return false;
	return /\b(assign|assigned|implement|continue|start|work|proceed|resume|finish|complete|done|fix|try|test|demo)\b/i.test(
		text,
	);
}

function shouldTriggerGuardTurn(state: GuardState, decision: TaskGuardDecision): boolean {
	if (!userTextAllowsGuardAutoTurn(state.lastUserText)) return false;
	if (decision.action.kind !== "continue" && decision.action.kind !== "revise") return false;
	if (state.autoLoopTaskId !== decision.action.task.id || state.lastGuardProgressSerial !== state.progressSerial) {
		state.autoLoopTaskId = decision.action.task.id;
		state.autoLoopTurns = 0;
	}
	if (state.autoLoopTurns >= maxGuardAutoTurnsWithoutProgress) return false;
	state.autoLoopTurns++;
	return true;
}

async function evaluateTaskGuard(ctx: ExtensionContext, state: GuardState): Promise<TaskGuardDecision | undefined> {
	const assignedTo = sessionAssignment(ctx);
	if (!assignedTo) return undefined;
	const tasks = await loadHudTasks(ctx.cwd);
	const action = selectGuardAction(tasks, assignedTo);
	if (!action) {
		state.lastGuardFingerprint = undefined;
		state.lastGuardProgressSerial = undefined;
		return undefined;
	}
	const fingerprint = guardFingerprint(tasks, action, assignedTo);
	return { kind: "continue", fingerprint, action, content: guardContent(action, minimalTaskIdPrefixes(tasks)) };
}

async function sendTaskGuard(pi: ExtensionAPI, state: GuardState, force = false): Promise<boolean> {
	const pending = state.pending;
	state.pending = undefined;
	if (!pending || (!state.enabled && !force)) return false;
	if (!userTextAllowsGuardAutoTurn(state.lastUserText)) {
		state.lastUserText = undefined;
		return false;
	}
	const triggerTurn = force ? true : shouldTriggerGuardTurn(state, pending);
	state.lastGuardFingerprint = pending.fingerprint;
	state.lastGuardProgressSerial = state.progressSerial;
	pi.sendMessage(
		{
			customType: "task-guard",
			content: [{ type: "text", text: pending.content }],
			display: true,
			details: { action: pending.action.kind, taskId: pending.action.task.id },
		},
		triggerTurn ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "followUp" },
	);
	state.lastUserText = undefined;
	return triggerTurn;
}

function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (item && typeof item === "object" && "text" in item ? String(item.text ?? "") : ""))
		.join("");
}

function messageHasToolCall(message: { content?: unknown }): boolean {
	return (
		Array.isArray(message.content) &&
		message.content.some(
			(item) => item && typeof item === "object" && (item as { type?: string }).type === "toolCall",
		)
	);
}

function pausesGuard(text: string): boolean {
	return /\b(pause|stop|hold|disable)\s+(the\s+)?task guard\b|\btask guard\s+(pause|stop|off|disable)\b/i.test(text);
}

function setTaskGuardEnabled(state: GuardState, enabled: boolean): void {
	state.enabled = enabled;
	state.pending = undefined;
	state.lastUserText = undefined;
	state.autoLoopTaskId = undefined;
	state.autoLoopTurns = 0;
	if (!enabled) state.pauseResponses = 0;
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

function fileChangingResult(result: unknown): boolean {
	const details = (result as { details?: { filesChanged?: unknown; fileDiffs?: unknown } } | undefined)?.details;
	return (
		(typeof details?.filesChanged === "number" && details.filesChanged > 0) ||
		(Array.isArray(details?.fileDiffs) && details.fileDiffs.length > 0)
	);
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
	const guardState: GuardState = { enabled: false, progressSerial: 0, autoLoopTurns: 0, pauseResponses: 0 };
	const getCwd = () => cwd;
	const markProgress = () => {
		guardState.progressSerial++;
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
		if (taskHudPulseTimer) clearInterval(taskHudPulseTimer);
		taskHudPulseTimer = undefined;
		taskHudWidget = undefined;
		taskHudWidgetCtx = undefined;
		latestTaskHudState = undefined;
		requestTaskHudRender = undefined;
	});

	pi.on("tool_execution_end", (event) => {
		if (fileChangingResult((event as { result?: unknown }).result)) markProgress();
	});

	pi.on("message_end", async (event, ctx) => {
		const message = (event as { message?: { role?: string; content?: unknown } }).message;
		if (message?.role === "user") {
			const text = messageText(message);
			guardState.lastUserText = text;
			if (pausesGuard(text)) guardState.pauseResponses = 1;
			return undefined;
		}
		if (
			!guardState.enabled ||
			message?.role !== "assistant" ||
			messageHasToolCall(message) ||
			!messageText(message).trim()
		) {
			return undefined;
		}
		if (guardState.pauseResponses > 0) {
			guardState.pauseResponses--;
			guardState.pending = undefined;
			return undefined;
		}
		try {
			guardState.pending = await evaluateTaskGuard(ctx, guardState);
		} catch (error) {
			guardState.pending = undefined;
			ctx.ui.notify?.(`Task guard failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		return undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		await sendTaskGuard(pi, guardState).catch((error) => {
			ctx.ui.notify?.(`Task guard failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
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
		...makeCombinedTaskTool(taskReadAction, config, pi, getCwd, markProgress),
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
		...makeCombinedTaskTool(taskWriteAction, config, pi, getCwd, markProgress),
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
