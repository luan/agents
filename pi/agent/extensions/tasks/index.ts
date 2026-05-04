import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
	ToolExecutionComponent,
} from "@mariozechner/pi-coding-agent";
import {
	type Component,
	matchesKey,
	truncateToWidth as truncateAnsiToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { runCommand as defaultRunCommand } from "../shared/ct-runner";
import { hasEnoughTerminalRows } from "../shared/terminal";

type TaskCommand = "add" | "list" | "show" | "update" | "delete";

interface Config {
	enabled: boolean;
	command: string;
	hud: {
		enabled: boolean;
		maxTasks: number;
		minTerminalRows: number;
		toggleShortcut: string;
	};
	keybindings: TaskBoardKeybindings;
}

interface Runtime {
	runCommand?: typeof defaultRunCommand;
}

interface GuardState {
	progressSerial: number;
	lastGuardFingerprint?: string;
	lastGuardProgressSerial?: number;
	pending?: TaskGuardDecision;
	pauseResponses: number;
	lastUserText?: string;
}

interface TaskRecord {
	id: string;
	title: string;
	body: string;
	status: string;
	priority?: number;
	assigned_to?: string | null;
	assigned_label?: string | null;
	epic_id?: string | null;
	epic_title?: string | null;
	parent_id?: string | null;
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

interface TaskBoardKeybindings {
	toggle: string;
	close: string[];
	left: string[];
	right: string[];
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

const extensionDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(extensionDir, "config.json");
const widgetId = "project-tasks";
const taskHudFlashMs = 5000;
const taskHudPulseFrameMs = 160;
const silentTaskToolNames = new Set(["task_add", "task_list", "task_show", "task_update", "task_delete"]);
const silentTaskToolPatchKey = Symbol.for("agents.tasks.silent-tool-render-patch");
let activeTaskBoard: { close: () => void } | undefined;
let taskHudKanbanHidden = false;
let taskHudPulseTimer: ReturnType<typeof setInterval> | undefined;
let requestTaskHudRender: (() => void) | undefined;
let taskHudWidget: TaskHudWidget | undefined;
let taskHudWidgetCtx: ExtensionContext | undefined;
let latestTaskHudState: TaskHudState | undefined;

interface TaskHudFlash {
	startedAt: number;
	until: number;
}

const taskHudFlashes = new Map<string, TaskHudFlash>();

interface TaskHudState {
	tasks: TaskRecord[];
	display: AssignmentDisplayContext;
	config: Config;
}

const defaultConfig: Config = {
	enabled: true,
	command: "ct",
	hud: {
		enabled: true,
		maxTasks: 6,
		minTerminalRows: 28,
		toggleShortcut: "alt+t",
	},
	keybindings: {
		toggle: "alt+t",
		close: ["escape", "alt+t"],
		left: ["left", "h"],
		right: ["right", "l"],
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
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;
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
			pushOption(args, "--epic-id", params.epic_id);
			pushOption(args, "--epic-title", params.epic_title);
			pushOption(args, "--parent-id", params.parent_id);
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
			pushOption(args, "--epic-id", params.epic_id);
			pushOption(args, "--epic-title", params.epic_title);
			if (params.clear_epic === true) args.push("--clear-epic");
			pushOption(args, "--parent-id", params.parent_id);
			if (params.clear_parent === true) args.push("--clear-parent");
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

function flashTaskHud(task?: TaskRecord): void {
	if (!task?.id) return;
	const now = Date.now();
	taskHudFlashes.set(task.id, { startedAt: now, until: now + taskHudFlashMs });
	ensureTaskHudPulseTimer();
}

function activeTaskHudFlashes(now = Date.now()): Map<string, TaskHudFlash> {
	const active = new Map<string, TaskHudFlash>();
	for (const [id, flash] of taskHudFlashes) {
		if (flash.until > now) {
			active.set(id, flash);
			continue;
		}
		taskHudFlashes.delete(id);
	}
	return active;
}

function ensureTaskHudPulseTimer(): void {
	if (taskHudPulseTimer) return;
	taskHudPulseTimer = setInterval(() => {
		activeTaskHudFlashes();
		requestTaskHudRender?.();
		if (taskHudFlashes.size > 0) return;
		if (taskHudPulseTimer) clearInterval(taskHudPulseTimer);
		taskHudPulseTimer = undefined;
	}, taskHudPulseFrameMs);
	taskHudPulseTimer.unref?.();
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
	if (action === "add" || action === "update") flashTaskHud(details.task);
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
			hideKanban: taskHudKanbanHidden,
			flashTasks: activeTaskHudFlashes(),
		});
	}

	invalidate() {}
}

function ensureTaskHudWidget(ctx: ExtensionContext): void {
	if (taskHudWidget && taskHudWidgetCtx === ctx) return;
	taskHudWidgetCtx = ctx;
	ctx.ui.setWidget(
		widgetId,
		(tui, theme) => {
			requestTaskHudRender = typeof tui.requestRender === "function" ? () => tui.requestRender() : undefined;
			taskHudWidget = new TaskHudWidget(tui, theme, latestTaskHudState);
			return taskHudWidget;
		},
		{ placement: "aboveEditor" },
	);
}

async function updateTaskHud(
	ctx: ExtensionContext,
	pi: ExtensionAPI | undefined,
	command: string,
	runCommand: typeof defaultRunCommand,
	config: Config,
	signal: AbortSignal | false | undefined = ctx.signal,
): Promise<void> {
	const tasks = await loadHudTasks(ctx.cwd, command, runCommand, signal || undefined);
	const display = assignmentDisplayContext(pi, ctx, tasks);
	const state = { tasks, display, config };
	latestTaskHudState = state;
	ensureTaskHudWidget(ctx);
	taskHudWidget?.setState(state);
}

async function showTaskBoard(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	command: string,
	runCommand: typeof defaultRunCommand,
	config: Config,
): Promise<void> {
	if (activeTaskBoard) {
		activeTaskBoard.close();
		return;
	}
	const load = () => loadHudTasks(ctx.cwd, command, runCommand, ctx.signal);
	const tasks = await load();
	try {
		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				const close = () => {
					done();
				};
				activeTaskBoard = { close };
				const board = new TaskBoardOverlay({
					tasks,
					theme,
					keybindings: config.keybindings,
					onClose: close,
					onReload: load,
					onMutate: async (action, params) => {
						await executeTask(command, runCommand, ctx.cwd, action, params, config, pi, ctx, ctx.signal);
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
					width: "98%",
					maxHeight: "92%",
					minWidth: 90,
					anchor: "center",
					margin: 1,
				},
			},
		);
	} finally {
		activeTaskBoard = undefined;
	}
	if (config.hud.enabled) await updateTaskHud(ctx, pi, command, runCommand, config).catch(() => {});
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

function statusColor(status: string): ThemeColor {
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

function openBlockers(task: TaskRecord, byId: Map<string, TaskRecord>): string[] {
	return (task.blocked_by ?? []).filter((id) => {
		const blocker = byId.get(id);
		return !blocker || !isComplete(blocker);
	});
}

function hasOpenBlockers(task: TaskRecord, byId: Map<string, TaskRecord>): boolean {
	return openBlockers(task, byId).length > 0;
}

function hasOpenDependencies(
	task: TaskRecord,
	byId: Map<string, TaskRecord>,
	children: Map<string, TaskRecord[]>,
): boolean {
	return hasOpenBlockers(task, byId) || activeChildren(task, children).length > 0;
}

function priority(task: TaskRecord): number {
	return typeof task.priority === "number" ? task.priority : 0;
}

function sortTasksForDisplay(
	tasks: TaskRecord[],
	blockersById?: Map<string, TaskRecord>,
	childrenByParent?: Map<string, TaskRecord[]>,
): TaskRecord[] {
	const byId = blockersById ?? new Map(tasks.map((task) => [task.id, task]));
	const children = childrenByParent ?? taskChildren([...byId.values()]);
	return [...tasks].sort((left, right) => {
		const leftBlocked = hasOpenDependencies(left, byId, children);
		const rightBlocked = hasOpenDependencies(right, byId, children);
		if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1;
		const priorityDelta = priority(right) - priority(left);
		if (priorityDelta !== 0) return priorityDelta;
		return right.updated_at - left.updated_at || left.id.localeCompare(right.id);
	});
}

export interface TaskBoardColumn {
	id: "ready" | "blocked" | "in_progress" | "done";
	label: string;
	tasks: TaskRecord[];
}

export interface TaskBoardSelection {
	column: number;
	row: number;
}

function isBoardReady(task: TaskRecord): boolean {
	return !isComplete(task) && !isCanceled(task) && task.status !== "in_progress";
}

export function buildTaskBoardColumns(tasks: TaskRecord[]): TaskBoardColumn[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const active = tasks.filter((task) => !isCanceled(task));
	const children = taskChildren(active);
	return [
		{
			id: "ready",
			label: "Ready",
			tasks: sortTasksForDisplay(
				active.filter((task) => isBoardReady(task) && !hasOpenDependencies(task, byId, children)),
				byId,
				children,
			),
		},
		{
			id: "blocked",
			label: "Blocked",
			tasks: sortTasksForDisplay(
				active.filter((task) => isBoardReady(task) && hasOpenDependencies(task, byId, children)),
				byId,
				children,
			),
		},
		{
			id: "in_progress",
			label: "In Progress",
			tasks: sortTasksForDisplay(
				active.filter((task) => task.status === "in_progress"),
				byId,
				children,
			),
		},
		{
			id: "done",
			label: "Done",
			tasks: sortTasksForDisplay(active.filter(isComplete), byId, children),
		},
	];
}

function clampSelection(columns: TaskBoardColumn[], selection: TaskBoardSelection): TaskBoardSelection {
	const column = Math.max(0, Math.min(columns.length - 1, selection.column));
	const rowCount = columns[column]?.tasks.length ?? 0;
	const row = Math.max(0, Math.min(Math.max(0, rowCount - 1), selection.row));
	return { column, row };
}

function selectedTask(columns: TaskBoardColumn[], selection: TaskBoardSelection): TaskRecord | undefined {
	const clamped = clampSelection(columns, selection);
	return columns[clamped.column]?.tasks[clamped.row];
}

function selectionForTask(columns: TaskBoardColumn[], taskId: string): TaskBoardSelection | undefined {
	for (let column = 0; column < columns.length; column++) {
		const row = columns[column]?.tasks.findIndex((task) => task.id === taskId) ?? -1;
		if (row >= 0) return { column, row };
	}
	return undefined;
}

function formatBoardTime(timestamp: number): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
	return new Date(timestamp).toLocaleString();
}

function truncateLine(text: string, width: number): string {
	return truncateAnsiToWidth(text, width, "…");
}

function padToVisibleWidth(text: string, width: number): string {
	const truncated = truncateLine(text, width);
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function fitCells(cells: string[], widths: number[]): string {
	return cells.map((cell, index) => padToVisibleWidth(cell, widths[index] ?? 0)).join("  ");
}

function splitWidths(width: number, count: number): number[] {
	const gapWidth = (count - 1) * 2;
	const available = Math.max(count, width - gapWidth);
	const base = Math.floor(available / count);
	let extra = available % count;
	return Array.from({ length: count }, () => base + (extra-- > 0 ? 1 : 0));
}

function matchesAnyKey(data: string, keys: readonly string[]): boolean {
	return keys.some((key) => data === key || (key === "space" && data === " ") || matchesKey(data, key));
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
		`${keyLabels(bindings.left)}/${keyLabels(bindings.right)}/${keyLabels(bindings.up)}/${keyLabels(bindings.down)} move`,
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

function columnColor(column: TaskBoardColumn): ThemeColor {
	switch (column.id) {
		case "ready":
			return "mdLink";
		case "blocked":
			return "warning";
		case "in_progress":
			return "success";
		case "done":
			return "dim";
	}
}

function columnIcon(column: TaskBoardColumn): string {
	switch (column.id) {
		case "ready":
			return "";
		case "blocked":
			return "";
		case "in_progress":
			return "";
		case "done":
			return "";
	}
}

function shelfHeader(theme: Theme, column: TaskBoardColumn, width: number, hidden = 0): string {
	const count = hidden > 0 ? `${column.tasks.length} – ${hidden} hidden` : `${column.tasks.length}`;
	const title = theme.fg(columnColor(column), `${columnIcon(column)} ${column.label} (${count})`);
	return padToVisibleWidth(title, width);
}

function shelfEmptyLine(width: number): string {
	return " ".repeat(Math.max(0, width));
}

interface HudEpicGroup {
	key: string;
	label: string;
	tasks: TaskRecord[];
	hasCurrentAssignment: boolean;
	maxPriority: number;
	updatedAt: number;
}

function hudEpicKey(task: TaskRecord): string {
	return task.epic_id?.trim() || "";
}

function hudEpicLabel(task: TaskRecord): string {
	return task.epic_title?.trim() || task.epic_id?.trim() || "No epic";
}

function hudEpicGroups(tasks: TaskRecord[], display: AssignmentDisplayContext): HudEpicGroup[] {
	const groups = new Map<string, HudEpicGroup>();
	for (const task of tasks) {
		const key = hudEpicKey(task);
		const existing = groups.get(key);
		if (existing) {
			existing.tasks.push(task);
			existing.hasCurrentAssignment ||= isAssignedToCurrentSession(task, display);
			existing.maxPriority = Math.max(existing.maxPriority, priority(task));
			existing.updatedAt = Math.max(existing.updatedAt, task.updated_at);
			continue;
		}
		groups.set(key, {
			key,
			label: hudEpicLabel(task),
			tasks: [task],
			hasCurrentAssignment: isAssignedToCurrentSession(task, display),
			maxPriority: priority(task),
			updatedAt: task.updated_at,
		});
	}
	return [...groups.values()].sort((left, right) => {
		if (left.key === "" && right.key !== "") return -1;
		if (right.key === "" && left.key !== "") return 1;
		if (left.hasCurrentAssignment !== right.hasCurrentAssignment) return left.hasCurrentAssignment ? -1 : 1;
		const priorityDelta = right.maxPriority - left.maxPriority;
		if (priorityDelta !== 0) return priorityDelta;
		return right.updatedAt - left.updatedAt || left.label.localeCompare(right.label);
	});
}

function renderHudEpicHeader(label: string, theme: Theme, width: number): string {
	return padToVisibleWidth(theme.fg("toolTitle", compact(label, Math.max(8, width - 2))), width);
}

function renderPersistentBackground(text: string, theme: Theme, background: "selectedBg"): string {
	const marker = "__PI_TASK_BG_MARKER__";
	const wrappedMarker = theme.bg(background, marker);
	const markerIndex = wrappedMarker.indexOf(marker);
	if (markerIndex === -1) return theme.bg(background, text);

	const prefix = wrappedMarker.slice(0, markerIndex);
	const suffix = wrappedMarker.slice(markerIndex + marker.length);
	return renderPersistentAnsiBackground(text, prefix, suffix);
}

function renderPersistentAnsiBackground(text: string, prefix: string, suffix: string): string {
	const reopenedText = text.split("\x1b[0m").join(`\x1b[0m${prefix}`);
	return `${prefix}${reopenedText}${suffix}`;
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

function xterm256Rgb(index: number): Rgb | undefined {
	if (index < 0 || index > 255) return undefined;
	const system = [
		[0, 0, 0],
		[128, 0, 0],
		[0, 128, 0],
		[128, 128, 0],
		[0, 0, 128],
		[128, 0, 128],
		[0, 128, 128],
		[192, 192, 192],
		[128, 128, 128],
		[255, 0, 0],
		[0, 255, 0],
		[255, 255, 0],
		[0, 0, 255],
		[255, 0, 255],
		[0, 255, 255],
		[255, 255, 255],
	][index];
	if (system) return { r: system[0] ?? 0, g: system[1] ?? 0, b: system[2] ?? 0 };
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return { r: level, g: level, b: level };
	}
	const value = index - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	return {
		r: levels[Math.floor(value / 36)] ?? 0,
		g: levels[Math.floor((value % 36) / 6)] ?? 0,
		b: levels[value % 6] ?? 0,
	};
}

function parseBackgroundRgb(ansi: string | undefined): Rgb | undefined {
	const truecolor = ansi?.match(/\x1b\[[0-9;]*48;2;([0-9]+);([0-9]+);([0-9]+)m/);
	if (truecolor) {
		return {
			r: Number(truecolor[1]),
			g: Number(truecolor[2]),
			b: Number(truecolor[3]),
		};
	}
	const indexed = ansi?.match(/\x1b\[[0-9;]*48;5;([0-9]+)m/);
	return indexed ? xterm256Rgb(Number(indexed[1])) : undefined;
}

function themeBackgroundAnsi(theme: Theme, background: "selectedBg"): string | undefined {
	const direct = (theme as Theme & { getBgAnsi?: (color: "selectedBg") => string }).getBgAnsi?.(background);
	if (direct) return direct;
	const marker = "__PI_TASK_BG_MARKER__";
	const wrappedMarker = theme.bg(background, marker);
	const markerIndex = wrappedMarker.indexOf(marker);
	return markerIndex > 0 ? wrappedMarker.slice(0, markerIndex) : undefined;
}

function taskHudFlashOpacity(flash: TaskHudFlash | undefined, now: number): number {
	if (!flash) return 1;
	const elapsed = Math.max(0, now - flash.startedAt);
	const remaining = Math.max(0, flash.until - now);
	const fade = Math.min(1, remaining / 600);
	const wave = (Math.sin((elapsed / 900) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
	return Math.max(0, Math.min(1, (0.18 + wave * 0.45) * fade));
}

function opacityBackgroundAnsi(theme: Theme, opacity: number): string | undefined {
	const rgb = parseBackgroundRgb(themeBackgroundAnsi(theme, "selectedBg"));
	if (!rgb) return undefined;
	const blend = (value: number) => Math.round(value * opacity);
	return `\x1b[48;2;${blend(rgb.r)};${blend(rgb.g)};${blend(rgb.b)}m`;
}

function renderTaskHudFlashBackground(
	line: string,
	theme: Theme,
	flash: TaskHudFlash | undefined,
	now: number,
): string {
	if (!flash) return renderPersistentBackground(line, theme, "selectedBg");
	const prefix = opacityBackgroundAnsi(theme, taskHudFlashOpacity(flash, now));
	return prefix
		? renderPersistentAnsiBackground(line, prefix, "\x1b[49m")
		: renderPersistentBackground(line, theme, "selectedBg");
}

function boardColumn(columns: TaskBoardColumn[], id: TaskBoardColumn["id"]): TaskBoardColumn {
	const column = columns.find((candidate) => candidate.id === id);
	if (!column) throw new Error(`Missing task board column: ${id}`);
	return column;
}

function withDoneRecencyOrder(column: TaskBoardColumn): TaskBoardColumn {
	return {
		...column,
		tasks: [...column.tasks].sort(
			(left, right) => right.updated_at - left.updated_at || left.id.localeCompare(right.id),
		),
	};
}

function taskHudSummary(columns: Record<TaskBoardColumn["id"], TaskBoardColumn>): string[] {
	const parts: string[] = [];
	if (columns.ready.tasks.length > 0) parts.push(`${columns.ready.tasks.length} ready`);
	if (columns.blocked.tasks.length > 0) parts.push(`${columns.blocked.tasks.length} blocked`);
	const done = columns.done.tasks.length;
	if (done > 0) parts.push(`${done} done`);
	if (columns.in_progress.tasks.length > 0) parts.push(`${columns.in_progress.tasks.length} in progress`);
	return parts;
}

function hudColumnRows(column: TaskBoardColumn, maxTasks: number): number {
	switch (column.id) {
		case "ready":
			return Math.max(1, Math.min(3, column.tasks.length));
		case "blocked":
			return Math.max(1, Math.min(2, column.tasks.length));
		case "in_progress":
			return Math.max(1, Math.min(maxTasks, column.tasks.length));
		case "done":
			return Math.max(1, Math.min(5, column.tasks.length));
	}
}

function renderHudTaskCard(
	task: TaskRecord,
	column: TaskBoardColumn,
	theme: Theme,
	width: number,
	byId: Map<string, TaskRecord>,
	display: AssignmentDisplayContext,
	flashTaskIds: ReadonlySet<string> = new Set(),
	flashTasks: ReadonlyMap<string, TaskHudFlash> = new Map(),
	now = Date.now(),
): string {
	const blockers = openBlockers(task, byId);
	const assignee = formatAssignee(task, theme, display);
	const meta = [
		priority(task) !== 0 ? ` p${priority(task)}` : "",
		blockers.length > 0 ? ` ←${blockers.length}` : "",
	].join("");
	const titleColor = column.id === "done" || isAssignedToOtherSession(task, display) ? "dim" : "text";
	const card = `${theme.fg(statusColor(task.status), statusGlyph(task.status))} ${formatTaskId(task.id, theme)} ${theme.fg(titleColor, compact(task.title, Math.max(8, width - 16)))}${assignee}${theme.fg("dim", meta)}`;
	const line = padToVisibleWidth(` ${padToVisibleWidth(card, width)}`, width + 2);
	const flash = flashTasks.get(task.id);
	return flash || flashTaskIds.has(task.id) ? renderTaskHudFlashBackground(line, theme, flash, now) : line;
}

function renderHudSection(
	column: TaskBoardColumn,
	theme: Theme,
	width: number,
	rows: number,
	byId: Map<string, TaskRecord>,
	display: AssignmentDisplayContext,
	flashTaskIds: ReadonlySet<string> = new Set(),
	flashTasks: ReadonlyMap<string, TaskHudFlash> = new Map(),
	now = Date.now(),
): string[] {
	const hidden = Math.max(0, column.tasks.length - rows);
	const lines = [shelfHeader(theme, column, width, hidden)];
	const cardWidth = Math.max(1, width - 2);
	const visibleTasks = hudEpicGroups(column.tasks, display)
		.flatMap((group) => group.tasks)
		.slice(0, rows);
	for (const group of hudEpicGroups(visibleTasks, display)) {
		lines.push(renderHudEpicHeader(group.label, theme, width));
		for (const task of group.tasks) {
			lines.push(renderHudTaskCard(task, column, theme, cardWidth, byId, display, flashTaskIds, flashTasks, now));
		}
	}
	if (visibleTasks.length === 0) {
		lines.push(shelfEmptyLine(width));
	}
	return lines;
}

function isVisibleHudTask(task: TaskRecord, display: AssignmentDisplayContext): boolean {
	if (isCanceled(task)) return false;
	if (!isComplete(task)) return true;
	return isAssignedToCurrentSession(task, display);
}

function detailLines(task: TaskRecord, tasks: TaskRecord[], theme: Theme, width: number): string[] {
	const blocked = tasks
		.filter((candidate) => (candidate.blocked_by ?? []).includes(task.id))
		.map((candidate) => candidate.id);
	const assignee = assignmentLabel(task) ?? "none";
	const raw = [
		theme.fg("toolTitle", theme.bold(`${task.id} ${task.title}`)),
		"",
		`${theme.fg("dim", "Status:")} ${task.status}   ${theme.fg("dim", "Priority:")} ${priority(task)}   ${theme.fg("dim", "Assignee:")} ${assignee}`,
		`${theme.fg("dim", "Blockers:")} ${(task.blocked_by ?? []).join(", ") || "none"}`,
		`${theme.fg("dim", "Parent:")} ${task.parent_id ?? "none"}`,
		`${theme.fg("dim", "Blocks:")} ${blocked.join(", ") || "none"}`,
		`Created: ${formatBoardTime(task.created_at)}   Updated: ${formatBoardTime(task.updated_at)}`,
		...(task.body.trim() ? ["", task.body.trim()] : []),
	];
	return raw.flatMap((line) => wrapTextWithAnsi(line, width)).map((line) => truncateLine(line, width));
}

export function renderTaskBoardLines(
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	selection: TaskBoardSelection = { column: 0, row: 0 },
	bindings: TaskBoardKeybindings = defaultConfig.keybindings,
): string[] {
	const safeWidth = Math.max(20, width);
	const innerWidth = Math.max(1, safeWidth - 4);
	const columns = buildTaskBoardColumns(tasks);
	const clamped = clampSelection(columns, selection);
	const widths = splitWidths(innerWidth, columns.length);
	const maxRows = Math.max(1, ...columns.map((column) => column.tasks.length));
	const lines = [
		truncateLine(`${theme.fg("mdHeading", "Tasks")} ${theme.fg("dim", taskBoardHelp(bindings))}`, innerWidth),
		"",
		fitCells(
			columns.map((column, index) => {
				const label = `${column.label} (${column.tasks.length})`;
				return index === clamped.column ? theme.fg("mdHeading", label) : theme.fg("toolTitle", label);
			}),
			widths,
		),
		theme.fg("borderMuted", "─".repeat(innerWidth)),
	];
	for (let row = 0; row < maxRows; row++) {
		lines.push(
			fitCells(
				columns.map((column, columnIndex) => {
					const task = column.tasks[row];
					if (!task) return "";
					const marker = columnIndex === clamped.column && row === clamped.row ? "›" : " ";
					const assignee = assignmentLabel(task);
					const label = `${marker} ${statusGlyph(task.status)} ${task.id} ${compact(task.title, Math.max(12, widths[columnIndex] - 12))}${assignee ? ` @${compact(assignee, 14)}` : ""}`;
					return columnIndex === clamped.column && row === clamped.row
						? renderPersistentBackground(
								padToVisibleWidth(theme.fg("text", label), widths[columnIndex]),
								theme,
								"selectedBg",
							)
						: theme.fg("text", label);
				}),
				widths,
			),
		);
	}
	lines.push("");
	lines.push(truncateLine(theme.fg("borderMuted", "─".repeat(innerWidth)), innerWidth));
	lines.push(theme.fg("mdHeading", "Details"));
	lines.push("");
	const task = selectedTask(columns, clamped);
	if (task) {
		lines.push(...detailLines(task, tasks, theme, innerWidth));
	} else {
		lines.push(truncateLine(theme.fg("dim", "No task selected"), innerWidth));
	}
	return boxedTaskBoard(
		theme,
		safeWidth,
		lines.map((line) => truncateLine(line, innerWidth)),
	);
}

export class TaskBoardOverlay implements Component {
	private tasks: TaskRecord[];
	private boardSelection: TaskBoardSelection = { column: 0, row: 0 };
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
			onChange?: () => void;
		},
	) {
		this.tasks = options.tasks;
		this.boardSelection = clampSelection(buildTaskBoardColumns(this.tasks), this.boardSelection);
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
		this.boardSelection = clampSelection(buildTaskBoardColumns(this.tasks), next);
	}

	private preserveSelection(taskId: string | undefined): void {
		const columns = buildTaskBoardColumns(this.tasks);
		this.boardSelection = taskId
			? (selectionForTask(columns, taskId) ?? clampSelection(columns, this.boardSelection))
			: clampSelection(columns, this.boardSelection);
	}

	private moveColumn(delta: number): void {
		this.setSelection({
			column: this.boardSelection.column + delta,
			row: this.boardSelection.row,
		});
	}

	private moveRow(delta: number): void {
		this.setSelection({
			column: this.boardSelection.column,
			row: this.boardSelection.row + delta,
		});
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
		return selectedTask(buildTaskBoardColumns(this.tasks), this.boardSelection);
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
		if (hasOpenDependencies(task, byId, taskChildren(this.tasks))) return;
		const nextStatus = task.status === "in_progress" ? "done" : isComplete(task) ? "open" : "in_progress";
		this.updateSelected({ status: nextStatus });
	}

	private confirmDeleteSelected(): void {
		const task = this.currentTask();
		if (!task) return;
		this.confirmingDeleteId = task.id;
		this.options.onChange?.();
	}

	private deleteConfirmed(): void {
		if (!this.confirmingDeleteId) return;
		const dependencyMessage = taskDeleteDependencyMessage(this.confirmingDeleteId, this.tasks);
		if (dependencyMessage) {
			this.errorMessage = dependencyMessage;
			this.confirmingDeleteId = undefined;
			this.options.onChange?.();
			return;
		}
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
		if (matchesAnyKey(data, bindings.left)) {
			this.moveColumn(-1);
			return;
		}
		if (matchesAnyKey(data, bindings.right)) {
			this.moveColumn(1);
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
			this.updateSelected({ status: "done" });
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
		if (this.errorMessage) {
			prefix.push(truncateLine(this.options.theme.fg("warning", this.errorMessage), width));
		}
		return [...prefix, ...lines];
	}

	invalidate(): void {}
}

function taskBoardErrorMessage(prefix: string, error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const message = raw
		.replace(/^.+ failed with exit code \d+: /, "")
		.replace(/^Error:\s*/, "")
		.trim();
	return `${prefix}: ${message || raw}`;
}

function taskDeleteDependencyMessage(taskId: string, tasks: TaskRecord[]): string | undefined {
	const blocked = tasks.filter((task) => task.blocked_by?.includes(taskId)).map((task) => task.id);
	if (blocked.length > 0) return `Delete failed: cannot delete task ${taskId}; blocked by ${blocked.join(", ")}`;
	const children = tasks.filter((task) => task.parent_id === taskId).map((task) => task.id);
	if (children.length > 0) return `Delete failed: cannot delete task ${taskId}; parent of ${children.join(", ")}`;
	return undefined;
}

type AssignmentDisplayContext = {
	currentAssignment?: string;
	currentLabel?: string;
	labels?: Map<string, string>;
	sessionPrefixes?: Map<string, string>;
};

function isMutatingTaskAction(action: TaskCommand): boolean {
	return action === "add" || action === "update" || action === "delete";
}

function sessionFile(ctx?: ExtensionContext): string | undefined {
	return (
		ctx as
			| (ExtensionContext & {
					sessionManager?: { getSessionFile?: () => string | undefined };
			  })
			| undefined
	)?.sessionManager?.getSessionFile?.();
}

function sessionIdFromAssignment(assignedTo: string): string | undefined {
	if (!assignedTo.startsWith("session:")) return undefined;
	const id = assignedTo.slice("session:".length);
	return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : undefined;
}

function sessionDisplaySeed(assignedTo: string): string | undefined {
	const id = sessionIdFromAssignment(assignedTo);
	if (!id) return undefined;
	const uuid = id.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)?.[0];
	return uuid ? uuid.replace(/-/g, "").toLowerCase() : id;
}

function shortestSessionPrefixes(assignments: string[]): Map<string, string> {
	const seeds = new Map<string, string>();
	for (const assignment of new Set(assignments)) {
		const seed = sessionDisplaySeed(assignment);
		if (seed) seeds.set(assignment, seed);
	}
	const result = new Map<string, string>();
	for (const [assignment, seed] of seeds) {
		let length = Math.min(seed.length, 4);
		while (
			length < seed.length &&
			[...seeds].some(
				([otherAssignment, otherSeed]) =>
					otherAssignment !== assignment && otherSeed.startsWith(seed.slice(0, length)),
			)
		) {
			length++;
		}
		result.set(assignment, seed.slice(0, length));
	}
	return result;
}

function sessionNameFromFile(path: string): string | undefined {
	try {
		let name: string | undefined;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.includes('"session_info"')) continue;
			const entry = JSON.parse(line) as { type?: string; name?: unknown };
			if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
				name = entry.name.trim();
			}
		}
		return name;
	} catch {
		return undefined;
	}
}

function sessionNameForAssignment(ctx: ExtensionContext | undefined, assignedTo: string): string | undefined {
	const id = sessionIdFromAssignment(assignedTo);
	const currentFile = sessionFile(ctx);
	if (!id || !currentFile) return undefined;
	const sessionDir = resolve(dirname(currentFile));
	const path = resolve(join(sessionDir, `${id}.jsonl`));
	if (!path.startsWith(`${sessionDir}/`)) return undefined;
	return sessionNameFromFile(path);
}

function assignmentDisplayContext(
	pi?: ExtensionAPI,
	ctx?: ExtensionContext,
	tasks: TaskRecord[] = [],
): AssignmentDisplayContext {
	const currentAssignment = sessionAssignment(ctx);
	const currentLabel = sessionName(pi, ctx);
	const labels = new Map<string, string>();
	const assignments = new Set<string>();
	if (currentAssignment) assignments.add(currentAssignment);
	if (currentAssignment && currentLabel) labels.set(currentAssignment, currentLabel);
	for (const task of tasks) {
		const assignedTo = task.assigned_to;
		if (!assignedTo) continue;
		assignments.add(assignedTo);
		if (labels.has(assignedTo)) continue;
		const label = sessionNameForAssignment(ctx, assignedTo);
		if (label) labels.set(assignedTo, label);
	}
	return {
		currentAssignment,
		currentLabel,
		labels,
		sessionPrefixes: shortestSessionPrefixes([...assignments]),
	};
}

function assignmentLabel(task: TaskRecord, display: AssignmentDisplayContext = {}): string | undefined {
	const assignedTo = task.assigned_to;
	if (!assignedTo) return undefined;
	if (assignedTo === display.currentAssignment && display.currentLabel) return display.currentLabel;
	const label = display.labels?.get(assignedTo);
	if (label) return label;
	if (task.assigned_label) return task.assigned_label;
	const prefix = display.sessionPrefixes?.get(assignedTo);
	if (prefix) return prefix;
	const seed = sessionDisplaySeed(assignedTo);
	if (seed) return seed.slice(0, Math.min(seed.length, 4));
	if (assignedTo.startsWith("session:")) return assignedTo.slice("session:".length);
	return assignedTo;
}

function isAssignedToCurrentSession(task: TaskRecord, display: AssignmentDisplayContext): boolean {
	return Boolean(task.assigned_to && task.assigned_to === display.currentAssignment);
}

function isAssignedToOtherSession(task: TaskRecord, display: AssignmentDisplayContext): boolean {
	return Boolean(task.assigned_to && display.currentAssignment && task.assigned_to !== display.currentAssignment);
}

function formatAssignee(task: TaskRecord, theme: Theme, display: AssignmentDisplayContext): string {
	const label = assignmentLabel(task, display);
	if (!label) return "";
	if (isAssignedToCurrentSession(task, display)) {
		return theme.fg("success", ` @${compact(label, 28)}`);
	}
	return theme.fg("dim", ` @${compact(label, 28)}`);
}

function formatTaskId(id: string, theme: Theme): string {
	const padded = id.padEnd(4);
	const visible =
		id.length > 0 ? `${theme.fg("syntaxPunctuation", id.slice(0, -1))}${theme.fg("syntaxType", id.slice(-1))}` : "";
	return `${visible}${" ".repeat(Math.max(0, padded.length - id.length))}`;
}

export function renderHudLines(
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	maxTasks = 6,
	display: AssignmentDisplayContext = {},
	options: {
		hideKanban?: boolean;
		flashTaskIds?: ReadonlySet<string>;
		flashTasks?: ReadonlyMap<string, TaskHudFlash>;
		now?: number;
	} = {},
): string[] {
	const hudTasks = tasks.filter((task) => !isCanceled(task));
	const visibleTasks = hudTasks.filter((task) => isVisibleHudTask(task, display));
	if (visibleTasks.length === 0) return [];
	const columns = buildTaskBoardColumns(hudTasks);
	const doneColumn = boardColumn(columns, "done");
	const hudColumns = {
		ready: boardColumn(columns, "ready"),
		blocked: boardColumn(columns, "blocked"),
		in_progress: boardColumn(columns, "in_progress"),
		done: withDoneRecencyOrder({
			...doneColumn,
			tasks: doneColumn.tasks.filter((task) => isAssignedToCurrentSession(task, display)),
		}),
	};
	const shownColumns = [hudColumns.ready, hudColumns.in_progress, hudColumns.done];
	const widths = splitWidths(width, shownColumns.length);
	const parts = taskHudSummary(hudColumns);
	const summaryLine = truncateLine(
		`${theme.fg("mdHeading", "●")} ${theme.fg("mdHeading", `${visibleTasks.length} tasks`)} ${theme.fg("muted", `(${parts.join(", ")})`)}`,
		width,
	);
	if (options.hideKanban) return [summaryLine];
	const lines: string[] = [];
	const byId = new Map(hudTasks.map((item) => [item.id, item]));
	const now = options.now ?? Date.now();
	const renderedColumns = [
		[
			...renderHudSection(
				hudColumns.ready,
				theme,
				widths[0] ?? width,
				hudColumnRows(hudColumns.ready, maxTasks),
				byId,
				display,
				options.flashTaskIds,
				options.flashTasks,
				now,
			),
			...(hudColumns.blocked.tasks.length > 0
				? renderHudSection(
						hudColumns.blocked,
						theme,
						widths[0] ?? width,
						hudColumnRows(hudColumns.blocked, maxTasks),
						byId,
						display,
						options.flashTaskIds,
						options.flashTasks,
						now,
					)
				: []),
		],
		renderHudSection(
			hudColumns.in_progress,
			theme,
			widths[1] ?? width,
			hudColumnRows(hudColumns.in_progress, maxTasks),
			byId,
			display,
			options.flashTaskIds,
			options.flashTasks,
			now,
		),
		renderHudSection(
			hudColumns.done,
			theme,
			widths[2] ?? width,
			hudColumnRows(hudColumns.done, maxTasks),
			byId,
			display,
			options.flashTaskIds,
			options.flashTasks,
			now,
		),
	];
	const height = Math.max(...renderedColumns.map((column) => column.length));
	for (let row = 0; row < height; row++) {
		lines.push(
			fitCells(
				renderedColumns.map((column, index) => column[row] ?? " ".repeat(widths[index] ?? 0)),
				widths,
			),
		);
	}
	return lines.map((line) => truncateLine(line, width));
}

class EmptyTaskRender implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const emptyTaskRender = new EmptyTaskRender();

function makeTaskTool(
	action: TaskCommand,
	command: string,
	runCommand: typeof defaultRunCommand,
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
			signal?: AbortSignal,
			_onUpdate?: unknown,
			ctx?: ExtensionContext,
		) => {
			const result = await executeTask(command, runCommand, getCwd(), action, params, config, pi, ctx, signal);
			if (isMutatingTaskAction(action)) onProgress?.();
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
		if (silentTaskToolNames.has((this as { toolName?: string }).toolName ?? "")) return [];
		return originalRender.call(this, width);
	};
	prototype[silentTaskToolPatchKey] = true;
}

function isActiveTask(task: TaskRecord): boolean {
	return !isComplete(task) && !isCanceled(task);
}

type TaskGuardActionKind = "continue" | "start" | "claim" | "fix_dependency" | "close_parent";

interface TaskGuardAction {
	kind: TaskGuardActionKind;
	task: TaskRecord;
	source?: TaskRecord;
	invalidBlocker?: string;
}

interface TaskGuardDecision {
	kind: "continue" | "escalate";
	fingerprint: string;
	action: TaskGuardAction;
	content: string;
}

function taskChildren(tasks: TaskRecord[]): Map<string, TaskRecord[]> {
	const children = new Map<string, TaskRecord[]>();
	for (const task of tasks) {
		const parentId = task.parent_id;
		if (!parentId) continue;
		const list = children.get(parentId) ?? [];
		list.push(task);
		children.set(parentId, list);
	}
	return children;
}

function activeChildren(task: TaskRecord, children: Map<string, TaskRecord[]>): TaskRecord[] {
	return (children.get(task.id) ?? []).filter(isActiveTask);
}

function unresolvedBlockers(task: TaskRecord, byId: Map<string, TaskRecord>): Array<TaskRecord | string> {
	return (task.blocked_by ?? []).flatMap((id) => {
		const blocker = byId.get(id);
		if (!blocker) return [id];
		return isComplete(blocker) ? [] : [blocker];
	});
}

function hasUnresolvedDependencies(
	task: TaskRecord,
	byId: Map<string, TaskRecord>,
	children: Map<string, TaskRecord[]>,
): boolean {
	return unresolvedBlockers(task, byId).length > 0 || activeChildren(task, children).length > 0;
}

function isReadyForWork(task: TaskRecord, byId: Map<string, TaskRecord>, children: Map<string, TaskRecord[]>): boolean {
	return isActiveTask(task) && task.status !== "in_progress" && !hasUnresolvedDependencies(task, byId, children);
}

function isAssignedTo(assignment: string, task: TaskRecord): boolean {
	return task.assigned_to === assignment;
}

function isUnassigned(task: TaskRecord): boolean {
	return !task.assigned_to;
}

function sortedActive(tasks: TaskRecord[], byId: Map<string, TaskRecord>): TaskRecord[] {
	return sortTasksForDisplay(tasks.filter(isActiveTask), byId);
}

function selectDependencyAction(
	task: TaskRecord,
	assignedTo: string,
	byId: Map<string, TaskRecord>,
	children: Map<string, TaskRecord[]>,
	seen = new Set<string>(),
): TaskGuardAction | undefined {
	if (!seen.add(task.id)) return undefined;
	for (const dependency of [...unresolvedBlockers(task, byId), ...activeChildren(task, children)]) {
		if (typeof dependency === "string") {
			return { kind: "fix_dependency", task, invalidBlocker: dependency };
		}
		if (isCanceled(dependency)) {
			return { kind: "fix_dependency", task, invalidBlocker: dependency.id };
		}
		if (isAssignedTo(assignedTo, dependency)) {
			if (dependency.status === "in_progress") return { kind: "continue", task: dependency, source: task };
			const nested = selectDependencyAction(dependency, assignedTo, byId, children, seen);
			if (nested) return nested;
			if (isReadyForWork(dependency, byId, children)) return { kind: "start", task: dependency, source: task };
			continue;
		}
		if (isUnassigned(dependency)) {
			const nested = selectDependencyAction(dependency, assignedTo, byId, children, seen);
			if (nested) return nested;
			if (isReadyForWork(dependency, byId, children)) return { kind: "claim", task: dependency, source: task };
		}
	}
	return undefined;
}

function selectGuardAction(tasks: TaskRecord[], assignedTo: string): TaskGuardAction | undefined {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const children = taskChildren(tasks);
	const assigned = sortedActive(
		tasks.filter((task) => isAssignedTo(assignedTo, task)),
		byId,
	);
	if (assigned.length === 0) return undefined;
	for (const task of assigned) {
		const action = selectDependencyAction(task, assignedTo, byId, children);
		if (action) return action;
	}
	const inProgress = assigned.find(
		(task) => task.status === "in_progress" && !hasUnresolvedDependencies(task, byId, children),
	);
	if (inProgress) return { kind: "continue", task: inProgress };
	const assignedReady = assigned.find(
		(task) => isReadyForWork(task, byId, children) && (children.get(task.id)?.length ?? 0) === 0,
	);
	if (assignedReady) return { kind: "start", task: assignedReady };
	const epicIds = new Set(assigned.map((task) => task.epic_id).filter((id): id is string => Boolean(id)));
	const sameEpicReady = sortedActive(
		tasks.filter(
			(task) =>
				isUnassigned(task) && task.epic_id && epicIds.has(task.epic_id) && isReadyForWork(task, byId, children),
		),
		byId,
	)[0];
	if (sameEpicReady) return { kind: "claim", task: sameEpicReady };
	const parentToClose = assigned.find(
		(task) => (children.get(task.id)?.length ?? 0) > 0 && !hasUnresolvedDependencies(task, byId, children),
	);
	if (parentToClose) return { kind: "close_parent", task: parentToClose };
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

function guardInstruction(action: TaskGuardAction): string {
	const source = action.source ? ` to unblock ${action.source.id}` : "";
	switch (action.kind) {
		case "continue":
			return `Continue in-progress task ${action.task.id}${source}: ${action.task.title}`;
		case "start":
			return `Start assigned task ${action.task.id}${source}: ${action.task.title}. First mark it in_progress with task_update.`;
		case "claim":
			return `Task ${action.task.id}${source} has been assigned to this session: ${action.task.title}. First mark it in_progress with task_update.`;
		case "fix_dependency":
			return `Task ${action.task.id} has invalid blocker ${action.invalidBlocker}. Fix blocked_by or choose a replacement blocker before ending.`;
		case "close_parent":
			return `All child tasks for parent ${action.task.id} are terminal. Verify acceptance and mark the parent done.`;
	}
}

function guardContent(action: TaskGuardAction): string {
	return [
		"Task guard: work remains for this session.",
		"",
		guardInstruction(action),
		"",
		"Do not summarize or stop. Continue now.",
	].join("\n");
}

function escalationContent(action: TaskGuardAction): string {
	return [
		"Task guard stalled.",
		"",
		`Work remains: ${action.task.id} [${action.task.status}] ${action.task.title}`,
		`Required next action: ${guardInstruction(action)}`,
	].join("\n");
}

async function evaluateTaskGuard(
	ctx: ExtensionContext,
	command: string,
	runCommand: typeof defaultRunCommand,
	state: GuardState,
): Promise<TaskGuardDecision | undefined> {
	const assignedTo = sessionAssignment(ctx);
	if (!assignedTo) return undefined;
	const tasks = await loadHudTasks(ctx.cwd, command, runCommand, ctx.signal);
	const action = selectGuardAction(tasks, assignedTo);
	if (!action) {
		state.lastGuardFingerprint = undefined;
		state.lastGuardProgressSerial = undefined;
		return undefined;
	}
	const fingerprint = guardFingerprint(tasks, action, assignedTo);
	const stalled = state.lastGuardFingerprint === fingerprint && state.lastGuardProgressSerial === state.progressSerial;
	return {
		kind: stalled ? "escalate" : "continue",
		fingerprint,
		action,
		content: stalled ? escalationContent(action) : guardContent(action),
	};
}

async function autoAssignGuardTask(
	decision: TaskGuardDecision,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	command: string,
	runCommand: typeof defaultRunCommand,
	state: GuardState,
	config: Config,
): Promise<TaskGuardDecision | undefined> {
	if (decision.kind !== "continue" || decision.action.kind !== "claim") return decision;
	const freshDecision = await evaluateTaskGuard(ctx, command, runCommand, state);
	if (!freshDecision || freshDecision.kind !== "continue") return freshDecision;
	if (freshDecision.action.kind !== "claim") return freshDecision;
	if (freshDecision.action.task.id !== decision.action.task.id) return freshDecision;
	await runCommand(
		command,
		buildTaskCommand(
			"update",
			normalizeTaskParams({ id: freshDecision.action.task.id, assigned_to: "current" }, ctx, pi),
		),
		ctx.cwd,
		ctx.signal,
	);
	state.progressSerial++;
	if (config.hud.enabled) await updateTaskHud(ctx, pi, command, runCommand, config).catch(() => {});
	return freshDecision;
}

async function sendTaskGuard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	runCommand: typeof defaultRunCommand,
	state: GuardState,
	config: Config,
): Promise<void> {
	const pending = state.pending;
	state.pending = undefined;
	if (!pending || pending.kind !== "continue") return;
	let decision: TaskGuardDecision | undefined;
	try {
		decision = await autoAssignGuardTask(pending, ctx, pi, command, runCommand, state, config);
	} catch (error) {
		pi.sendMessage(
			{
				customType: "task-guard",
				content: [
					{
						type: "text",
						text: `Task guard could not assign work: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				display: true,
				details: { error: true },
			},
			{ deliverAs: "followUp" },
		);
		return;
	}
	if (!decision) return;
	state.lastGuardFingerprint = decision.fingerprint;
	state.lastGuardProgressSerial = state.progressSerial;
	pi.sendMessage(
		{
			customType: "task-guard",
			content: [{ type: "text", text: decision.content }],
			display: false,
			details: { action: decision.action.kind, taskId: decision.action.task.id },
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
	state.lastUserText = undefined;
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

function shouldKeepAnswerVisible(lastUserText: string | undefined): boolean {
	if (!lastUserText) return false;
	return (
		/\?/.test(lastUserText) ||
		/^(how|what|why|when|where|who|is|are|can|could|should|do|does|did)\b/i.test(lastUserText.trim())
	);
}

function shouldHidePrematureStopAnswer(text: string, lastUserText: string | undefined): boolean {
	if (shouldKeepAnswerVisible(lastUserText)) return false;
	return /^(done|complete|completed|finished|ok|okay|all set|that's it)[.!…\s]*$/i.test(text.trim());
}

function fileChangingResult(result: unknown): boolean {
	const details = (result as { details?: { filesChanged?: unknown; fileDiffs?: unknown } } | undefined)?.details;
	return (
		(typeof details?.filesChanged === "number" && details.filesChanged > 0) ||
		(Array.isArray(details?.fileDiffs) && details.fileDiffs.length > 0)
	);
}

export default function tasksExtension(pi: ExtensionAPI, runtime: Runtime = {}) {
	const config = loadConfig();
	if (!config.enabled) return;
	installSilentTaskToolRenderPatch();

	const runCommand = runtime.runCommand ?? defaultRunCommand;
	let cwd = process.cwd();
	const guardState: GuardState = { progressSerial: 0, pauseResponses: 0 };
	const getCwd = () => cwd;
	const markProgress = () => {
		guardState.progressSerial++;
	};
	const common = (action: TaskCommand) =>
		makeTaskTool(action, config.command, runCommand, config, pi, getCwd, markProgress);

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		if (config.hud.enabled) {
			await updateTaskHud(ctx, pi, config.command, runCommand, config).catch((error) => {
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
		taskHudFlashes.clear();
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
		if (message?.role !== "assistant" || messageHasToolCall(message) || !messageText(message).trim()) {
			return undefined;
		}
		if (guardState.pauseResponses > 0) {
			guardState.pauseResponses--;
			guardState.pending = undefined;
			return undefined;
		}
		let decision: TaskGuardDecision | undefined;
		try {
			decision = await evaluateTaskGuard(ctx, config.command, runCommand, guardState);
		} catch (error) {
			guardState.pending = undefined;
			ctx.ui.notify?.(`Task guard failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return undefined;
		}
		guardState.pending = decision;
		if (!decision) return undefined;
		if (decision.kind === "escalate") {
			return {
				message: {
					...message,
					content: [{ type: "text", text: decision.content }],
				},
			};
		}
		if (!shouldHidePrematureStopAnswer(messageText(message), guardState.lastUserText)) return undefined;
		return {
			message: {
				...message,
				content: [],
			},
		};
	});

	pi.on("turn_end", async (_event, ctx) => {
		await sendTaskGuard(pi, ctx, config.command, runCommand, guardState, config).catch((error) => {
			ctx.ui.notify?.(`Task guard failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
	});

	pi.registerCommand?.("tasks", {
		description: "Open project task board",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await showTaskBoard(ctx, pi, config.command, runCommand, config).catch((error) => {
				ctx.ui.notify?.(`Task board failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
		},
	});

	pi.registerShortcut?.(config.hud.toggleShortcut, {
		description: "Toggle project task HUD Kanban",
		handler: async (ctx: ExtensionContext) => {
			taskHudKanbanHidden = !taskHudKanbanHidden;
			await updateTaskHud(ctx, pi, config.command, runCommand, config).catch((error) => {
				ctx.ui.notify?.(
					`Task HUD refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		},
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
			epic_id: Type.Optional(Type.String({ description: "Stable epic/group identifier" })),
			epic_title: Type.Optional(Type.String({ description: "Human-readable epic/group title" })),
			parent_id: Type.Optional(Type.String({ description: "Parent/coordinator task ID or prefix" })),
			blocked_by: Type.Optional(
				Type.Array(Type.String(), {
					description: "Task IDs/prefixes that block this task",
				}),
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
			assigned_to: Type.Optional(
				Type.String({
					description: "Filter by assignee/session, or 'current'",
				}),
			),
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
			assigned_to: Type.Optional(
				Type.String({
					description: "Assign to this session/user, or 'current'",
				}),
			),
			clear_assignee: Type.Optional(Type.Boolean({ description: "Remove assignee" })),
			epic_id: Type.Optional(Type.String({ description: "New stable epic/group identifier" })),
			epic_title: Type.Optional(Type.String({ description: "New human-readable epic/group title" })),
			clear_epic: Type.Optional(Type.Boolean({ description: "Remove epic/group metadata" })),
			parent_id: Type.Optional(Type.String({ description: "New parent/coordinator task ID or prefix" })),
			clear_parent: Type.Optional(Type.Boolean({ description: "Remove parent task" })),
			blocked_by: Type.Optional(
				Type.Array(Type.String(), {
					description: "Replace blockers with these task IDs/prefixes",
				}),
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
