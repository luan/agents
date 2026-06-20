import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { checkboxGlyphs, framedBlock, renderStatusLine, textComponent } from "../shared/tui/omp-card";
import { getActiveSubagentDescriptions } from "../subagents/index.js";

type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

interface TodoItem {
	id?: string;
	content: string;
	status: TodoStatus;
	startedAt?: number;
	completedAt?: number;
}

interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

interface TodoOp {
	op: "init" | "start" | "done" | "drop" | "rm" | "append" | "view";
	list?: Array<{ phase: string; items: string[] }>;
	items?: string[];
	task?: string;
	phase?: string;
}

interface TodoStateEntry {
	phases: TodoPhase[];
}

interface TodoReminderState {
	attempts: number;
	awaitingProgress: boolean;
	toolsUsedThisTurn: boolean;
}

interface IncompleteTodoPhase {
	name: string;
	tasks: Array<{ content: string; status: TodoStatus }>;
}

interface TodoReminderDetails {
	incomplete: IncompleteTodoPhase[];
	attempts: number;
	maxAttempts: number;
}

const stateEntryType = "omp-todos-state";
const legacyStateEntryType = "omp-tasks-state";
const stickyTodoLimit = 5;
const todoIdAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const todoReminderMax = 3;

let phases: TodoPhase[] = [];
let todoWidget: TodoWidget | undefined;

type ToolTheme = ExtensionContext["ui"]["theme"];

function allTodoItems(value: TodoPhase[]): TodoItem[] {
	return value.flatMap((phase) => phase.tasks);
}

function randomTodoId(): string {
	const bytes = randomBytes(6);
	let id = "";
	for (const byte of bytes) id += todoIdAlphabet[byte % todoIdAlphabet.length];
	return id;
}

function uniqueRandomTodoId(taken: ReadonlySet<string>): string {
	for (let attempt = 0; attempt < 16; attempt++) {
		const id = randomTodoId();
		if (!taken.has(id)) return id;
	}
	throw new Error("Could not generate a unique todo id");
}

function ensureTodoIds(value: TodoPhase[]): void {
	const taken = new Set<string>();
	for (const todo of allTodoItems(value)) {
		if (!todo.id || taken.has(todo.id)) todo.id = uniqueRandomTodoId(taken);
		taken.add(todo.id);
	}
}

function minimalTodoIdPrefixes(todos: readonly TodoItem[]): Map<string, string> {
	const ids = todos.map((todo) => todo.id).filter((id): id is string => Boolean(id));
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

function displayTodoId(todo: TodoItem, prefixes: ReadonlyMap<string, string>): string {
	return todo.id ? (prefixes.get(todo.id) ?? todo.id) : "?";
}

function strike(theme: ToolTheme, text: string): string {
	return theme.strikethrough?.(text) ?? `\x1b[9m${text}\x1b[29m`;
}

function phaseRomanNumeral(oneBasedIndex: number): string {
	const pairs: Array<[number, string]> = [
		[1000, "M"],
		[900, "CM"],
		[500, "D"],
		[400, "CD"],
		[100, "C"],
		[90, "XC"],
		[50, "L"],
		[40, "XL"],
		[10, "X"],
		[9, "IX"],
		[5, "V"],
		[4, "IV"],
		[1, "I"],
	];
	let remaining = oneBasedIndex;
	let output = "";
	for (const [value, symbol] of pairs) {
		while (remaining >= value) {
			output += symbol;
			remaining -= value;
		}
	}
	return output;
}

function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${name}`;
}

function visiblePhases(value: TodoPhase[]): TodoPhase[] {
	return value.filter((phase) => phase.tasks.length > 0);
}

function todoCounts(value: TodoPhase[]): {
	total: number;
	completed: number;
	abandoned: number;
	inProgress: number;
	open: number;
	current?: string;
} {
	const todos = allTodoItems(value);
	const completed = todos.filter((todo) => todo.status === "completed").length;
	const abandoned = todos.filter((todo) => todo.status === "abandoned").length;
	const inProgress = todos.filter((todo) => todo.status === "in_progress").length;
	const current = todos.find((todo) => todo.status === "in_progress")?.content;
	return {
		total: todos.length,
		completed,
		abandoned,
		inProgress,
		open: todos.length - completed - abandoned,
		current,
	};
}

function formatTodoHeader(value: TodoPhase[], _active: { phase: TodoPhase; index: number }, theme: ToolTheme): string {
	const counts = todoCounts(value);
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(`${counts.completed} done`);
	if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
	const pending = counts.open - counts.inProgress;
	if (pending > 0) parts.push(`${pending} open`);
	if (counts.abandoned > 0) parts.push(`${counts.abandoned} abandoned`);
	const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	return `${theme.fg("accent", "●")} ${theme.fg("accent", `${counts.total} todo${counts.total === 1 ? "" : "s"}${suffix}`)}`;
}

function getActivePhase(value: TodoPhase[]): { phase: TodoPhase; index: number } | undefined {
	const phases = visiblePhases(value);
	const active = phases.findIndex((phase) =>
		phase.tasks.some((todo) => todo.status === "pending" || todo.status === "in_progress"),
	);
	const index = active >= 0 ? active : phases.length - 1;
	const phase = phases[index];
	return phase ? { phase, index } : undefined;
}

function selectStickyTodoWindow(
	todos: TodoItem[],
	maxVisible = stickyTodoLimit,
): { visible: TodoItem[]; hiddenOpenCount: number } {
	const openTodos = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
	if (openTodos.length > 0) {
		const visible = openTodos.slice(0, maxVisible);
		return { visible, hiddenOpenCount: openTodos.length - visible.length };
	}
	const start = Math.max(0, todos.length - maxVisible);
	return { visible: todos.slice(start), hiddenOpenCount: 0 };
}

const todoDescriptionMinOverlap = 6;

function normalizeForTodoMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
	const target = normalizeForTodoMatch(content);
	if (!target) return false;
	for (const desc of descriptions) {
		const candidate = normalizeForTodoMatch(desc);
		if (!candidate) continue;
		if (target === candidate) return true;
		if (target.length >= todoDescriptionMinOverlap && candidate.includes(target)) return true;
		if (candidate.length >= todoDescriptionMinOverlap && target.includes(candidate)) return true;
	}
	return false;
}

function formatTodoWidgetLine(todo: TodoItem, displayId: string, matched: boolean, theme: ToolTheme): string {
	const checkbox = checkboxGlyphs(theme);
	const id = theme.fg("dim", displayId);
	if (todo.status === "completed") {
		return `${theme.fg("success", "✔")} ${id} ${theme.fg("dim", strike(theme, todo.content))}`;
	}
	if (todo.status === "abandoned") {
		return `${theme.fg("error", "✗")} ${id} ${theme.fg("dim", strike(theme, todo.content))}`;
	}
	if (todo.status === "in_progress") {
		return `${theme.fg("accent", "◼")} ${id} ${theme.fg("accent", todo.content)}`;
	}
	return `${theme.fg(matched ? "accent" : "dim", checkbox.unchecked)} ${id} ${theme.fg(matched ? "accent" : "dim", todo.content)}`;
}

function formatTodoResultLine(todo: TodoItem, theme: ToolTheme): string {
	const checkbox = checkboxGlyphs(theme);
	switch (todo.status) {
		case "completed":
			return theme.fg("success", `${checkbox.checked} ${strike(theme, todo.content)}`);
		case "in_progress":
			return theme.fg("accent", `${checkbox.unchecked} ${todo.content}`);
		case "abandoned":
			return theme.fg("error", `${checkbox.unchecked} ${strike(theme, todo.content)}`);
		case "pending":
			return theme.fg("dim", `${checkbox.unchecked} ${todo.content}`);
	}
}

class TodoWidget implements Component {
	private ctx: ExtensionContext | undefined;
	private tui: { requestRender(): void } | undefined;
	private registered = false;

	setContext(ctx: ExtensionContext): void {
		if (ctx !== this.ctx) {
			this.clearWidget();
			this.ctx = ctx;
		}
	}

	clearWidget(): void {
		if (this.ctx && this.registered) this.ctx.ui.setWidget("todos", undefined);
		this.tui = undefined;
		this.registered = false;
	}

	update(): void {
		if (!this.ctx) return;
		const counts = todoCounts(phases);
		if (counts.total === 0) {
			this.clearWidget();
			return;
		}
		if (!this.registered) {
			this.ctx.ui.setWidget(
				"todos",
				(tui) => {
					this.tui = tui;
					return this;
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.ctx?.ui.theme;
		if (!theme) return [];
		const active = getActivePhase(phases);
		if (!active) return [];
		const { visible, hiddenOpenCount } = selectStickyTodoWindow(active.phase.tasks);
		const activeDescriptions = getActiveSubagentDescriptions();
		const prefixes = minimalTodoIdPrefixes(allTodoItems(phases));
		const lines = [formatTodoHeader(phases, active, theme)];
		lines.push(
			`${theme.fg("dim", `  ${treeBranch(theme, true)}`)} ${theme.fg(
				"accent",
				formatPhaseDisplayName(active.phase.name, active.index + 1),
			)}`,
		);
		const hasOverflow = hiddenOpenCount > 0;
		visible.forEach((todo, index) => {
			const isLast = !hasOverflow && index === visible.length - 1;
			lines.push(
				`${theme.fg("dim", `     ${treeBranch(theme, isLast)}`)} ${formatTodoWidgetLine(
					todo,
					displayTodoId(todo, prefixes),
					todoMatchesAnyDescription(todo.content, activeDescriptions),
					theme,
				)}`,
			);
		});
		if (hasOverflow) {
			lines.push(theme.fg("dim", `     ${treeBranch(theme, true)} … and ${hiddenOpenCount} more`));
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}

	dispose(): void {
		this.tui = undefined;
		this.registered = false;
	}
}

function syncTodoWidget(ctx: ExtensionContext): void {
	todoWidget ??= new TodoWidget();
	todoWidget.setContext(ctx);
	todoWidget.update();
}

function compactSummary(value: TodoPhase[], errors: string[] = []): string {
	if (errors.length > 0) return `Todo error: ${errors.join("; ")}`;
	const counts = todoCounts(value);
	if (counts.total === 0) return "Todo list is empty.";
	const current = counts.current ? ` · Current: ${counts.current}` : "";
	return `${counts.total} todo${counts.total === 1 ? "" : "s"}: ${counts.completed} completed, ${counts.abandoned} abandoned, ${counts.open} open${current}`;
}

function renderTodoCall(args: unknown, theme: ToolTheme): Component {
	const opsList = Array.isArray((args as { ops?: unknown[] })?.ops) ? (args as { ops: unknown[] }).ops : [];
	const ops =
		opsList.length === 0
			? ["update"]
			: opsList.map((entry) => {
					const op =
						entry && typeof entry === "object"
							? (entry as { op?: string; task?: string; phase?: string; items?: unknown[] })
							: {};
					const parts = [op.op ?? "update"];
					if (op.task) parts.push(op.task);
					if (op.phase) parts.push(op.phase);
					if (Array.isArray(op.items) && op.items.length > 0)
						parts.push(`${op.items.length} item${op.items.length === 1 ? "" : "s"}`);
					return parts.join(" ");
				});
	return textComponent(renderStatusLine(theme, { icon: "pending", title: "Todo", meta: ops }));
}

function treeBranch(theme: ToolTheme, isLast: boolean): string {
	const tree = (theme as ToolTheme & { tree?: { branch?: string; last?: string } }).tree;
	return isLast ? (tree?.last ?? "└─") : (tree?.branch ?? "├─");
}

function renderTodoTreeLines(todos: TodoItem[], theme: ToolTheme, expanded: boolean): string[] {
	const maxCollapsed = 8;
	const visible = expanded ? todos : todos.slice(Math.max(0, todos.length - maxCollapsed));
	const hiddenCount = todos.length - visible.length;
	const lines: string[] = [];
	if (!expanded && hiddenCount > 0) {
		lines.push(
			`${theme.fg("dim", treeBranch(theme, false))} ${theme.fg("muted", `… ${hiddenCount} more todo${hiddenCount === 1 ? "" : "s"}`)}`,
		);
	}
	visible.forEach((todo, index) => {
		const isLast = index === visible.length - 1;
		lines.push(`${theme.fg("dim", treeBranch(theme, isLast))} ${formatTodoResultLine(todo, theme)}`);
	});
	return lines;
}

function renderTodoResultLines(renderedPhases: TodoPhase[], theme: ToolTheme, expanded: boolean): string[] {
	const phasesWithTodos = renderedPhases.filter((phase) => phase.tasks.length > 0);
	const multiPhase = phasesWithTodos.length > 1;
	const indent = multiPhase ? "  " : "";
	const lines: string[] = [];
	phasesWithTodos.forEach((phase, phaseIndex) => {
		if (multiPhase) lines.push(theme.fg("accent", theme.bold(formatPhaseDisplayName(phase.name, phaseIndex + 1))));
		for (const line of renderTodoTreeLines(phase.tasks, theme, expanded)) lines.push(`${indent}${line}`);
	});
	return lines;
}

function renderTodoResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: { phases?: TodoPhase[]; errors?: string[] } },
	options: { isPartial?: boolean; expanded?: boolean } | undefined,
	theme: ToolTheme,
): Component {
	const errors = result.details?.errors ?? [];
	const renderedPhases = Array.isArray(result.details?.phases) ? result.details.phases : phases;
	const allTodos = allTodoItems(renderedPhases);
	if (errors.length > 0) {
		const header = renderStatusLine(theme, { icon: "error", title: "Todo" });
		return framedBlock(theme, {
			header,
			sections: [{ lines: [compactSummary(renderedPhases, errors)] }],
			borderColor: "error",
		});
	}
	const header = renderStatusLine(theme, {
		iconOverride: (theme as ToolTheme & { styledSymbol?: (name: string, color: string) => string }).styledSymbol?.(
			"tool.todo",
			"accent",
		),
		title: "Todo",
		meta: [`${allTodos.length} todo${allTodos.length === 1 ? "" : "s"}`],
	});
	if (allTodos.length === 0) return textComponent(`${header}\n  ${theme.fg("dim", "No todos")}`);
	return framedBlock(theme, {
		header,
		sections: [{ lines: renderTodoResultLines(renderedPhases, theme, options?.expanded ?? false) }],
		borderColor: "borderMuted",
	});
}

function clonePhases(value: TodoPhase[]): TodoPhase[] {
	return value.map((phase) => ({
		name: phase.name,
		tasks: phase.tasks.map((todo) => ({ ...todo })),
	}));
}

function normalizeState(value: TodoPhase[]): void {
	ensureTodoIds(value);
	let sawActive = false;
	let firstPending: TodoItem | undefined;
	for (const phase of value) {
		for (const todo of phase.tasks) {
			if (todo.status === "in_progress") {
				if (sawActive) {
					todo.status = "pending";
					delete todo.startedAt;
					continue;
				}
				todo.startedAt ??= Date.now();
				sawActive = true;
			} else if (todo.status !== "completed" && todo.status !== "abandoned") {
				delete todo.completedAt;
				delete todo.startedAt;
			}
			if (!firstPending && todo.status === "pending") firstPending = todo;
		}
	}
	if (!sawActive && firstPending) {
		firstPending.status = "in_progress";
		firstPending.startedAt = Date.now();
	}
}

function todoExists(value: TodoPhase[], content: string): boolean {
	return value.some((phase) => phase.tasks.some((todo) => todo.content === content));
}

function findTodo(value: TodoPhase[], content: string): TodoItem | undefined {
	for (const phase of value) {
		const todo = phase.tasks.find((candidate) => candidate.content === content);
		if (todo) return todo;
	}
	return undefined;
}

function findPhase(value: TodoPhase[], name: string): TodoPhase | undefined {
	return value.find((phase) => phase.name === name);
}

function targetsFor(op: TodoOp, value: TodoPhase[], errors: string[]): TodoItem[] {
	if (op.task) {
		const todo = findTodo(value, op.task);
		if (!todo) errors.push(`Todo "${op.task}" not found`);
		return todo ? [todo] : [];
	}
	if (op.phase) {
		const phase = findPhase(value, op.phase);
		if (!phase) errors.push(`Phase "${op.phase}" not found`);
		return phase?.tasks ?? [];
	}
	return allTodoItems(value);
}

function initPhases(op: TodoOp, errors: string[]): TodoPhase[] {
	const seenPhases = new Set<string>();
	const seenTodos = new Set<string>();
	const seenIds = new Set<string>();
	const source = op.list ?? (op.items ? [{ phase: op.phase ?? "Todos", items: op.items }] : undefined);
	if (!source?.length) {
		errors.push("Missing list for init operation");
		return [];
	}
	return source.map((entry) => {
		const name = entry.phase?.trim();
		if (!name) errors.push("Missing phase name");
		if (seenPhases.has(name)) errors.push(`Duplicate phase "${name}" in init list`);
		seenPhases.add(name);
		const items = entry.items ?? [];
		if (items.length === 0) errors.push(`Missing items for phase "${name}"`);
		return {
			name,
			tasks: items.map((content) => {
				if (!content?.trim()) errors.push("Missing todo content");
				if (seenTodos.has(content)) errors.push(`Duplicate todo "${content}" in init list`);
				seenTodos.add(content);
				const id = uniqueRandomTodoId(seenIds);
				seenIds.add(id);
				return { id, content, status: "pending" as const };
			}),
		};
	});
}

export function applyTodoOps(
	current: TodoPhase[],
	ops: TodoOp[],
): { phases: TodoPhase[]; errors: string[]; readOnly: boolean } {
	const next = clonePhases(current);
	const errors: string[] = [];
	const readOnly = ops.every((op) => op.op === "view");

	for (const op of ops) {
		switch (op.op) {
			case "view":
				break;
			case "init":
				next.splice(0, next.length, ...initPhases(op, errors));
				break;
			case "start": {
				if (!op.task) {
					errors.push("Missing todo content");
					break;
				}
				const target = findTodo(next, op.task);
				if (!target) {
					errors.push(`Todo "${op.task}" not found`);
					break;
				}
				for (const todo of allTodoItems(next)) {
					if (todo.status === "in_progress") {
						todo.status = "pending";
						delete todo.startedAt;
					}
				}
				target.status = "in_progress";
				target.startedAt = Date.now();
				delete target.completedAt;
				break;
			}
			case "done":
				for (const todo of targetsFor(op, next, errors)) {
					todo.status = "completed";
					todo.completedAt = Date.now();
					delete todo.startedAt;
				}
				break;
			case "drop":
				for (const todo of targetsFor(op, next, errors)) {
					todo.status = "abandoned";
					todo.completedAt = Date.now();
					delete todo.startedAt;
				}
				break;
			case "rm":
				if (op.task) {
					let removed = false;
					for (const phase of next) {
						const before = phase.tasks.length;
						phase.tasks = phase.tasks.filter((todo) => todo.content !== op.task);
						removed ||= phase.tasks.length !== before;
					}
					if (!removed) errors.push(`Todo "${op.task}" not found`);
				} else if (op.phase) {
					const phase = findPhase(next, op.phase);
					if (phase) phase.tasks = [];
					else errors.push(`Phase "${op.phase}" not found`);
				} else {
					next.splice(0, next.length);
				}
				break;
			case "append": {
				const name = op.phase?.trim();
				if (!name) {
					errors.push("Missing phase name for append operation");
					break;
				}
				if (!op.items?.length) {
					errors.push("Missing items for append operation");
					break;
				}
				const phase = findPhase(next, name) ?? { name, tasks: [] };
				if (!next.includes(phase)) next.push(phase);
				const seenIds = new Set(
					allTodoItems(next)
						.map((todo) => todo.id)
						.filter((id): id is string => Boolean(id)),
				);
				for (const content of op.items) {
					if (!content?.trim()) errors.push("Missing todo content");
					else if (todoExists(next, content)) errors.push(`Todo "${content}" already exists`);
					else {
						const id = uniqueRandomTodoId(seenIds);
						seenIds.add(id);
						phase.tasks.push({ id, content, status: "pending" });
					}
				}
				break;
			}
			default:
				errors.push(`Unknown todo operation: ${(op as { op?: string }).op}`);
		}
	}

	if (errors.length === 0 && !readOnly) normalizeState(next);
	return { phases: errors.length ? clonePhases(current) : next, errors, readOnly };
}

function restoreFromSession(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	const last = [...entries]
		.reverse()
		.find(
			(entry: { type?: string; customType?: string }) =>
				entry.type === "custom" &&
				(entry.customType === stateEntryType || entry.customType === legacyStateEntryType),
		) as { data?: TodoStateEntry } | undefined;
	phases = clonePhases(last?.data?.phases ?? []);
	normalizeState(phases);
}

function persist(pi: ExtensionAPI): void {
	pi.appendEntry<TodoStateEntry>(stateEntryType, { phases: clonePhases(phases) });
}

function incompleteTodoPhases(value: TodoPhase[]): IncompleteTodoPhase[] {
	return value
		.map((phase) => ({
			name: phase.name,
			tasks: phase.tasks
				.filter((todo) => todo.status === "pending" || todo.status === "in_progress")
				.map((todo) => ({ content: todo.content, status: todo.status })),
		}))
		.filter((phase) => phase.tasks.length > 0);
}

function incompleteTodoCount(incompleteByPhase: IncompleteTodoPhase[]): number {
	return incompleteByPhase.reduce((sum, phase) => sum + phase.tasks.length, 0);
}

function renderTodoReminderLines(details: TodoReminderDetails, theme: ToolTheme): string[] {
	const checkbox = checkboxGlyphs(theme);
	const lines: string[] = [];
	details.incomplete.forEach((phase, phaseIndex) => {
		const phaseLast = phaseIndex === details.incomplete.length - 1;
		lines.push(`${theme.fg("dim", treeBranch(theme, phaseLast))} ${theme.fg("accent", phase.name)}`);
		phase.tasks.forEach((todo, todoIndex) => {
			const taskLast = todoIndex === phase.tasks.length - 1;
			const prefix = phaseLast ? "   " : `${theme.fg("dim", "│  ")}`;
			lines.push(
				`${prefix}${theme.fg("dim", treeBranch(theme, taskLast))} ${theme.fg(
					todo.status === "in_progress" ? "accent" : "dim",
					`${checkbox.unchecked} ${todo.content}`,
				)}`,
			);
		});
	});
	return lines;
}

function renderTodoReminderMessage(
	message: { details?: unknown },
	_themeOptions: unknown,
	theme: ToolTheme,
): Component | undefined {
	const details = message.details as Partial<TodoReminderDetails> | undefined;
	if (!details || !Array.isArray(details.incomplete)) return undefined;
	const attempts = typeof details.attempts === "number" ? details.attempts : 1;
	const maxAttempts = typeof details.maxAttempts === "number" ? details.maxAttempts : todoReminderMax;
	const normalized: TodoReminderDetails = { incomplete: details.incomplete, attempts, maxAttempts };
	const count = incompleteTodoCount(normalized.incomplete);
	const label = count === 1 ? "todo" : "todos";
	const header = `${theme.fg("warning", "⚠")} ${theme.fg(
		"warning",
		`Todo reminder: ${count} incomplete ${label}`,
	)} ${theme.fg("dim", `${attempts}/${maxAttempts}`)}`;
	return textComponent([header, "", ...renderTodoReminderLines(normalized, theme)].join("\n"));
}

function todoReminderContent(incompleteByPhase: IncompleteTodoPhase[], attempt: number): string {
	const count = incompleteTodoCount(incompleteByPhase);
	const todoList = incompleteByPhase
		.map((phase) => `- ${phase.name}\n${phase.tasks.map((todo) => `  - ${todo.content}`).join("\n")}`)
		.join("\n");
	return [
		`Todo reminder: ${count} incomplete todo item${count === 1 ? "" : "s"}.`,
		todoList,
		"",
		"Continue working on these todos or mark them complete if finished.",
		`Reminder ${attempt}/${todoReminderMax}`,
	].join("\n");
}

function resetTodoReminder(state: TodoReminderState): void {
	state.attempts = 0;
	state.awaitingProgress = false;
}

function maybeSendTodoReminder(pi: ExtensionAPI, state: TodoReminderState): void {
	if (state.toolsUsedThisTurn) {
		state.awaitingProgress = false;
		return;
	}
	if (state.awaitingProgress || state.attempts >= todoReminderMax) return;
	const incomplete = incompleteTodoPhases(phases);
	if (incomplete.length === 0) {
		resetTodoReminder(state);
		return;
	}
	state.attempts += 1;
	state.awaitingProgress = true;
	const details = { incomplete, attempts: state.attempts, maxAttempts: todoReminderMax } satisfies TodoReminderDetails;
	pi.sendMessage(
		{
			customType: "todo-reminder",
			content: [{ type: "text", text: todoReminderContent(incomplete, state.attempts) }],
			display: true,
			details,
		},
		undefined,
	);
}

const todoOpSchema = Type.Object({
	op: Type.String({ description: "init, start, done, rm, drop, append, or view" }),
	list: Type.Optional(Type.Array(Type.Object({ phase: Type.String(), items: Type.Array(Type.String()) }))),
	items: Type.Optional(Type.Array(Type.String())),
	task: Type.Optional(Type.String({ description: "Exact todo content" })),
	phase: Type.Optional(Type.String({ description: "Exact phase name" })),
});

export default function todosExtension(pi: ExtensionAPI) {
	const reminderState: TodoReminderState = { attempts: 0, awaitingProgress: false, toolsUsedThisTurn: false };
	pi.registerMessageRenderer("todo-reminder", renderTodoReminderMessage as never);

	pi.on("session_start", async (_event, ctx) => {
		resetTodoReminder(reminderState);
		reminderState.toolsUsedThisTurn = false;
		restoreFromSession(ctx);
		syncTodoWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		todoWidget?.clearWidget();
	});

	pi.on("tool_execution_end", () => {
		reminderState.toolsUsedThisTurn = true;
		reminderState.awaitingProgress = false;
	});

	(pi as unknown as { on(event: string, handler: (event: unknown) => unknown): void }).on("message_end", (event) => {
		const message = (event as { message?: { role?: string; customType?: unknown } }).message;
		if (message?.role === "user" && message.customType !== "todo-reminder") {
			resetTodoReminder(reminderState);
			reminderState.toolsUsedThisTurn = false;
		}
	});

	pi.on("turn_end", async () => {
		const usedToolsThisTurn = reminderState.toolsUsedThisTurn;
		reminderState.toolsUsedThisTurn = false;
		if (usedToolsThisTurn) {
			reminderState.awaitingProgress = false;
			return;
		}
		maybeSendTodoReminder(pi, reminderState);
	});

	pi.registerCommand("todo", {
		description: "Show or replace the oh-my-pi style session todo list",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				syncTodoWidget(ctx);
				ctx.ui.notify(compactSummary(phases), "info");
				return;
			}
			const items = args
				.split("\n")
				.map((line) => line.replace(/^[-*]\s*/, "").trim())
				.filter(Boolean);
			if (items.length === 0) return;
			phases = applyTodoOps(phases, [{ op: "init", phase: "Todos", items }]).phases;
			persist(pi);
			syncTodoWidget(ctx);
			ctx.ui.notify(compactSummary(phases), "info");
		},
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Apply ordered mutations to the session todo list. Ops: init, start, done, drop, rm, append, view. Todo and phase references use exact text.",
		promptSnippet: "Update session todo list",
		renderShell: "self",
		renderCall: renderTodoCall,
		renderResult: renderTodoResult,
		parameters: Type.Object({
			ops: Type.Array(todoOpSchema, { minItems: 1, description: "Ordered todo-list operations." }),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const result = applyTodoOps(phases, (params as { ops: TodoOp[] }).ops);
			phases = result.phases;
			if (result.errors.length === 0 && !result.readOnly) persist(pi);
			syncTodoWidget(ctx);
			return {
				content: [{ type: "text" as const, text: compactSummary(phases, result.errors) }],
				details: { phases: clonePhases(phases), errors: result.errors, storage: "session" },
				isError: result.errors.length > 0,
			};
		},
	});
}
