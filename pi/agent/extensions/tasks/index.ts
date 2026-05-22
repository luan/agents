import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
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
import { runCommand as defaultRunCommand } from "../shared/ct-runner";
import { setOrderedAboveEditorWidget } from "../shared/ordered-widgets";
import { hasEnoughTerminalRows } from "../shared/terminal";

type TaskCommand = "add" | "list" | "show" | "update" | "delete" | "accept" | "reject";

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
	epic_id?: string | null;
	epic_title?: string | null;
	parent_id?: string | null;
	blocked_by?: string[];
	created_at: number;
	updated_at: number;
}

type TicketBoardLaneId = "rejected" | "ready" | "blocked" | "in_progress" | "in_review" | "done";
type BlockedReasonKind = "open_blocker" | "missing_blocker" | "canceled_blocker" | "active_child";

interface TicketBoardProjection {
	boards: TicketBoardProjectionGroup[];
}

interface TicketBoardProjectionGroup {
	key: string;
	title: string;
	epic_label?: string | null;
	priority: number;
	updated_at: number;
	done: number;
	total: number;
	lanes: TicketBoardProjectionLane[];
}

interface TicketBoardProjectionLane {
	id: TicketBoardLaneId;
	title: string;
	tickets: TicketBoardProjectionTicket[];
}

interface TicketBoardProjectionTicket {
	task: TaskRecord;
	lane: TicketBoardLaneId;
	blocked_reasons?: Array<{ kind: BlockedReasonKind; task_id: string; title?: string | null }>;
}

interface TaskSnapshot {
	tasks: TaskRecord[];
	board?: TicketBoardProjection;
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
const maxGuardAutoTurnsWithoutProgress = 2;
const silentTaskToolNames = new Set(["task_read", "task_write"]);
const silentTaskToolPatchKey = Symbol.for("agents.tasks.silent-tool-render-patch");
let activeTaskBoard: { close: () => void } | undefined;
let taskHudExpandedEpicKey: string | null | undefined;
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
	board?: TicketBoardProjection;
	display: AssignmentDisplayContext;
	config: Config;
	taskGuardEnabled: boolean;
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
			pushOption(args, "--type", params.type);
			pushOption(args, "--body", params.body);
			pushOption(args, "--status", params.status);
			pushOption(args, "--priority", params.priority);
			pushOption(args, "--assigned-to", params.assigned_to);
			pushOption(args, "--assigned-label", params.assigned_label);
			pushOption(args, "--epic-id", params.epic_id);
			pushOption(args, "--epic-title", params.epic_title);
			pushRepeatedOption(args, "--label", params.labels);
			pushOption(args, "--parent-id", params.parent_id);
			pushRepeatedOption(args, "--blocked-by", params.blocked_by);
			break;
		case "list":
			pushOption(args, "--status", params.status);
			pushOption(args, "--type", params.type);
			pushOption(args, "--label", params.label);
			pushOption(args, "--epic-id", params.epic_id);
			pushOption(args, "--assigned-to", params.assigned_to);
			if (params.all === true) args.push("--all");
			break;
		case "show":
		case "delete":
		case "accept":
			args.push(String(params.id ?? ""));
			break;
		case "reject":
			args.push(String(params.id ?? ""));
			for (const part of String(params.note ?? "")
				.split(/\s+/)
				.filter(Boolean))
				args.push(part);
			break;
		case "update":
			args.push(String(params.id ?? ""));
			pushOption(args, "--type", params.type);
			pushOption(args, "--title", params.title);
			pushOption(args, "--body", params.body);
			pushOption(args, "--status", params.status);
			pushOption(args, "--priority", params.priority);
			pushOption(args, "--assigned-to", params.assigned_to);
			pushOption(args, "--assigned-label", params.assigned_label);
			if (params.clear_assignee === true) args.push("--clear-assignee");
			pushOption(args, "--epic-id", params.epic_id);
			pushOption(args, "--epic-title", params.epic_title);
			pushRepeatedOption(args, "--label", params.labels);
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

function taskTransitionMessage(action: "accept" | "reject", task?: TaskRecord): string | undefined {
	if (!task) return undefined;
	const verb = action === "accept" ? "Accepted" : "Rejected";
	return `${verb} ${task.id}: ${task.title}`;
}

function latestRejectionNote(task?: TaskRecord): string | undefined {
	const notes = String(task?.body ?? "").match(/^- \d+: (.+)$/gm);
	const latest = notes?.at(-1);
	return latest?.replace(/^- \d+: /, "").trim() || undefined;
}

function publishTaskTransition(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: "accept" | "reject",
	task?: TaskRecord,
	note?: string,
): void {
	const message = taskTransitionMessage(action, task);
	if (!message) return;
	const noteLabel = action === "accept" ? "Human note" : "Rejection note";
	const instruction =
		action === "accept"
			? "This human acceptance has already been recorded. Do not call task accept or update this task to done again."
			: "This human rejection has already been recorded. Do not call task reject or update this task to rejected again; treat the note as feedback for the next revision.";
	const visibleText = [message, note ? `${noteLabel}: ${note}` : undefined, instruction].filter(Boolean).join("\n\n");
	ctx.ui.notify?.(message, "info");
	pi.sendMessage?.(
		{
			customType: "task-transition",
			content: [{ type: "text", text: visibleText }],
			display: true,
			details: { action, taskId: task?.id, status: task?.status, note },
		},
		note ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "followUp" },
	);
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
	if (action === "add" || action === "update" || action === "accept" || action === "reject")
		flashTaskHud(details.task);
	if (
		ctx &&
		config.hud.enabled &&
		(action === "add" || action === "update" || action === "delete" || action === "accept" || action === "reject")
	) {
		await updateTaskHud(ctx, pi, command, runCommand, config).catch((error) => {
			ctx.ui.notify?.(
				`Task HUD refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		});
	}
	return textResult(text, details);
}

async function loadTaskSnapshot(
	cwd: string,
	command: string,
	runCommand: typeof defaultRunCommand,
	signal?: AbortSignal,
): Promise<TaskSnapshot> {
	const result = await runCommand(command, ["task", "tui", "--json"], cwd, signal);
	const parsed = JSON.parse(result.stdout || "{}") as { tasks?: TaskRecord[]; board?: TicketBoardProjection };
	return { tasks: parsed.tasks ?? tasksFromProjection(parsed.board), board: parsed.board };
}

async function loadHudTasks(cwd: string, command: string, runCommand: typeof defaultRunCommand, signal?: AbortSignal) {
	return (await loadTaskSnapshot(cwd, command, runCommand, signal)).tasks;
}

function tasksFromProjection(board: TicketBoardProjection | undefined): TaskRecord[] {
	return (
		board?.boards.flatMap((group) => group.lanes.flatMap((lane) => lane.tickets.map((ticket) => ticket.task))) ?? []
	);
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
			board: state.board,
			hideKanban: taskHudExpandedEpicKey === null,
			expandedEpicKey: taskHudExpandedEpicKey ?? undefined,
			flashTasks: activeTaskHudFlashes(),
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
	command: string,
	runCommand: typeof defaultRunCommand,
	config: Config,
	taskGuardEnabled = latestTaskHudState?.taskGuardEnabled ?? false,
	signal: AbortSignal | false | undefined = ctx.signal,
	preloadedTasks?: TaskRecord[],
): Promise<void> {
	const snapshot = preloadedTasks
		? { tasks: preloadedTasks }
		: await loadTaskSnapshot(ctx.cwd, command, runCommand, signal || undefined);
	const tasks = snapshot.tasks;
	const display = assignmentDisplayContext(pi, ctx, tasks);
	const visibleKeys = visibleHudEpicKeys(tasks, snapshot.board);
	if (
		taskHudExpandedEpicKey === undefined ||
		(taskHudExpandedEpicKey !== null && !visibleKeys.includes(taskHudExpandedEpicKey))
	) {
		taskHudExpandedEpicKey = visibleKeys[0] ?? null;
	}
	const state = { tasks, board: snapshot.board, display, config, taskGuardEnabled };
	latestTaskHudState = state;
	ensureTaskHudWidget(ctx);
	taskHudWidget?.setState(state);
}

function visibleHudEpicKeys(tasks: TaskRecord[], board?: TicketBoardProjection): string[] {
	return buildTaskBoardGroups(
		tasks.filter((task) => !isCanceled(task)),
		board,
	).map((group) => group.key);
}

function cycleTaskHudExpandedEpic(tasks: TaskRecord[]): void {
	const keys = visibleHudEpicKeys(tasks);
	if (keys.length === 0) {
		taskHudExpandedEpicKey = null;
		return;
	}
	if (taskHudExpandedEpicKey === null) {
		taskHudExpandedEpicKey = keys[0];
		return;
	}
	const index = keys.indexOf(taskHudExpandedEpicKey);
	taskHudExpandedEpicKey = index >= 0 && index < keys.length - 1 ? keys[index + 1] : null;
}

async function showTaskBoard(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	command: string,
	runCommand: typeof defaultRunCommand,
	config: Config,
	initialTaskId?: string,
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
				const useRustOverlay = runCommand === defaultRunCommand;
				const board = useRustOverlay
					? new RatatuiTaskBoardOverlay({
							tasks,
							theme,
							keybindings: config.keybindings,
							command,
							cwd: ctx.cwd,
							initialTaskId,
							onClose: close,
							onMutate: async (action, params) => {
								await executeTask(command, runCommand, ctx.cwd, action, params, config, pi, ctx, ctx.signal);
								return load();
							},
							onChange: () => tui.requestRender(),
						})
					: new TaskBoardOverlay({
							tasks,
							theme,
							keybindings: config.keybindings,
							initialTaskId,
							onClose: close,
							onReload: load,
							onMutate: async (action, params) => {
								await executeTask(command, runCommand, ctx.cwd, action, params, config, pi, ctx, ctx.signal);
								return load();
							},
							onEditBody: async (task) => {
								const edited = await ctx.ui.editor(`Edit task ${task.id} body`, task.body ?? "");
								if (edited !== task.body) {
									await executeTask(
										command,
										runCommand,
										ctx.cwd,
										"update",
										{ id: task.id, body: edited },
										config,
										pi,
										ctx,
										ctx.signal,
									);
								}
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
	id: "rejected" | "ready" | "blocked" | "in_progress" | "in_review" | "done";
	label: string;
	tasks: TaskRecord[];
}

interface TaskBoardGroup {
	key: string;
	label: string;
	epicLabel?: string;
	tasks: TaskRecord[];
	priority: number;
	updatedAt: number;
	done: number;
	total: number;
}

export interface TaskBoardSelection {
	column: number;
	row: number;
}

function isBoardReady(task: TaskRecord): boolean {
	return !isComplete(task) && !isCanceled(task) && task.status !== "in_progress" && task.status !== "in_review";
}

function isBoardActive(task: TaskRecord): boolean {
	return !isComplete(task) && !isCanceled(task);
}

export function buildTaskBoardColumns(tasks: TaskRecord[]): TaskBoardColumn[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const active = tasks.filter((task) => !isCanceled(task) && task.type !== "epic" && hasEpicMetadata(task));
	const children = taskChildren(active);
	const rejected = sortTasksForDisplay(
		active.filter((task) => task.status === "rejected" && !hasOpenDependencies(task, byId, children)),
		byId,
		children,
	);
	const columns: TaskBoardColumn[] = [
		{
			id: "ready",
			label: "Ready",
			tasks: sortTasksForDisplay(
				active.filter(
					(task) => isBoardReady(task) && task.status !== "rejected" && !hasOpenDependencies(task, byId, children),
				),
				byId,
				children,
			),
		},
		{
			id: "blocked",
			label: "Blocked",
			tasks: sortTasksForDisplay(
				active.filter((task) => isBoardActive(task) && hasOpenDependencies(task, byId, children)),
				byId,
				children,
			),
		},
		{
			id: "in_progress",
			label: "In Progress",
			tasks: sortTasksForDisplay(
				active.filter((task) => task.status === "in_progress" && !hasOpenDependencies(task, byId, children)),
				byId,
				children,
			),
		},
		{
			id: "in_review",
			label: "In Review",
			tasks: sortTasksForDisplay(
				active.filter((task) => task.status === "in_review" && !hasOpenDependencies(task, byId, children)),
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
	if (rejected.length > 0) {
		columns.unshift({ id: "rejected", label: "Rejected", tasks: rejected });
	}
	return columns;
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
		case "rejected":
			return "error";
		case "ready":
			return "mdLink";
		case "blocked":
			return "muted";
		case "in_progress":
			return "warning";
		case "in_review":
			return "accent";
		case "done":
			return "success";
	}
}

function columnIcon(column: TaskBoardColumn): string {
	switch (column.id) {
		case "rejected":
			return "";
		case "ready":
			return "";
		case "blocked":
			return "";
		case "in_progress":
			return "";
		case "in_review":
			return "";
		case "done":
			return "";
	}
}

function isEpicTask(task: TaskRecord): boolean {
	return task.type === "epic";
}

function taskEpicKey(task: TaskRecord): string {
	return task.epic_id?.trim() || "";
}

function hasEpicMetadata(task: TaskRecord): boolean {
	return taskEpicKey(task).length > 0;
}

function buildTaskBoardGroups(tasks: TaskRecord[], board?: TicketBoardProjection): TaskBoardGroup[] {
	if (board) return board.boards.map(taskBoardGroupFromProjection);
	const epicByLabel = new Map<string, TaskRecord>();
	for (const task of tasks) {
		if (!isEpicTask(task)) continue;
		const label = taskEpicKey(task);
		if (label) epicByLabel.set(label, task);
	}
	const grouped = new Map<string, TaskRecord[]>();
	for (const task of tasks.filter((candidate) => !isEpicTask(candidate) && hasEpicMetadata(candidate))) {
		const label = taskEpicKey(task);
		const key = epicByLabel.has(label) ? label : `unknown:${label}`;
		grouped.set(key, [...(grouped.get(key) ?? []), task]);
	}
	const groups = [...grouped.entries()]
		.map(([key, groupTasks]) => {
			const label = key.startsWith("unknown:") ? key.slice("unknown:".length) : key;
			const epic = label ? epicByLabel.get(label) : undefined;
			const progressTasks = groupTasks.filter((task) => !isCanceled(task));
			return {
				key,
				label: epic?.title ?? `Unknown Epic: ${label}`,
				epicLabel: label,
				tasks: groupTasks,
				priority: epic ? priority(epic) : Math.max(0, ...groupTasks.map(priority)),
				updatedAt: Math.max(epic?.updated_at ?? 0, ...groupTasks.map((task) => task.updated_at)),
				done: progressTasks.filter(isComplete).length,
				total: progressTasks.length,
			};
		})
		.filter((group) => group.tasks.length > 0);
	return groups.sort((left, right) => {
		const priorityDelta = right.priority - left.priority;
		if (priorityDelta !== 0) return priorityDelta;
		return (
			right.updatedAt - left.updatedAt ||
			(left.epicLabel ?? left.label).localeCompare(right.epicLabel ?? right.label)
		);
	});
}

function taskBoardGroupFromProjection(group: TicketBoardProjectionGroup): TaskBoardGroup {
	return {
		key: group.key,
		label: group.title,
		epicLabel: group.epic_label ?? undefined,
		tasks: group.lanes.flatMap((lane) => lane.tickets.map((ticket) => ticket.task)),
		priority: group.priority,
		updatedAt: group.updated_at,
		done: group.done,
		total: group.total,
	};
}

function progressBar(theme: Theme, done: number, total: number, width: number): string {
	const ratio = total === 0 ? 0 : Math.max(0, Math.min(1, done / total));
	const filled = Math.round(width * ratio);
	return `${theme.fg("accent", "─".repeat(filled))}${theme.fg("dim", "─".repeat(Math.max(0, width - filled)))}`;
}

function renderEpicBoardHeader(group: TaskBoardGroup, theme: Theme, width: number): string {
	const prefix = "Epic:";
	const suffixStart = ` – ${group.done}/${group.total} [`;
	const suffixEnd = "]";
	const label = group.epicLabel ? ` ${theme.fg("success", group.epicLabel)}` : "";
	const staticWidth = visibleWidth(`${prefix}  ${suffixStart}${suffixEnd}`) + visibleWidth(label);
	const barWidth = Math.max(5, Math.min(20, Math.max(5, width - staticWidth - 8)));
	const titleWidth = Math.max(4, width - staticWidth - barWidth - 1);
	return truncateLine(
		`${theme.fg("mdHeading", prefix)} ${theme.fg("toolTitle", compact(group.label, titleWidth))}${label}${theme.fg("dim", suffixStart)}${progressBar(theme, group.done, group.total, barWidth)}${theme.fg("dim", suffixEnd)}`,
		width,
	);
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
	if (columns.rejected?.tasks.length > 0) parts.push(`${columns.rejected.tasks.length} rejected`);
	if (columns.ready.tasks.length > 0) parts.push(`${columns.ready.tasks.length} ready`);
	if (columns.blocked.tasks.length > 0) parts.push(`${columns.blocked.tasks.length} blocked`);
	const done = columns.done.tasks.length;
	if (done > 0) parts.push(`${done} done`);
	if (columns.in_progress.tasks.length > 0) parts.push(`${columns.in_progress.tasks.length} in progress`);
	if (columns.in_review.tasks.length > 0) parts.push(`${columns.in_review.tasks.length} in review`);
	return parts;
}

function taskGuardHudLine(theme: Theme, width: number): string {
	return truncateLine(`${theme.fg("accent", "󰌾")} ${theme.fg("warning", "Task guard on")}`, width);
}

function shelfHeader(theme: Theme, column: TaskBoardColumn, width: number, hidden = 0): string {
	const count = hidden > 0 ? `${column.tasks.length} – ${hidden} hidden` : `${column.tasks.length}`;
	const title = theme.fg(columnColor(column), `${columnIcon(column)} ${column.label} (${count})`);
	return padToVisibleWidth(title, width);
}

function hudColumnRows(column: TaskBoardColumn, maxTasks: number): number {
	switch (column.id) {
		case "rejected":
		case "ready":
			return Math.max(1, Math.min(3, column.tasks.length));
		case "blocked":
			return Math.max(1, Math.min(2, column.tasks.length));
		case "in_progress":
		case "in_review":
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
	const labels = formatTaskLabels(task, theme);
	const meta = blockers.length > 0 ? ` ←${blockers.length}` : "";
	const titleColor = column.id === "done" || isAssignedToOtherSession(task, display) ? "dim" : "text";
	const fixedWidth = visibleWidth(`${typeIcon(task)}  ${task.id} ${labels}${assignee}${meta}`) + 4;
	const card = `${theme.fg(typeColor(task), typeIcon(task))} ${formatTaskId(task.id, theme)} ${theme.fg(titleColor, compact(task.title, Math.max(8, width - fixedWidth)))}${labels}${assignee}${theme.fg("dim", meta)}`;
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
	if (column.tasks.length === 0) return [];
	const hidden = Math.max(0, column.tasks.length - rows);
	const lines = [shelfHeader(theme, column, width, hidden)];
	const cardWidth = Math.max(1, width - 2);
	for (const task of column.tasks.slice(0, rows)) {
		lines.push(renderHudTaskCard(task, column, theme, cardWidth, byId, display, flashTaskIds, flashTasks, now));
	}
	return lines;
}

function isTaskBodyHeading(line: string): boolean {
	const trimmed = line.trim();
	return /^#{1,6}\s+\S/.test(trimmed) || (/^[A-Z][A-Za-z0-9 /-]+:$/.test(trimmed) && trimmed.length <= 80);
}

function formatTaskBodyHeading(line: string, theme: Theme): string {
	return theme.fg("mdHeading", line.trim().replace(/^#{1,6}\s+/, ""));
}

function taskBodyDetailLines(body: string, theme: Theme): string[] {
	const trimmed = body.trim();
	if (!trimmed) return [];
	const lines = [theme.fg("dim", "Body:"), ""];
	for (const line of trimmed.split(/\r?\n/)) {
		const clean = line.trimEnd();
		if (!clean.trim()) {
			lines.push("");
		} else if (isTaskBodyHeading(clean)) {
			lines.push(formatTaskBodyHeading(clean, theme));
		} else if (/^\s*[-*]\s+/.test(clean)) {
			lines.push(`  ${theme.fg("dim", "•")} ${clean.replace(/^\s*[-*]\s+/, "")}`);
		} else {
			lines.push(clean);
		}
	}
	return lines;
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
		...(task.body.trim() ? ["", ...taskBodyDetailLines(task.body, theme)] : []),
	];
	return raw.flatMap((line) => wrapTextWithAnsi(line, width)).map((line) => truncateLine(line, width));
}

function renderBoardTaskRow(task: TaskRecord, theme: Theme, width: number, selected: boolean): string {
	const marker = selected ? "›" : " ";
	const assignee = assignmentLabel(task);
	const labels = formatTaskLabels(task, theme);
	const assigneeText = assignee ? ` ${theme.fg("mdLink", italic(`@${assignee}`))}` : "";
	const label = `${marker} ${theme.fg(typeColor(task), typeIcon(task))} ${task.id} ${compact(task.title, Math.max(12, width - visibleWidth(`${task.id}${labels}${assigneeText}`) - 6))}${labels}${assigneeText}`;
	return selected
		? renderPersistentBackground(padToVisibleWidth(theme.fg("text", label), width), theme, "selectedBg")
		: theme.fg("text", label);
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
	const lines = [
		truncateLine(`${theme.fg("mdHeading", "Tasks")} ${theme.fg("dim", taskBoardHelp(bindings))}`, innerWidth),
		"",
	];
	for (const group of buildTaskBoardGroups(tasks)) {
		const groupColumns = buildTaskBoardColumns(group.tasks);
		const leftLane = (["rejected", "ready", "blocked"] as const).flatMap((id) => {
			const column = groupColumns.find((candidate) => candidate.id === id) ?? { id, label: "Rejected", tasks: [] };
			if (column.tasks.length === 0) return [];
			return [
				theme.fg(columnColor(column), `${columnIcon(column)} ${column.label} (${column.tasks.length})`),
				...column.tasks.map((task) => {
					const globalSelection = selectionForTask(columns, task.id);
					return renderBoardTaskRow(
						task,
						theme,
						Math.max(1, Math.floor(innerWidth / 3) - 2),
						globalSelection?.column === clamped.column && globalSelection.row === clamped.row,
					);
				}),
			];
		});
		const lanes = [
			leftLane,
			...(["in_progress", "in_review", "done"] as const).map((id) => {
				const column = boardColumn(groupColumns, id);
				if (column.tasks.length === 0) return [];
				return [
					theme.fg(columnColor(column), `${columnIcon(column)} ${column.label} (${column.tasks.length})`),
					...column.tasks.map((task) => {
						const globalSelection = selectionForTask(columns, task.id);
						return renderBoardTaskRow(
							task,
							theme,
							Math.max(1, Math.floor(innerWidth / 3) - 2),
							globalSelection?.column === clamped.column && globalSelection.row === clamped.row,
						);
					}),
				];
			}),
		].filter((lane) => lane.length > 0);
		if (lanes.length === 0) continue;
		lines.push(renderEpicBoardHeader(group, theme, innerWidth));
		const widths = splitWidths(innerWidth, lanes.length);
		const height = Math.max(...lanes.map((lane) => lane.length));
		for (let row = 0; row < height; row++) {
			lines.push(
				fitCells(
					lanes.map((lane, index) => lane[row] ?? " ".repeat(widths[index] ?? 0)),
					widths,
				),
			);
		}
		lines.push(theme.fg("borderMuted", "─".repeat(innerWidth)));
	}
	if (lines.length === 2) lines.push(truncateLine(theme.fg("dim", "No tasks"), innerWidth));
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
			onEditBody?: (task: TaskRecord) => Promise<TaskRecord[]>;
			onChange?: () => void;
			initialTaskId?: string;
		},
	) {
		this.tasks = options.tasks;
		const columns = buildTaskBoardColumns(this.tasks);
		this.boardSelection = options.initialTaskId
			? (selectionForTask(columns, options.initialTaskId) ?? clampSelection(columns, this.boardSelection))
			: clampSelection(columns, this.boardSelection);
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
		const nextStatus = nextCycledStatus(task);
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
				this.boardSelection = selectionForTask(buildTaskBoardColumns(tasks), task.id) ?? this.boardSelection;
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
	return action === "add" || action === "update" || action === "delete" || action === "accept" || action === "reject";
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

function taskGuardStatePath(): string | undefined {
	const base =
		process.env.XDG_STATE_HOME ?? (process.env.HOME ? join(process.env.HOME, ".local", "state") : undefined);
	return base ? join(base, "pi", "task-guard.json") : undefined;
}

function taskGuardPreferenceKey(ctx?: ExtensionContext): string | undefined {
	const file = sessionFile(ctx);
	if (!file) return undefined;
	const id = basename(file).replace(/\.jsonl$/, "");
	return id ? `session:${id}` : undefined;
}

function readTaskGuardPreference(ctx?: ExtensionContext): boolean | undefined {
	const path = taskGuardStatePath();
	const key = taskGuardPreferenceKey(ctx);
	if (!path || !key) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { sessions?: Record<string, unknown> };
		const value = parsed.sessions?.[key];
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeTaskGuardPreference(ctx: ExtensionContext, enabled: boolean): void {
	const path = taskGuardStatePath();
	const key = taskGuardPreferenceKey(ctx);
	if (!path || !key) return;
	try {
		let parsed: { sessions?: Record<string, boolean> } = {};
		try {
			parsed = JSON.parse(readFileSync(path, "utf8")) as { sessions?: Record<string, boolean> };
		} catch {}
		const sessions = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
		sessions[key] = enabled;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ ...parsed, sessions }, null, 2)}\n`, "utf8");
	} catch {}
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
		return ` ${theme.fg("muted", italic("self"))}`;
	}
	return ` ${theme.fg("mdLink", italic(`@${label}`))}`;
}

function italic(text: string): string {
	return `\x1b[3m${text}\x1b[23m`;
}

function typeIcon(task: TaskRecord): string {
	switch (task.type) {
		case "feature":
			return "";
		case "bug":
			return "";
		case "epic":
			return "";
		default:
			return "";
	}
}

function typeColor(task: TaskRecord): ThemeColor {
	switch (task.type) {
		case "feature":
			return "warning";
		case "bug":
			return "error";
		case "epic":
			return "accent";
		default:
			return "muted";
	}
}

function formatTaskLabels(task: TaskRecord, theme: Theme): string {
	const labels = task.labels ?? [];
	if (labels.length === 0) return "";
	return ` ${labels.map((label) => theme.fg("syntaxString", italic(label))).join(", ")}`;
}

function formatTaskId(id: string, theme: Theme): string {
	const padded = id.padEnd(4);
	const visible =
		id.length > 0 ? `${theme.fg("syntaxPunctuation", id.slice(0, -1))}${theme.fg("syntaxType", id.slice(-1))}` : "";
	return `${visible}${" ".repeat(Math.max(0, padded.length - id.length))}`;
}

const HUD_DONE_WINDOW_MS = 60 * 60 * 1000;

function isRecentlyComplete(task: TaskRecord, now: number): boolean {
	return isComplete(task) && now - task.updated_at <= HUD_DONE_WINDOW_MS;
}

function isActiveCurrentSessionEpicTask(task: TaskRecord, display: AssignmentDisplayContext): boolean {
	return isAssignedToCurrentSession(task, display) && !isComplete(task) && !isCanceled(task) && task.type !== "epic";
}

function renderHudEpicSummary(group: TaskBoardGroup, theme: Theme, width: number): string {
	const label = group.epicLabel ? ` ${theme.fg("success", group.epicLabel)}` : "";
	const marker = group.total > 0 && group.done === group.total ? theme.fg("success", "✓") : theme.fg("dim", "○");
	const completed = group.done > 0 ? ` · ${group.done} done` : "";
	return truncateLine(`${marker} ${theme.fg("toolTitle", group.label)}${label}${theme.fg("dim", completed)}`, width);
}

function renderColumnarHudGroup(
	group: TaskBoardGroup,
	theme: Theme,
	width: number,
	maxTasks: number,
	byId: Map<string, TaskRecord>,
	display: AssignmentDisplayContext,
	now: number,
	flashTaskIds?: ReadonlySet<string>,
	flashTasks?: ReadonlyMap<string, TaskHudFlash>,
): string[] {
	const groupTasks = group.tasks.filter((task) => !isCanceled(task));
	const visibleTasks = groupTasks.filter(
		(task) => !isComplete(task) || (isAssignedToCurrentSession(task, display) && isRecentlyComplete(task, now)),
	);
	if (visibleTasks.length === 0 && groupTasks.length > 0 && groupTasks.every(isComplete)) {
		return [
			truncateLine(
				`${theme.fg("success", "✓")} ${theme.fg("toolTitle", group.label)} ${theme.fg("dim", `${groupTasks.length} completed`)}`,
				width,
			),
		];
	}
	if (visibleTasks.length === 0) return [];
	const scopedGroup: TaskBoardGroup = {
		...group,
		tasks: visibleTasks,
		done: visibleTasks.filter(isComplete).length,
		total: visibleTasks.length,
	};
	const visibleTasksForColumns = visibleTasks.map((task) => ({ ...task, blocked_by: openBlockers(task, byId) }));
	const groupColumns = buildTaskBoardColumns(visibleTasksForColumns);
	const groupDoneColumn = boardColumn(groupColumns, "done");
	const groupHudColumns = {
		rejected: groupColumns.find((column) => column.id === "rejected") ?? {
			id: "rejected" as const,
			label: "Rejected",
			tasks: [],
		},
		ready: boardColumn(groupColumns, "ready"),
		blocked: boardColumn(groupColumns, "blocked"),
		in_progress: boardColumn(groupColumns, "in_progress"),
		in_review: boardColumn(groupColumns, "in_review"),
		done: withDoneRecencyOrder(groupDoneColumn),
	};
	const widths = splitWidths(width, 3);
	const renderedColumns = [
		[
			...renderHudSection(
				groupHudColumns.rejected,
				theme,
				widths[0] ?? width,
				hudColumnRows(groupHudColumns.rejected, maxTasks),
				byId,
				display,
				flashTaskIds,
				flashTasks,
				now,
			),
			...renderHudSection(
				groupHudColumns.ready,
				theme,
				widths[0] ?? width,
				hudColumnRows(groupHudColumns.ready, maxTasks),
				byId,
				display,
				flashTaskIds,
				flashTasks,
				now,
			),
			...(groupHudColumns.blocked.tasks.length > 0
				? renderHudSection(
						groupHudColumns.blocked,
						theme,
						widths[0] ?? width,
						hudColumnRows(groupHudColumns.blocked, maxTasks),
						byId,
						display,
						flashTaskIds,
						flashTasks,
						now,
					)
				: []),
		],
		[
			...renderHudSection(
				groupHudColumns.in_progress,
				theme,
				widths[1] ?? width,
				hudColumnRows(groupHudColumns.in_progress, maxTasks),
				byId,
				display,
				flashTaskIds,
				flashTasks,
				now,
			),
			...renderHudSection(
				groupHudColumns.in_review,
				theme,
				widths[1] ?? width,
				hudColumnRows(groupHudColumns.in_review, maxTasks),
				byId,
				display,
				flashTaskIds,
				flashTasks,
				now,
			),
		],
		renderHudSection(
			groupHudColumns.done,
			theme,
			widths[2] ?? width,
			hudColumnRows(groupHudColumns.done, maxTasks),
			byId,
			display,
			flashTaskIds,
			flashTasks,
			now,
		),
	];
	if (renderedColumns.every((column) => column.length === 0)) return [];
	const lines = [renderEpicBoardHeader(scopedGroup, theme, width)];
	const height = Math.max(...renderedColumns.map((column) => column.length));
	for (let row = 0; row < height; row++) {
		lines.push(
			fitCells(
				renderedColumns.map((column, index) => column[row] ?? " ".repeat(widths[index] ?? 0)),
				widths,
			),
		);
	}
	return lines;
}

export function renderHudLines(
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	maxTasks = 6,
	display: AssignmentDisplayContext = {},
	options: {
		hideKanban?: boolean;
		expandedEpicKey?: string;
		board?: TicketBoardProjection;
		flashTaskIds?: ReadonlySet<string>;
		flashTasks?: ReadonlyMap<string, TaskHudFlash>;
		now?: number;
		taskGuardEnabled?: boolean;
	} = {},
): string[] {
	const hudTasks = tasks.filter((task) => !isCanceled(task));
	const now = options.now ?? Date.now();
	const guardLines = options.taskGuardEnabled ? [taskGuardHudLine(theme, width)] : [];
	const visibleTasks = hudTasks.filter(
		(task) =>
			task.type !== "epic" &&
			(!isComplete(task) || (isAssignedToCurrentSession(task, display) && isRecentlyComplete(task, now))),
	);
	const groups = buildTaskBoardGroups(hudTasks, options.board);
	if (visibleTasks.length === 0 && groups.length === 0) return guardLines;
	const columns = buildTaskBoardColumns(hudTasks);
	const doneColumn = boardColumn(columns, "done");
	const hudColumns = {
		rejected: columns.find((column) => column.id === "rejected") ?? {
			id: "rejected" as const,
			label: "Rejected",
			tasks: [],
		},
		ready: boardColumn(columns, "ready"),
		blocked: boardColumn(columns, "blocked"),
		in_progress: boardColumn(columns, "in_progress"),
		in_review: boardColumn(columns, "in_review"),
		done: withDoneRecencyOrder({
			...doneColumn,
			tasks: doneColumn.tasks.filter((task) => isAssignedToCurrentSession(task, display)),
		}),
	};
	const parts = taskHudSummary(hudColumns);
	const summaryLine = truncateLine(
		`${theme.fg("mdHeading", "●")} ${theme.fg("mdHeading", `${visibleTasks.length} tasks`)} ${theme.fg("muted", `(${parts.join(", ")})`)}`,
		width,
	);
	if (options.hideKanban) return [...guardLines, summaryLine];
	const lines: string[] = [];
	const byId = new Map(hudTasks.map((item) => [item.id, item]));
	if (options.expandedEpicKey) {
		const group = groups.find((candidate) => candidate.key === options.expandedEpicKey);
		if (!group) return [...guardLines, summaryLine];
		lines.push(
			...renderColumnarHudGroup(
				group,
				theme,
				width,
				maxTasks,
				byId,
				display,
				now,
				options.flashTaskIds,
				options.flashTasks,
			),
		);
		return [...guardLines, ...(lines.length > 0 ? lines : [summaryLine])].map((line) => truncateLine(line, width));
	}
	const activeEpicKeys = new Set(
		hudTasks
			.filter((task) => taskEpicKey(task) && isActiveCurrentSessionEpicTask(task, display))
			.map((task) => {
				const label = taskEpicKey(task);
				return groups.some((group) => group.key === label) ? label : `unknown:${label}`;
			}),
	);
	if (activeEpicKeys.size === 0) {
		for (const group of groups) {
			lines.push(renderHudEpicSummary(group, theme, width));
		}
		return [...guardLines, ...lines].map((line) => truncateLine(line, width));
	}
	for (const group of groups.filter((group) => activeEpicKeys.has(group.key))) {
		if (lines.length > 0) lines.push(theme.fg("borderMuted", "─".repeat(width)));
		lines.push(
			...renderColumnarHudGroup(
				group,
				theme,
				width,
				maxTasks,
				byId,
				display,
				now,
				options.flashTaskIds,
				options.flashTasks,
			),
		);
	}
	return [...guardLines, ...lines].map((line) => truncateLine(line, width));
}

interface RatatuiTaskTuiResponse {
	request_id: number;
	lines?: string[];
	selected_task_id?: string | null;
	mutation?: { action: "update" | "delete"; params: Record<string, unknown> };
	editing?: boolean;
}

class RatatuiTaskBoardOverlay implements Component {
	private tasks: TaskRecord[];
	private selectedTaskId?: string;
	private lines: string[] = [];
	private requestId = 0;
	private pending = new Map<number, Promise<void>>();
	private resolvePending = new Map<number, () => void>();
	private pendingMutation?: Promise<void>;
	private child?: ChildProcessWithoutNullStreams;
	private errorMessage?: string;
	private editing = false;

	constructor(
		private readonly options: {
			tasks: TaskRecord[];
			theme: Theme;
			keybindings?: TaskBoardKeybindings;
			command: string;
			cwd: string;
			initialTaskId?: string;
			onClose: () => void;
			onMutate?: (action: "update" | "delete", params: Record<string, unknown>) => Promise<TaskRecord[]>;
			onChange?: () => void;
		},
	) {
		this.tasks = options.tasks;
		this.selectedTaskId = options.initialTaskId;
		this.lines = [options.theme.fg("dim", "Loading task TUI…")];
		this.start();
		this.send({ tasks: this.tasks });
	}

	waitForIdle(): Promise<void> {
		return Promise.all([...this.pending.values(), this.pendingMutation].filter(Boolean)).then(() => {});
	}

	render(width: number): string[] {
		const lines = this.errorMessage ? [...this.lines, this.options.theme.fg("error", this.errorMessage)] : this.lines;
		return lines.map((line) => truncateLine(line, Math.max(20, width)));
	}

	handleInput(data: string): void {
		const bindings = this.options.keybindings ?? defaultConfig.keybindings;
		if (data === "q" || (matchesAnyKey(data, bindings.close) && data !== "escape")) {
			this.close();
			this.options.onClose();
			return;
		}
		if (this.pendingMutation) return;
		if (this.editing) {
			this.send({ input: this.ratatuiInput(data) });
			return;
		}
		if (matchesAnyKey(data, bindings.left) || matchesAnyKey(data, bindings.up)) {
			this.send({ input: matchesAnyKey(data, bindings.left) ? "left" : "up" });
			return;
		}
		if (matchesAnyKey(data, bindings.right) || matchesAnyKey(data, bindings.down)) {
			this.send({ input: matchesAnyKey(data, bindings.right) ? "right" : "down" });
			return;
		}
		const task = this.currentTask();
		if (!task) return;
		if (data === "e") {
			this.send({ input: "e" });
			return;
		}
		if (matchesAnyKey(data, bindings.assignCurrent)) {
			this.mutate("update", { id: task.id, assigned_to: "current" });
			return;
		}
		if (matchesAnyKey(data, bindings.clearAssignee)) {
			this.mutate("update", { id: task.id, clear_assignee: true });
			return;
		}
		if (matchesAnyKey(data, bindings.priorityUp)) {
			this.mutate("update", { id: task.id, priority: priority(task) + 1 });
			return;
		}
		if (matchesAnyKey(data, bindings.priorityDown)) {
			this.mutate("update", { id: task.id, priority: priority(task) - 1 });
			return;
		}
		if (matchesAnyKey(data, bindings.done)) {
			this.mutate("update", { id: task.id, status: doneKeyStatus(task) });
			return;
		}
		if (matchesAnyKey(data, bindings.cancel)) {
			this.mutate("update", { id: task.id, status: "canceled" });
			return;
		}
		if (matchesAnyKey(data, bindings.cycleStatus)) {
			const byId = new Map(this.tasks.map((item) => [item.id, item]));
			if (!hasOpenDependencies(task, byId, taskChildren(this.tasks))) {
				this.mutate("update", { id: task.id, status: nextCycledStatus(task) });
			}
			return;
		}
		if (matchesAnyKey(data, bindings.reload)) {
			this.send({ tasks: this.tasks });
			return;
		}
		this.send({ input: this.ratatuiInput(data) });
	}

	invalidate(): void {}

	private start(): void {
		this.child = spawn(this.options.command, ["task", "tui", "--embed"], {
			cwd: this.options.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		createInterface({ input: this.child.stdout }).on("line", (line) => this.handleBridgeLine(line));
		this.child.stderr.on("data", (chunk) => {
			const text = Buffer.from(chunk).toString("utf8").trim();
			if (text) this.errorMessage = text;
			this.options.onChange?.();
		});
		this.child.on("error", (error) => {
			this.errorMessage = error.message;
			this.options.onChange?.();
		});
	}

	private send(payload: { input?: string; tasks?: TaskRecord[] }): void {
		const child = this.child;
		if (!child || child.killed) return;
		const requestId = ++this.requestId;
		const promise = new Promise<void>((resolve) => this.resolvePending.set(requestId, resolve));
		this.pending.set(requestId, promise);
		const request = {
			request_id: requestId,
			width: 120,
			height: 40,
			selected_task_id: this.selectedTaskId,
			...payload,
		};
		child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
			if (error) {
				this.errorMessage = error.message;
				this.resolveRequest(requestId);
				this.options.onChange?.();
			}
		});
	}

	private handleBridgeLine(line: string): void {
		const payload = JSON.parse(line) as RatatuiTaskTuiResponse;
		if (payload.lines) this.lines = payload.lines;
		this.selectedTaskId = payload.selected_task_id ?? undefined;
		this.editing = Boolean(payload.editing);
		this.resolveRequest(payload.request_id);
		this.options.onChange?.();
		if (payload.mutation) this.mutate(payload.mutation.action, payload.mutation.params);
	}

	private ratatuiInput(data: string): string {
		return matchesKey(data, "ctrl+g")
			? "ctrl-g"
			: matchesKey(data, "ctrl+s")
				? "ctrl-s"
				: matchesKey(data, "ctrl+a")
					? "ctrl-a"
					: matchesKey(data, "ctrl+e")
						? "ctrl-e"
						: matchesKey(data, "ctrl+b")
							? "ctrl-b"
							: matchesKey(data, "ctrl+f")
								? "ctrl-f"
								: matchesKey(data, "ctrl+d")
									? "ctrl-d"
									: matchesKey(data, "ctrl+k")
										? "ctrl-k"
										: matchesKey(data, "ctrl+u")
											? "ctrl-u"
											: matchesKey(data, "ctrl+p")
												? "ctrl-p"
												: matchesKey(data, "ctrl+n")
													? "ctrl-n"
													: matchesKey(data, "up")
														? "up"
														: matchesKey(data, "down")
															? "down"
															: matchesKey(data, "left")
																? "left"
																: matchesKey(data, "right")
																	? "right"
																	: data === "escape"
																		? "esc"
																		: data === "\r"
																			? "\n"
																			: data;
	}

	private resolveRequest(requestId: number): void {
		this.resolvePending.get(requestId)?.();
		this.resolvePending.delete(requestId);
		this.pending.delete(requestId);
	}

	private currentTask(): TaskRecord | undefined {
		return this.tasks.find((task) => task.id === this.selectedTaskId) ?? this.tasks.find((task) => !isCanceled(task));
	}

	private mutate(action: "update" | "delete", params: Record<string, unknown>): void {
		if (!this.options.onMutate) return;
		this.pendingMutation = this.options
			.onMutate(action, params)
			.then((tasks) => {
				this.tasks = tasks;
				this.send({ tasks });
			})
			.catch((error) => {
				this.errorMessage = taskBoardErrorMessage(`${action === "delete" ? "Delete" : "Update"} failed`, error);
			})
			.finally(() => {
				this.pendingMutation = undefined;
				this.options.onChange?.();
			});
	}

	private close(): void {
		this.child?.kill();
	}
}

class EmptyTaskRender implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const emptyTaskRender = new EmptyTaskRender();

const taskReadActions = new Set<TaskCommand>(["list", "show"]);
const taskWriteActions = new Set<TaskCommand>(["add", "update", "delete", "accept", "reject"]);

function taskReadAction(params: Record<string, unknown>): TaskCommand {
	const mode = String(params.mode ?? (params.id ? "show" : "list"));
	if (!taskReadActions.has(mode as TaskCommand)) throw new Error("task_read mode must be 'list' or 'show'");
	if (mode === "show" && typeof params.id !== "string") throw new Error("task_read mode 'show' requires id");
	return mode as TaskCommand;
}

function taskWriteAction(params: Record<string, unknown>): TaskCommand {
	const op = String(params.op ?? "");
	if (!taskWriteActions.has(op as TaskCommand)) {
		throw new Error("task_write op must be add, update, delete, accept, or reject");
	}
	const data = objectParam(params.data);
	if (op === "add" && typeof params.title !== "string" && typeof data.title !== "string") {
		throw new Error("task_write op 'add' requires title");
	}
	if (op !== "add" && typeof params.id !== "string") throw new Error(`task_write op '${op}' requires id`);
	if (op === "reject" && typeof params.note !== "string") throw new Error("task_write op 'reject' requires note");
	return op as TaskCommand;
}

function objectParam(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeTaskWriteParams(params: Record<string, unknown>): Record<string, unknown> {
	const data = objectParam(params.data);
	const clear = new Set(Array.isArray(params.clear) ? params.clear.filter((item) => typeof item === "string") : []);
	return {
		...data,
		...params,
		title: params.title ?? data.title,
		clear_assignee: params.clear_assignee === true || clear.has("assignee"),
		clear_epic: params.clear_epic === true || clear.has("epic"),
		clear_parent: params.clear_parent === true || clear.has("parent"),
		clear_blockers: params.clear_blockers === true || clear.has("blockers"),
	};
}

function isStoryTaskType(value: unknown): boolean {
	return value === "feature" || value === "bug";
}

async function loadTaskForWriteGuard(
	command: string,
	runCommand: typeof defaultRunCommand,
	cwd: string,
	id: unknown,
	signal?: AbortSignal,
): Promise<TaskRecord | undefined> {
	if (typeof id !== "string" || id.length === 0) return undefined;
	const result = await runCommand(command, ["task", "show", id, "--json"], cwd, signal);
	try {
		return (JSON.parse(result.stdout || "{}") as { task?: TaskRecord }).task;
	} catch {
		return undefined;
	}
}

async function guardAgentTaskWrite(
	action: TaskCommand,
	params: Record<string, unknown>,
	command: string,
	runCommand: typeof defaultRunCommand,
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	if (action === "accept")
		throw new Error("Agents cannot accept tasks; use the human /accept command after delivery.");
	if (action === "reject")
		throw new Error("Agents cannot reject tasks; use the human /reject command for story feedback.");
	if (action !== "update" || params.status !== "done") return;
	const resolvedType =
		typeof params.type === "string"
			? params.type
			: await loadTaskForWriteGuard(command, runCommand, cwd, params.id, signal).then((task) => task?.type);
	if (isStoryTaskType(resolvedType)) {
		throw new Error(
			"Agents cannot mark feature or bug tasks done; deliver reviewed commits to in_review for human acceptance.",
		);
	}
}

function makeCombinedTaskTool(
	resolveAction: (params: Record<string, unknown>) => TaskCommand,
	command: string,
	runCommand: typeof defaultRunCommand,
	config: Config,
	pi: ExtensionAPI,
	getCwd: () => string,
	onProgress?: () => void,
	normalizeParams: (params: Record<string, unknown>) => Record<string, unknown> = (params) => params,
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
			const action = resolveAction(params);
			const normalizedParams = normalizeParams(params);
			if (resolveAction === taskWriteAction) {
				await guardAgentTaskWrite(action, normalizedParams, command, runCommand, getCwd(), signal);
			}
			const result = await executeTask(
				command,
				runCommand,
				getCwd(),
				action,
				normalizedParams,
				config,
				pi,
				ctx,
				signal,
			);
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

type TaskGuardActionKind = "continue" | "revise" | "start" | "claim" | "fix_dependency" | "close_parent";

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
	return (
		isActiveTask(task) &&
		task.status !== "in_progress" &&
		task.status !== "in_review" &&
		!hasUnresolvedDependencies(task, byId, children)
	);
}

function hasReviewLifecycle(task: TaskRecord): boolean {
	return task.type === "feature" || task.type === "bug";
}

function nextCycledStatus(task: TaskRecord): string {
	if (hasReviewLifecycle(task)) {
		if (task.status === "rejected") return "in_progress";
		if (task.status === "in_progress") return "in_review";
		if (task.status === "in_review") return "open";
		return "in_progress";
	}
	return task.status === "in_progress" ? "done" : isComplete(task) ? "open" : "in_progress";
}

function doneKeyStatus(task: TaskRecord): string {
	return hasReviewLifecycle(task) ? "in_review" : "done";
}

function isAssignedTo(assignment: string, task: TaskRecord): boolean {
	return task.assigned_to === assignment;
}

function isUnassigned(task: TaskRecord): boolean {
	return !task.assigned_to;
}

function isGuardWorkTask(task: TaskRecord): boolean {
	return task.type !== "epic";
}

function sortedActive(tasks: TaskRecord[], byId: Map<string, TaskRecord>): TaskRecord[] {
	return sortTasksForDisplay(tasks.filter(isActiveTask), byId);
}

function sortedGuardTasks(tasks: TaskRecord[], byId: Map<string, TaskRecord>): TaskRecord[] {
	return sortedActive(tasks, byId).sort((left, right) => guardStatusRank(left) - guardStatusRank(right));
}

function guardStatusRank(task: TaskRecord): number {
	switch (task.status) {
		case "in_progress":
			return 0;
		case "rejected":
			return 1;
		case "in_review":
			return 3;
		default:
			return 2;
	}
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
			if (isGuardWorkTask(dependency) && dependency.status === "in_progress") {
				return { kind: "continue", task: dependency, source: task };
			}
			const nested = selectDependencyAction(dependency, assignedTo, byId, children, seen);
			if (nested) return nested;
			if (isGuardWorkTask(dependency) && isReadyForWork(dependency, byId, children)) {
				return { kind: "start", task: dependency, source: task };
			}
			continue;
		}
		if (isUnassigned(dependency)) {
			const nested = selectDependencyAction(dependency, assignedTo, byId, children, seen);
			if (nested) return nested;
			if (isGuardWorkTask(dependency) && isReadyForWork(dependency, byId, children)) {
				return { kind: "claim", task: dependency, source: task };
			}
		}
	}
	return undefined;
}

function selectGuardAction(
	tasks: TaskRecord[],
	assignedTo: string,
	preferredEpicId?: string | null,
): TaskGuardAction | undefined {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const children = taskChildren(tasks);
	const assigned = sortedGuardTasks(
		tasks.filter((task) => isAssignedTo(assignedTo, task)),
		byId,
	);
	if (assigned.length === 0 && !preferredEpicId) return undefined;
	for (const task of assigned) {
		const action = selectDependencyAction(task, assignedTo, byId, children);
		if (action) return action;
	}
	const inProgress = assigned.find(
		(task) =>
			isGuardWorkTask(task) && task.status === "in_progress" && !hasUnresolvedDependencies(task, byId, children),
	);
	if (inProgress) return { kind: "continue", task: inProgress };
	const rejected = assigned.find(
		(task) => isGuardWorkTask(task) && task.status === "rejected" && !hasUnresolvedDependencies(task, byId, children),
	);
	if (rejected) return { kind: "revise", task: rejected };
	const assignedReady = assigned.find(
		(task) =>
			isGuardWorkTask(task) && isReadyForWork(task, byId, children) && (children.get(task.id)?.length ?? 0) === 0,
	);
	if (assignedReady) return { kind: "start", task: assignedReady };
	const epicIds = new Set(assigned.map((task) => task.epic_id).filter((id): id is string => Boolean(id)));
	if (preferredEpicId) epicIds.add(preferredEpicId);
	const sameEpicReady = sortedGuardTasks(
		tasks.filter(
			(task) =>
				isGuardWorkTask(task) &&
				isUnassigned(task) &&
				task.epic_id &&
				epicIds.has(task.epic_id) &&
				isReadyForWork(task, byId, children),
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
		case "revise": {
			const note = latestRejectionNote(action.task);
			return note
				? `Revise rejected task ${action.task.id}${source}: ${action.task.title}.\nRejection note: ${note}`
				: `Revise rejected task ${action.task.id}${source}: ${action.task.title}.`;
		}
		case "start":
			return `Start assigned task ${action.task.id}${source}: ${action.task.title}.`;
		case "claim":
			return `Claim task ${action.task.id}${source}: ${action.task.title}.`;
		case "fix_dependency":
			return `Fix invalid blocker ${action.invalidBlocker} on task ${action.task.id}: update blocked_by or choose a replacement blocker.`;
		case "close_parent":
			return `Verify acceptance for parent ${action.task.id} and mark it done; all child tasks are terminal.`;
	}
}

function guardContent(action: TaskGuardAction): string {
	return [
		"Task nudge: this session has a ready next step.",
		"",
		`Suggested next step: ${guardInstruction(action)}`,
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
	return /\b(assign|assigned|implement|continue|start|work|proceed|resume|finish|complete|done|fix)\b/i.test(text);
}

function shouldTriggerGuardTurn(state: GuardState, decision: TaskGuardDecision): boolean {
	if (!userTextAllowsGuardAutoTurn(state.lastUserText)) return false;
	if (state.autoLoopTaskId !== decision.action.task.id || state.lastGuardProgressSerial !== state.progressSerial) {
		state.autoLoopTaskId = decision.action.task.id;
		state.autoLoopTurns = 0;
	}
	if (state.autoLoopTurns >= maxGuardAutoTurnsWithoutProgress) return false;
	state.autoLoopTurns++;
	return true;
}

async function evaluateTaskGuard(
	ctx: ExtensionContext,
	command: string,
	runCommand: typeof defaultRunCommand,
	state: GuardState,
	preferredEpicId?: string | null,
): Promise<TaskGuardDecision | undefined> {
	const assignedTo = sessionAssignment(ctx);
	if (!assignedTo) return undefined;
	const tasks = await loadHudTasks(ctx.cwd, command, runCommand, ctx.signal);
	const action = selectGuardAction(tasks, assignedTo, preferredEpicId);
	if (!action) {
		state.lastGuardFingerprint = undefined;
		state.lastGuardProgressSerial = undefined;
		return undefined;
	}
	const fingerprint = guardFingerprint(tasks, action, assignedTo);
	return {
		kind: "continue",
		fingerprint,
		action,
		content: guardContent(action),
	};
}

async function sendTaskGuard(pi: ExtensionAPI, state: GuardState, force = false): Promise<void> {
	const pending = state.pending;
	state.pending = undefined;
	if (!pending || (!state.enabled && !force)) return;
	const decision: TaskGuardDecision | undefined = pending;
	if (!decision) return;
	if (!userTextAllowsGuardAutoTurn(state.lastUserText)) {
		state.lastUserText = undefined;
		return;
	}
	const triggerTurn = shouldTriggerGuardTurn(state, decision);
	state.lastGuardFingerprint = decision.fingerprint;
	state.lastGuardProgressSerial = state.progressSerial;
	pi.sendMessage(
		{
			customType: "task-guard",
			content: [{ type: "text", text: decision.content }],
			display: true,
			details: { action: decision.action.kind, taskId: decision.action.task.id },
		},
		triggerTurn ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "followUp" },
	);
	state.lastUserText = undefined;
}

async function triggerTaskGuardAfterCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	runCommand: typeof defaultRunCommand,
	state: GuardState,
	task?: TaskRecord,
): Promise<void> {
	state.pending = await evaluateTaskGuard(ctx, command, runCommand, state, task?.epic_id);
	await sendTaskGuard(pi, state, true);
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

export default function tasksExtension(pi: ExtensionAPI, runtime: Runtime = {}) {
	const config = loadConfig();
	if (!config.enabled) return;
	installSilentTaskToolRenderPatch();
	activeTaskBoard = undefined;
	taskHudExpandedEpicKey = undefined;
	taskHudWidget = undefined;
	taskHudWidgetCtx = undefined;
	latestTaskHudState = undefined;
	requestTaskHudRender = undefined;

	const runCommand = runtime.runCommand ?? defaultRunCommand;
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
			await updateTaskHud(ctx, pi, config.command, runCommand, config, guardState.enabled).catch((error) => {
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
		taskHudExpandedEpicKey = undefined;
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
		let decision: TaskGuardDecision | undefined;
		try {
			decision = await evaluateTaskGuard(ctx, config.command, runCommand, guardState);
		} catch (error) {
			guardState.pending = undefined;
			ctx.ui.notify?.(`Task guard failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return undefined;
		}
		guardState.pending = decision;
		return undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		await sendTaskGuard(pi, guardState).catch((error) => {
			ctx.ui.notify?.(`Task guard failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
	});

	pi.registerCommand?.("tasks", {
		description: "Open project task board; pass a task id to focus it",
		handler: async (args: string, ctx: ExtensionContext) => {
			const initialTaskId = args.trim().split(/\s+/).filter(Boolean)[0];
			await showTaskBoard(ctx, pi, config.command, runCommand, config, initialTaskId).catch((error) => {
				ctx.ui.notify?.(`Task board failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
		},
	});

	pi.registerCommand?.("task-guard", {
		description: "Show task guard status; use [on/off] to change it",
		handler: async (args: string, ctx: ExtensionContext) => {
			const result = taskGuardCommandMessage(guardState, args);
			const mode = args.trim().toLowerCase();
			if (mode === "on" || mode === "off") writeTaskGuardPreference(ctx, guardState.enabled);
			ctx.ui.notify?.(result.message, result.type);
		},
	});

	pi.registerCommand?.("accept", {
		description: "Accept an in-review task",
		handler: async (args: string, ctx: ExtensionContext) => {
			const [id, ...noteParts] = args.trim().split(/\s+/).filter(Boolean);
			const note = noteParts.join(" ");
			if (!id) {
				ctx.ui.notify?.("Usage: /accept <task-id> [note...]", "warning");
				return;
			}
			await executeTask(config.command, runCommand, ctx.cwd, "accept", { id }, config, pi, ctx, ctx.signal)
				.then((result) => {
					publishTaskTransition(pi, ctx, "accept", result.details.task, note || undefined);
					markProgress();
					if (note) return undefined;
					return triggerTaskGuardAfterCommand(
						pi,
						ctx,
						config.command,
						runCommand,
						guardState,
						result.details.task,
					);
				})
				.catch((error) => {
					ctx.ui.notify?.(
						`Task accept failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				});
		},
	});

	pi.registerCommand?.("reject", {
		description: "Reject an in-review task with a note",
		handler: async (args: string, ctx: ExtensionContext) => {
			const [id, ...noteParts] = args.trim().split(/\s+/).filter(Boolean);
			const note = noteParts.join(" ");
			if (!id || !note) {
				ctx.ui.notify?.("Usage: /reject <task-id> <note...>", "warning");
				return;
			}
			await executeTask(config.command, runCommand, ctx.cwd, "reject", { id, note }, config, pi, ctx, ctx.signal)
				.then((result) => {
					publishTaskTransition(pi, ctx, "reject", result.details.task, note);
					markProgress();
					if (note) return undefined;
					return triggerTaskGuardAfterCommand(
						pi,
						ctx,
						config.command,
						runCommand,
						guardState,
						result.details.task,
					);
				})
				.catch((error) => {
					ctx.ui.notify?.(
						`Task reject failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				});
		},
	});

	pi.registerShortcut?.(config.hud.toggleShortcut, {
		description: "Cycle project task HUD compact/epic view",
		handler: async (ctx: ExtensionContext) => {
			const tasks =
				(taskHudWidgetCtx === ctx ? latestTaskHudState?.tasks : undefined) ??
				(await loadHudTasks(ctx.cwd, config.command, runCommand, ctx.signal).catch(() => []));
			cycleTaskHudExpandedEpic(tasks);
			await updateTaskHud(ctx, pi, config.command, runCommand, config, undefined, ctx.signal, tasks).catch(
				(error) => {
					ctx.ui.notify?.(
						`Task HUD refresh failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				},
			);
		},
	});

	pi.registerTool({
		...makeCombinedTaskTool(taskReadAction, config.command, runCommand, config, pi, getCwd, markProgress),
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
			epic_id: Type.Optional(Type.String({ description: "List filter" })),
			assigned_to: Type.Optional(Type.String({ description: "List filter, or 'current'" })),
			all: Type.Optional(Type.Boolean({ description: "Include completed/canceled tasks" })),
		}),
	});

	pi.registerTool({
		...makeCombinedTaskTool(
			taskWriteAction,
			config.command,
			runCommand,
			config,
			pi,
			getCwd,
			markProgress,
			normalizeTaskWriteParams,
		),
		name: "task_write",
		label: "Write Tasks",
		description:
			"Add/update/delete/accept/reject tasks. Put fields in data: type, body, status, priority, assigned_to ('current' ok), epic_id, epic_title, labels, parent_id, blocked_by. Use clear for assignee/epic/parent/blockers.",
		promptSnippet: "Write project tasks",
		parameters: Type.Object({
			op: Type.String({ description: "add, update, delete, accept, or reject" }),
			id: Type.Optional(Type.String({ description: "Task ID/prefix; required except add" })),
			title: Type.Optional(Type.String({ description: "Add title shorthand" })),
			data: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "Add/update fields, e.g. status/priority/assigned_to/epic_id/labels/blocked_by",
				}),
			),
			clear: Type.Optional(Type.Array(Type.String(), { description: "assignee, epic, parent, blockers" })),
			note: Type.Optional(Type.String({ description: "Reject note" })),
		}),
	});
}
