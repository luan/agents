import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	truncateToWidth as truncateAnsiToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { hasEnoughTerminalRows } from "../shared/terminal";
import {
	type AnimationMount,
	type AnimationRenderTarget,
	defineExtensionTui,
	EmptyComponent,
	setOrderedAboveEditorWidget,
	sharedAnimationRenderScheduler,
	padToVisibleWidth as sharedPadToVisibleWidth,
} from "../shared/tui";
import { framedBlock, renderStatusLine, textComponent } from "../shared/tui/card";

export type TaskCommand = "add" | "list" | "show" | "update" | "delete";

export interface TaskRecord {
	id: string;
	title: string;
	body: string;
	status: string;
	type?: string;
	labels?: string[];
	priority?: number;
	parent_id?: string | null;
	blocked_by?: string[];
	active_form?: string | null;
	started_at?: number | null;
	completed_at?: number | null;
	created_at: number;
	updated_at: number;
}

export interface TaskBoardKeybindings {
	toggle: string;
	close: string[];
	up: string[];
	down: string[];
	cycleStatus: string[];
	priorityUp: string[];
	priorityDown: string[];
	done: string[];
	cancel: string[];
	delete: string[];
	reload: string[];
	confirmDelete: string[];
	cancelDelete: string[];
}

export interface TasksPresentationConfig {
	hud: {
		enabled: boolean;
		maxTasks: number;
		minTerminalRows: number;
		toggleShortcut: string;
	};
	keybindings: TaskBoardKeybindings;
}

export interface TaskDetails {
	action: TaskCommand;
	args: string[];
	task?: TaskRecord;
	tasks?: TaskRecord[];
	deleted?: string;
}

interface Theme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	strikethrough?(text: string): string;
}

export interface TaskReminderDetails {
	tasks: Array<{ id: string; title: string; status: string; blocked_by?: string[] }>;
	attempts: number;
	maxAttempts: number;
}

const tasksTui = defineExtensionTui({ id: "tasks" });
const widgetId = "project-tasks";
const taskHudPulseFrameMs = 160;
const spinnerFrames = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
let activeTaskBoard: { close: () => void } | undefined;
const TASK_HUD_EXPANDED_STATES_KEY = Symbol.for("pi.tasks.hud.expanded.bySession");
type TaskHudExpandedGlobal = typeof globalThis & {
	[TASK_HUD_EXPANDED_STATES_KEY]?: Map<string, boolean>;
};
const taskHudExpandedGlobal = globalThis as TaskHudExpandedGlobal;
if (!(taskHudExpandedGlobal[TASK_HUD_EXPANDED_STATES_KEY] instanceof Map)) {
	taskHudExpandedGlobal[TASK_HUD_EXPANDED_STATES_KEY] = new Map();
}
const taskHudExpandedStates = taskHudExpandedGlobal[TASK_HUD_EXPANDED_STATES_KEY];

function taskHudExpandedForSession(sessionId: string): boolean {
	const expanded = taskHudExpandedStates.get(sessionId);
	if (expanded !== undefined) return expanded;
	taskHudExpandedStates.set(sessionId, true);
	return true;
}

let taskHudPulseTimer: AnimationMount | undefined;
let taskHudAnimationTarget: AnimationRenderTarget | undefined;
let taskHudWidget: TaskHudWidget | undefined;
let taskHudWidgetCtx: ExtensionContext | undefined;
let latestTaskHudState: TaskHudState | undefined;
let taskHudFrame = 0;

interface TaskHudState {
	tasks: TaskRecord[];
	config: TasksPresentationConfig;
	expanded: boolean;
}

const defaultTaskBoardKeybindings: TaskBoardKeybindings = {
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
};

export function isComplete(task: TaskRecord): boolean {
	return task.status === "done" || task.status === "completed";
}

export function isCanceled(task: TaskRecord): boolean {
	return task.status === "canceled";
}
export function minimalTaskIdPrefixes(tasks: readonly { id: string }[]): Map<string, string> {
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

export function displayTaskId(id: string, prefixes: ReadonlyMap<string, string>): string {
	return prefixes.get(id) ?? id;
}

export function compareTasks(left: TaskRecord, right: TaskRecord): number {
	return (
		taskStatusRank(left) - taskStatusRank(right) ||
		priority(right) - priority(left) ||
		left.id.localeCompare(right.id)
	);
}

export function taskStatusRank(task: TaskRecord): number {
	if (task.status === "in_progress") return 0;
	if (task.status === "rejected") return 1;
	if (isComplete(task)) return 4;
	if (isCanceled(task)) return 5;
	return 3;
}

export function priority(task: TaskRecord): number {
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

export function gerundTitle(title: string): string {
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

export function sessionTaskId(ctx?: ExtensionContext): string | undefined {
	const anyCtx = ctx as
		| (ExtensionContext & {
				sessionId?: string;
				session?: { id?: string };
				sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined };
		  })
		| undefined;
	const fromCtx = [anyCtx?.sessionId, anyCtx?.session?.id, anyCtx?.sessionManager?.getSessionId?.()].find(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	if (fromCtx) return fromCtx.trim();
	const file = anyCtx?.sessionManager?.getSessionFile?.();
	return typeof file === "string" && file.trim().length > 0
		? file
				.split("/")
				.at(-1)
				?.replace(/\.jsonl$/, "")
				.trim()
		: undefined;
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
	isExpanded(): boolean {
		return this.state?.expanded ?? true;
	}

	render(width: number): string[] {
		const state = this.state;
		if (!state || !hasEnoughTerminalRows(state.config.hud.minTerminalRows)) return [];
		return renderHudLines(state.tasks, this.theme, width, state.config.hud.maxTasks, {
			compact: !this.isExpanded(),
			frame: taskHudFrame,
		});
	}
	dispose(): void {
		if (taskHudWidget !== this) return;
		taskHudPulseTimer?.dispose();
		taskHudPulseTimer = undefined;
		taskHudAnimationTarget = undefined;
		taskHudWidget = undefined;
		taskHudWidgetCtx = undefined;
	}

	invalidate() {}
}

function ensureTaskHudWidget(ctx: ExtensionContext): void {
	if (taskHudWidget && taskHudWidgetCtx === ctx) return;
	taskHudPulseTimer?.dispose();
	taskHudPulseTimer = undefined;
	taskHudAnimationTarget = undefined;
	taskHudWidget = undefined;
	taskHudWidgetCtx = ctx;
	setOrderedAboveEditorWidget(ctx, widgetId, (tui, theme) => {
		taskHudAnimationTarget = tui;
		taskHudWidget = new TaskHudWidget(tui, theme, latestTaskHudState);
		return taskHudWidget;
	});
}

export async function updateTaskHud(
	ctx: ExtensionContext,
	config: TasksPresentationConfig,
	tasks: TaskRecord[],
): Promise<void> {
	const sessionId = sessionTaskId(ctx) ?? `cwd:${ctx.cwd}`;
	const state = { tasks, config, expanded: taskHudExpandedForSession(sessionId) };
	latestTaskHudState = state;
	ensureTaskHudWidget(ctx);
	taskHudWidget?.setState(state);
	updateHudTimer(tasks);
}

function updateHudTimer(tasks: TaskRecord[]): void {
	const needsAnimation = tasks.some((task) => task.status === "in_progress");
	if (needsAnimation && !taskHudPulseTimer && taskHudAnimationTarget) {
		taskHudPulseTimer = sharedAnimationRenderScheduler.mount(
			taskHudAnimationTarget,
			taskHudPulseFrameMs,
			() => taskHudFrame++,
		);
	} else if (!needsAnimation && taskHudPulseTimer) {
		taskHudPulseTimer.dispose();
		taskHudPulseTimer = undefined;
	}
}

export interface TaskBoardActions {
	load(): Promise<TaskRecord[]>;
	mutate(action: TaskCommand, params: Record<string, unknown>): Promise<TaskRecord[]>;
}

export async function showTaskBoard(
	ctx: ExtensionContext,
	config: TasksPresentationConfig,
	actions: TaskBoardActions,
	initialTaskId?: string,
): Promise<void> {
	if (activeTaskBoard) {
		activeTaskBoard.close();
		return;
	}
	const load = actions.load;
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
					onMutate: actions.mutate,
					onEditBody: async (task) => {
						const edited = await ctx.ui.editor(`Edit task ${task.id} body`, task.body ?? "");
						if (edited !== task.body) return actions.mutate("update", { id: task.id, body: edited });
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
	if (config.hud.enabled) await updateTaskHud(ctx, config, await load()).catch(() => {});
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

export interface TaskBoardItem {
	task: TaskRecord;
	blocked: boolean;
}

interface TaskBoardSelection {
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
	if (task.status === "rejected") return "error";
	return "text";
}

function statusIcon(task: TaskRecord, _blocked = false, frame = 0): string {
	if (task.status === "in_progress") return spinnerFrames[frame % spinnerFrames.length] ?? "✳";
	if (isComplete(task)) return "✔";
	return "◻";
}

function taskPrefix(task: TaskRecord, theme: Theme, prefixes: ReadonlyMap<string, string>): string {
	return theme.fg("dim", displayTaskId(task.id, prefixes));
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
	selected = false,
	frame = 0,
	now = Date.now(),
): string {
	const blocked = hasOpenBlockers(task, byId);
	const icon = theme.fg(statusColor(task, blocked), statusIcon(task, blocked, frame));
	const blockers = openBlockers(task, byId).map((id) => displayTaskId(id, prefixes));
	const suffix = blockers.length > 0 ? theme.fg("dim", ` › blocked by ${blockers.join(", ")}`) : "";
	const marker = selected ? "›" : " ";
	let subject = task.title;
	let stats = "";
	if (task.status === "in_progress") {
		subject = `${task.active_form || gerundTitle(task.title)}…`;
		stats = ` ${theme.fg("dim", `(${formatDuration(now - (task.started_at ?? task.updated_at ?? now))})`)}`;
	}
	let text = `${marker} ${icon} ${taskPrefix(task, theme, prefixes)} ${subject}${stats}${suffix}`;
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
	const raw = [
		theme.fg("toolTitle", bold(theme, `${displayTaskId(task.id, prefixes)} ${task.title}`)),
		"",
		`${theme.fg("dim", "Status:")} ${task.status}   ${theme.fg("dim", "Priority:")} ${priority(task)}`,
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
	bindings: TaskBoardKeybindings = defaultTaskBoardKeybindings,
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
			lines.push(taskLine(item.task, theme, innerWidth, byId, prefixes, row === clamped.row));
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
		const bindings = this.options.keybindings ?? defaultTaskBoardKeybindings;
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
			if (task) this.updateSelected({ status: "done" });
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
			this.options.keybindings ?? defaultTaskBoardKeybindings,
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
	if (task.status === "in_progress") return "done";
	if (isComplete(task)) return "open";
	return "in_progress";
}

function taskHudSummary(tasks: TaskRecord[]): string[] {
	const visible = tasks.filter((task) => !isCanceled(task));
	const done = visible.filter(isComplete).length;
	const inProgress = visible.filter((task) => task.status === "in_progress").length;
	const open = visible.length - done - inProgress;
	const parts: string[] = [];
	if (done > 0) parts.push(`${done} done`);
	if (inProgress > 0) parts.push(`${inProgress} in progress`);
	if (open > 0) parts.push(`${open} open`);
	return parts;
}

export function renderHudLines(
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	maxTasks = 10,
	options: {
		compact?: boolean;
		frame?: number;
		now?: number;
	} = {},
): string[] {
	const now = options.now ?? Date.now();
	const visibleTasks = tasks.filter((task) => !isCanceled(task));
	if (visibleTasks.length === 0) return [];
	const parts = taskHudSummary(visibleTasks);
	const summaryLine = truncateLine(
		`${theme.fg("accent", "●")} ${theme.fg("accent", `${visibleTasks.length} tasks`)} ${theme.fg("muted", `(${parts.join(", ")})`)}`,
		width,
	);
	if (options.compact) return [summaryLine];
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const prefixes = minimalTaskIdPrefixes(tasks);
	const lines = [summaryLine];
	const sorted = buildTaskBoardItems(visibleTasks).map((item) => item.task);
	for (const task of sorted.slice(0, maxTasks)) {
		lines.push(taskLine(task, theme, width, byId, prefixes, false, options.frame ?? 0, now));
	}
	const hidden = sorted.length - Math.min(sorted.length, maxTasks);
	if (hidden > 0) lines.push(truncateLine(theme.fg("dim", `    … and ${hidden} more`), width));
	return lines.map((line) => truncateLine(line, width));
}

function renderTaskReminderLines(details: TaskReminderDetails, theme: Theme): string[] {
	const prefixes = minimalTaskIdPrefixes(details.tasks);
	return details.tasks.map((task, index) => {
		const isLast = index === details.tasks.length - 1;
		const blocked = (task.blocked_by ?? []).length > 0;
		const icon = theme.fg(statusColor(task as TaskRecord, blocked), statusIcon(task as TaskRecord, blocked));
		const blockers = (task.blocked_by ?? []).map((id) => displayTaskId(id, prefixes));
		const suffix = blockers.length > 0 ? theme.fg("dim", ` › blocked by ${blockers.join(", ")}`) : "";
		return `${theme.fg("dim", isLast ? "└─" : "├─")} ${icon} ${theme.fg("dim", displayTaskId(task.id, prefixes))} ${theme.fg("accent", `[${task.status}]`)} ${task.title}${suffix}`;
	});
}

export function renderTaskReminderMessage(
	message: { details?: unknown },
	_themeOptions: unknown,
	theme: Theme,
): Component | undefined {
	const details = message.details as Partial<TaskReminderDetails> | undefined;
	if (!details || !Array.isArray(details.tasks)) return undefined;
	const attempts = typeof details.attempts === "number" ? details.attempts : 1;
	const maxAttempts = typeof details.maxAttempts === "number" ? details.maxAttempts : maxTaskReminderAttempts;
	const normalized: TaskReminderDetails = { tasks: details.tasks, attempts, maxAttempts };
	const count = normalized.tasks.length;
	return framedBlock(theme, {
		header: renderStatusLine(theme, {
			icon: "warning",
			title: "Task reminder",
			meta: [`${count} active task${count === 1 ? "" : "s"}`, `${attempts}/${maxAttempts}`],
		}),
		sections: [{ lines: renderTaskReminderLines(normalized, theme) }],
		borderColor: "warning",
		backgroundColor: "customMessageBg",
	});
}

export const maxTaskReminderAttempts = 3;
const emptyTaskRender = new EmptyComponent();

export function taskToolPresentation() {
	return {
		renderShell: "self" as const,
		rendersOwnFailure: true,
		renderCall(params: Record<string, unknown>, theme: Theme, context: { isError?: boolean; isPartial?: boolean }) {
			if (context.isPartial === false) return emptyTaskRender;
			const action = String(params.op ?? params.mode ?? (params.id ? "show" : "list"));
			return framedBlock(theme, {
				header: renderStatusLine(theme, {
					icon: context.isError ? "error" : "pending",
					title: "Tasks",
					description: action,
				}),
				borderColor: context.isError ? "error" : "borderMuted",
			});
		},
		renderResult(
			result: { content?: Array<{ type?: string; text?: string }>; details?: Partial<TaskDetails> },
			options: { expanded?: boolean },
			theme: Theme,
			context: { isError?: boolean },
		) {
			const error = context.isError === true;
			const text = result.content?.find((item) => item.type === "text")?.text ?? "";
			const header = renderStatusLine(theme, {
				icon: error ? "error" : "success",
				title: "Tasks",
				description: result.details?.action ?? (error ? "failed" : undefined),
			});
			const lines =
				text && (error || options.expanded)
					? text.split("\n").map((line) => (error ? theme.fg("error", line) : line))
					: undefined;
			if (!lines) return textComponent(header);
			return framedBlock(theme, {
				header,
				sections: [{ lines }],
				borderColor: error ? "error" : "success",
			});
		},
	};
}

export function resetTasksPresentation(): void {
	activeTaskBoard = undefined;
	taskHudWidget = undefined;
	taskHudWidgetCtx = undefined;
	latestTaskHudState = undefined;
	taskHudAnimationTarget = undefined;
}

export function shutdownTasksPresentation(sessionId: string, preserveExpanded: boolean): void {
	if (!preserveExpanded) taskHudExpandedStates.delete(sessionId);
	taskHudPulseTimer?.dispose();
	taskHudPulseTimer = undefined;
	resetTasksPresentation();
}

export async function toggleTaskHud(
	ctx: ExtensionContext,
	config: TasksPresentationConfig,
	load: () => Promise<TaskRecord[]>,
): Promise<void> {
	const sessionId = sessionTaskId(ctx) ?? `cwd:${ctx.cwd}`;
	taskHudExpandedStates.set(sessionId, !taskHudExpandedForSession(sessionId));
	const tasks = taskHudWidgetCtx === ctx ? latestTaskHudState?.tasks : undefined;
	await updateTaskHud(ctx, config, tasks ?? (await load()));
}
