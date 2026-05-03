import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { runCommand as defaultRunCommand } from "../shared/ct-runner";

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
let activeTaskBoard: { close: () => void } | undefined;
let taskHudKanbanHidden = false;

const defaultConfig: Config = {
	enabled: true,
	command: "ct",
	hud: {
		enabled: true,
		maxTasks: 6,
		minTerminalRows: 28,
		toggleShortcut: "ctrl+i",
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

function terminalRows(): number | undefined {
	const rows = process.stdout?.rows;
	return typeof rows === "number" && Number.isFinite(rows) ? rows : undefined;
}

function hasEnoughRows(minRows: number): boolean {
	const rows = terminalRows();
	return rows === undefined || rows >= minRows;
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
	const display = assignmentDisplayContext(pi, ctx, tasks);
	ctx.ui.setWidget(
		widgetId,
		(_tui, theme) => ({
			render: (width: number) =>
				hasEnoughRows(config.hud.minTerminalRows)
					? renderHudLines(tasks, theme, width, config.hud.maxTasks, display, {
							hideKanban: taskHudKanbanHidden,
						})
					: [],
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
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

function strikethrough(theme: Theme, text: string): string {
	const maybeTheme = theme as Theme & {
		strikethrough?: (value: string) => string;
	};
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

function sortTasksForDisplay(tasks: TaskRecord[], blockersById?: Map<string, TaskRecord>): TaskRecord[] {
	const byId = blockersById ?? new Map(tasks.map((task) => [task.id, task]));
	return [...tasks].sort((left, right) => {
		const leftBlocked = hasOpenBlockers(left, byId);
		const rightBlocked = hasOpenBlockers(right, byId);
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
	return [
		{
			id: "ready",
			label: "Ready",
			tasks: sortTasksForDisplay(
				active.filter((task) => isBoardReady(task) && !hasOpenBlockers(task, byId)),
				byId,
			),
		},
		{
			id: "blocked",
			label: "Blocked",
			tasks: sortTasksForDisplay(
				active.filter((task) => isBoardReady(task) && hasOpenBlockers(task, byId)),
				byId,
			),
		},
		{
			id: "in_progress",
			label: "In Progress",
			tasks: sortTasksForDisplay(
				active.filter((task) => task.status === "in_progress"),
				byId,
			),
		},
		{
			id: "done",
			label: "Done",
			tasks: sortTasksForDisplay(active.filter(isComplete), byId),
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

function padToVisibleWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, width);
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
	return truncateToWidth(theme.fg("borderAccent", `${left}${label}${fill.repeat(fillCount)}${right}`), width);
}

function boxedTaskBoard(theme: Theme, width: number, lines: string[]): string[] {
	const safeWidth = Math.max(20, width);
	const innerWidth = Math.max(1, safeWidth - 4);
	return [
		borderLine(theme, safeWidth, "╭", "─", "╮", "Tasks"),
		...lines.map((line) => {
			const inner = padToVisibleWidth(line, innerWidth);
			return truncateToWidth(
				`${theme.fg("borderAccent", "│")} ${inner} ${theme.fg("borderAccent", "│")}`,
				safeWidth,
			);
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

function taskHudSummary(tasks: TaskRecord[], columns: Record<TaskBoardColumn["id"], TaskBoardColumn>): string[] {
	const parts: string[] = [];
	if (columns.ready.tasks.length > 0) parts.push(`${columns.ready.tasks.length} ready`);
	if (columns.blocked.tasks.length > 0) parts.push(`${columns.blocked.tasks.length} blocked`);
	const done = tasks.filter(isComplete).length;
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
): string {
	const blockers = openBlockers(task, byId);
	const assignee = formatAssignee(task, theme, display);
	const meta = [
		priority(task) !== 0 ? ` p${priority(task)}` : "",
		blockers.length > 0 ? ` ←${blockers.length}` : "",
	].join("");
	const titleColor = column.id === "done" || isAssignedToOtherSession(task, display) ? "dim" : "text";
	const card = `${theme.fg(statusColor(task.status), statusGlyph(task.status))} ${formatTaskId(task.id, theme)} ${theme.fg(titleColor, compact(task.title, Math.max(8, width - 16)))}${assignee}${theme.fg("dim", meta)}`;
	return padToVisibleWidth(` ${padToVisibleWidth(card, width)}`, width + 2);
}

function renderHudSection(
	column: TaskBoardColumn,
	theme: Theme,
	width: number,
	rows: number,
	byId: Map<string, TaskRecord>,
	display: AssignmentDisplayContext,
): string[] {
	const hidden = Math.max(0, column.tasks.length - rows);
	const lines = [shelfHeader(theme, column, width, hidden)];
	const cardWidth = Math.max(1, width - 2);
	for (let row = 0; row < rows; row++) {
		const task = column.tasks[row];
		lines.push(task ? renderHudTaskCard(task, column, theme, cardWidth, byId, display) : shelfEmptyLine(width));
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
		`${theme.fg("dim", "Blocks:")} ${blocked.join(", ") || "none"}`,
		`Created: ${formatBoardTime(task.created_at)}   Updated: ${formatBoardTime(task.updated_at)}`,
		...(task.body.trim() ? ["", task.body.trim()] : []),
	];
	return raw.flatMap((line) => wrapTextWithAnsi(line, width)).map((line) => truncateToWidth(line, width));
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
		truncateToWidth(`${theme.fg("mdHeading", "Tasks")} ${theme.fg("dim", taskBoardHelp(bindings))}`, innerWidth),
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
						? theme.bg("selectedBg", theme.fg("text", label))
						: theme.fg("text", label);
				}),
				widths,
			),
		);
	}
	lines.push("");
	lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(innerWidth)), innerWidth));
	lines.push(theme.fg("mdHeading", "Details"));
	lines.push("");
	const task = selectedTask(columns, clamped);
	if (task) {
		lines.push(...detailLines(task, tasks, theme, innerWidth));
	} else {
		lines.push(truncateToWidth(theme.fg("dim", "No task selected"), innerWidth));
	}
	return boxedTaskBoard(
		theme,
		safeWidth,
		lines.map((line) => truncateToWidth(line, innerWidth)),
	);
}

export class TaskBoardOverlay implements Component {
	private tasks: TaskRecord[];
	private boardSelection: TaskBoardSelection = { column: 0, row: 0 };
	private pendingReload?: Promise<void>;
	private pendingMutation?: Promise<void>;
	private confirmingDeleteId?: string;

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
		this.pendingReload = this.options
			.onReload()
			.then((tasks) => {
				this.tasks = tasks;
				this.preserveSelection(taskId);
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
		this.pendingMutation = this.options
			.onMutate(action, params)
			.then((tasks) => {
				this.tasks = tasks;
				this.preserveSelection(taskId);
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
				truncateToWidth(this.options.theme.fg("warning", `Confirm delete ${this.confirmingDeleteId}? y/N`), width),
			);
		}
		return [...prefix, ...lines];
	}

	invalidate(): void {}
}

type AssignmentDisplayContext = {
	currentAssignment?: string;
	currentLabel?: string;
	labels?: Map<string, string>;
};

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
	return assignedTo.startsWith("session:") ? assignedTo.slice("session:".length) : undefined;
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
	const path = join(dirname(currentFile), `${id}.jsonl`);
	return existsSync(path) ? sessionNameFromFile(path) : undefined;
}

function assignmentDisplayContext(
	pi?: ExtensionAPI,
	ctx?: ExtensionContext,
	tasks: TaskRecord[] = [],
): AssignmentDisplayContext {
	const currentAssignment = sessionAssignment(ctx);
	const currentLabel = sessionName(pi, ctx);
	const labels = new Map<string, string>();
	if (currentAssignment && currentLabel) labels.set(currentAssignment, currentLabel);
	for (const task of tasks) {
		const assignedTo = task.assigned_to;
		if (!assignedTo || labels.has(assignedTo)) continue;
		const label = sessionNameForAssignment(ctx, assignedTo);
		if (label) labels.set(assignedTo, label);
	}
	return {
		currentAssignment,
		currentLabel,
		labels,
	};
}

function assignmentLabel(task: TaskRecord, display: AssignmentDisplayContext = {}): string | undefined {
	const assignedTo = task.assigned_to;
	if (!assignedTo) return undefined;
	if (assignedTo === display.currentAssignment && display.currentLabel) return display.currentLabel;
	const label = display.labels?.get(assignedTo);
	if (label) return label;
	if (task.assigned_label) return task.assigned_label;
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

function formatTaskLine(
	task: TaskRecord,
	theme: Theme,
	width: number,
	byId: Map<string, TaskRecord>,
	display: AssignmentDisplayContext = {},
): string {
	const blockers = openBlockers(task, byId);
	const glyph = theme.fg(statusColor(task.status), statusGlyph(task.status));
	const id = formatTaskId(task.id, theme);
	const blockerText = blockers.join(", ");
	const assignee = formatAssignee(task, theme, display);
	const titleColor = isAssignedToOtherSession(task, display) ? "muted" : "text";
	const title = isComplete(task)
		? theme.fg("dim", strikethrough(theme, `${task.id.padEnd(4)} ${compact(task.title, Math.max(20, width - 18))}`))
		: theme.fg(titleColor, compact(task.title, Math.max(20, width - 18)));
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
	options: { hideKanban?: boolean } = {},
): string[] {
	const visibleTasks = tasks.filter((task) => !isCanceled(task));
	if (visibleTasks.length === 0) return [];
	const columns = buildTaskBoardColumns(visibleTasks);
	const hudColumns = {
		ready: boardColumn(columns, "ready"),
		blocked: boardColumn(columns, "blocked"),
		in_progress: boardColumn(columns, "in_progress"),
		done: withDoneRecencyOrder(boardColumn(columns, "done")),
	};
	const shownColumns = [hudColumns.ready, hudColumns.in_progress, hudColumns.done];
	const widths = splitWidths(width, shownColumns.length);
	const parts = taskHudSummary(visibleTasks, hudColumns);
	const lines = [
		truncateToWidth(
			`${theme.fg("mdHeading", "●")} ${theme.fg("mdHeading", `${visibleTasks.length} tasks`)} ${theme.fg("muted", `(${parts.join(", ")})`)}`,
			width,
		),
	];
	if (options.hideKanban) return lines;
	const byId = new Map(visibleTasks.map((item) => [item.id, item]));
	const renderedColumns = [
		[
			...renderHudSection(
				hudColumns.ready,
				theme,
				widths[0] ?? width,
				hudColumnRows(hudColumns.ready, maxTasks),
				byId,
				display,
			),
			...(hudColumns.blocked.tasks.length > 0
				? renderHudSection(
						hudColumns.blocked,
						theme,
						widths[0] ?? width,
						hudColumnRows(hudColumns.blocked, maxTasks),
						byId,
						display,
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
		),
		renderHudSection(
			hudColumns.done,
			theme,
			widths[2] ?? width,
			hudColumnRows(hudColumns.done, maxTasks),
			byId,
			display,
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
	return lines.map((line) => truncateToWidth(line, width));
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

function assignedTaskReminder(
	tasks: TaskRecord[],
	assignedTo: string,
	display: AssignmentDisplayContext = {},
): string | undefined {
	const assigned = sortTasksForDisplay(
		tasks.filter((task) => isActiveTask(task) && task.assigned_to === assignedTo),
	).slice(0, 8);
	if (assigned.length === 0) return undefined;
	const label = assignmentLabel({ ...assigned[0], assigned_to: assignedTo }, display) ?? assignedTo;
	const lines = [
		`You have ${assigned.length} assigned task${assigned.length === 1 ? "" : "s"} still open for @${label}:`,
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
	const reminder = assignedTaskReminder(tasks, assignedTo, assignmentDisplayContext(pi, ctx, tasks));
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

	pi.registerShortcut?.(config.keybindings.toggle, {
		description: "Open project task board",
		handler: async (ctx: ExtensionContext) => {
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
