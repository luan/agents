import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@mariozechner/pi-tui";

import tasksExtension, {
	buildTaskBoardColumns,
	buildTaskCommand,
	renderHudLines,
	renderTaskBoardLines,
	renderTaskResult,
	TaskBoardOverlay,
} from "./index";

const task = {
	id: "PG4W2K4Q03",
	title: "Smoke test task tools",
	body: "Verify the task HUD and renderers.",
	status: "open",
	created_at: 1,
	updated_at: 2,
};

const theme = {
	fg(_role: string, text: string) {
		return text;
	},
	bg(_role: string, text: string) {
		return text;
	},
	bold(text: string) {
		return `**${text}**`;
	},
	strikethrough(text: string) {
		return `~~${text}~~`;
	},
};

const markedTheme = {
	fg(role: string, text: string) {
		return `<${role}>${text}</${role}>`;
	},
	bg(role: string, text: string) {
		return `<${role}>${text}</${role}>`;
	},
	bold(text: string) {
		return `**${text}**`;
	},
	strikethrough(text: string) {
		return `~~${text}~~`;
	},
};

function createText() {
	let value = "";
	return {
		setText(next: string) {
			value = next;
		},
		render() {
			return value.split("\n");
		},
	};
}

describe("tasks extension", () => {
	test("groups task board columns with derived blocked state", () => {
		const tasks = [
			{ ...task, id: "DONE", status: "done", title: "Finished" },
			{ ...task, id: "ACTIVE", status: "in_progress", title: "Active" },
			{ ...task, id: "READY", status: "blocked", title: "Ready despite status", priority: 1 },
			{ ...task, id: "BLOCK", title: "Blocked by active", blocked_by: ["ACTIVE"] },
			{ ...task, id: "UNBLOCK", title: "Unblocked by done", blocked_by: ["DONE"], priority: 5 },
			{ ...task, id: "CANCEL", status: "canceled", title: "Hidden" },
		];

		const columns = buildTaskBoardColumns(tasks);
		expect(columns.map((column) => column.label)).toEqual(["Ready", "Blocked", "In Progress", "Done"]);
		expect(columns[0].tasks.map((item) => item.id)).toEqual(["UNBLOCK", "READY"]);
		expect(columns[1].tasks.map((item) => item.id)).toEqual(["BLOCK"]);
		expect(columns[2].tasks.map((item) => item.id)).toEqual(["ACTIVE"]);
		expect(columns[3].tasks.map((item) => item.id)).toEqual(["DONE"]);
	});

	test("renders task board details and respects width", () => {
		const tasks = [
			{ ...task, id: "A", title: "Blocking task", body: "Important context", assigned_label: "Me", priority: 7 },
			{ ...task, id: "B", title: "Blocked task", blocked_by: ["A"] },
		];

		const lines = renderTaskBoardLines(tasks, theme as any, 60, { column: 0, row: 0 });
		expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
		expect(lines[0]).toContain("╭ Tasks");
		expect(lines.at(-1)).toContain("╰");
		expect(lines.join("\n")).toContain("Ready");
		expect(lines.join("\n")).toContain("Blocked");
		expect(lines.join("\n")).toContain("Details");
		expect(lines.join("\n")).toContain("Important context");
		expect(lines.join("\n")).toContain("Blocks: B");
		expect(lines.join("\n")).toContain("Priority: 7");
	});

	test("task board handles navigation, reload, and close keys", async () => {
		let closed = false;
		let reloads = 0;
		const board = new TaskBoardOverlay({
			tasks: [
				{ ...task, id: "READY", title: "Ready" },
				{ ...task, id: "BLOCK", title: "Blocked", blocked_by: ["READY"] },
			],
			theme: theme as any,
			onClose: () => {
				closed = true;
			},
			onReload: async () => {
				reloads++;
				return [{ ...task, id: "NEXT", title: "Reloaded" }];
			},
		});

		board.handleInput("l");
		expect(board.selection()).toEqual({ column: 1, row: 0 });
		board.handleInput("h");
		expect(board.selection()).toEqual({ column: 0, row: 0 });
		board.handleInput("r");
		await board.waitForIdle();
		expect(reloads).toBe(1);
		expect(board.render(80).join("\n")).toContain("Reloaded");
		board.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	test("task board does not render transient reload banners", () => {
		let resolveReload: ((tasks: (typeof task)[]) => void) | undefined;
		const board = new TaskBoardOverlay({
			tasks: [task],
			theme: theme as any,
			onClose: () => {},
			onReload: () =>
				new Promise((resolve) => {
					resolveReload = resolve;
				}),
		});

		board.handleInput("r");
		expect(board.render(80).join("\n")).not.toContain("Reloading");
		resolveReload?.([task]);
	});

	test("task board closes itself on alt+t while focused", () => {
		let closed = false;
		const board = new TaskBoardOverlay({
			tasks: [task],
			theme: theme as any,
			onClose: () => {
				closed = true;
			},
			onReload: async () => [task],
		});

		board.handleInput("\x1bt");
		expect(closed).toBe(true);
	});

	test("task board accepts configurable bindings and help text", async () => {
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const board = new TaskBoardOverlay({
			tasks: [task],
			theme: theme as any,
			keybindings: {
				toggle: "ctrl+q",
				close: ["ctrl+q"],
				left: ["a"],
				right: ["f"],
				up: ["e"],
				down: ["n"],
				cycleStatus: ["s"],
				assignCurrent: ["c"],
				clearAssignee: ["v"],
				priorityUp: ["p"],
				priorityDown: ["o"],
				done: ["m"],
				cancel: ["z"],
				delete: ["backspace"],
				reload: ["g"],
				confirmDelete: ["enter"],
				cancelDelete: ["escape"],
			},
			onClose: () => {},
			onReload: async () => [task],
			onMutate: async (action, params) => {
				calls.push({ action, params });
				return [task];
			},
		});

		expect(board.render(120).join("\n")).toContain("ctrl+q");
		expect(board.render(120).join("\n")).toContain("p/o priority");
		board.handleInput("p");
		await board.waitForIdle();
		expect(calls.at(-1)).toEqual({ action: "update", params: { id: "PG4W2K4Q03", priority: 1 } });
		board.handleInput("+");
		await board.waitForIdle();
		expect(calls).toHaveLength(1);
	});

	test("task board mutation keys call update/delete actions and reload", async () => {
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const makeBoard = (selectedTask: Record<string, unknown>) =>
			new TaskBoardOverlay({
				tasks: [{ ...task, ...selectedTask }],
				theme: theme as any,
				onClose: () => {},
				onReload: async () => [{ ...task, ...selectedTask }],
				onMutate: async (action, params) => {
					calls.push({ action, params });
					return [{ ...task, ...selectedTask }];
				},
			});

		for (const [key, params] of [
			["a", { id: "PG4W2K4Q03", assigned_to: "current" }],
			["u", { id: "PG4W2K4Q03", clear_assignee: true }],
			["+", { id: "PG4W2K4Q03", priority: 1 }],
			["-", { id: "PG4W2K4Q03", priority: -1 }],
			["\x1bk", { id: "PG4W2K4Q03", priority: 1 }],
			["\x1bj", { id: "PG4W2K4Q03", priority: -1 }],
			["d", { id: "PG4W2K4Q03", status: "done" }],
			["x", { id: "PG4W2K4Q03", status: "canceled" }],
			[" ", { id: "PG4W2K4Q03", status: "in_progress" }],
		] as const) {
			const board = makeBoard({});
			board.handleInput(key);
			await board.waitForIdle();
			expect(calls.at(-1)).toEqual({ action: "update", params });
		}

		const progress = makeBoard({ status: "in_progress" });
		progress.handleInput("l");
		progress.handleInput("l");
		progress.handleInput(" ");
		await progress.waitForIdle();
		expect(calls.at(-1)).toEqual({ action: "update", params: { id: "PG4W2K4Q03", status: "done" } });

		const done = makeBoard({ status: "done" });
		done.handleInput("l");
		done.handleInput("l");
		done.handleInput("l");
		done.handleInput(" ");
		await done.waitForIdle();
		expect(calls.at(-1)).toEqual({ action: "update", params: { id: "PG4W2K4Q03", status: "open" } });
	});

	test("task board ignores mutating keys while a mutation is pending", async () => {
		let resolveMutation: ((tasks: (typeof task)[]) => void) | undefined;
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const board = new TaskBoardOverlay({
			tasks: [task],
			theme: theme as any,
			onClose: () => {},
			onReload: async () => [task],
			onMutate: async (action, params) => {
				calls.push({ action, params });
				return new Promise((resolve) => {
					resolveMutation = resolve;
				});
			},
		});

		board.handleInput("+");
		board.handleInput("+");
		expect(calls).toHaveLength(1);
		resolveMutation?.([task]);
		await board.waitForIdle();
	});

	test("task board keeps selection on reprioritized task after resort", async () => {
		const board = new TaskBoardOverlay({
			tasks: [
				{ ...task, id: "HIGH", title: "High", priority: 10 },
				{ ...task, id: "MID", title: "Mid", priority: 5 },
				{ ...task, id: "LOW", title: "Low", priority: 1 },
			],
			theme: theme as any,
			onClose: () => {},
			onReload: async () => [],
			onMutate: async () => [
				{ ...task, id: "MID", title: "Mid", priority: 11 },
				{ ...task, id: "HIGH", title: "High", priority: 10 },
				{ ...task, id: "LOW", title: "Low", priority: 1 },
			],
		});

		board.handleInput("j");
		expect(board.selection()).toEqual({ column: 0, row: 1 });
		board.handleInput("\x1bk");
		await board.waitForIdle();
		expect(board.selection()).toEqual({ column: 0, row: 0 });
		expect(board.render(100).join("\n")).toContain("› ◻ MID");
	});

	test("task board does not space-cycle unresolved blocked tasks", async () => {
		const calls: unknown[] = [];
		const board = new TaskBoardOverlay({
			tasks: [
				{ ...task, id: "BLOCKER", status: "open" },
				{ ...task, id: "BLOCKED", status: "open", blocked_by: ["BLOCKER"] },
			],
			theme: theme as any,
			onClose: () => {},
			onReload: async () => [],
			onMutate: async (_action, params) => {
				calls.push(params);
				return [];
			},
		});

		board.handleInput("l");
		board.handleInput(" ");
		await board.waitForIdle();
		expect(calls).toEqual([]);
	});

	test("task board hard delete requires confirmation", async () => {
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const board = new TaskBoardOverlay({
			tasks: [task],
			theme: theme as any,
			onClose: () => {},
			onReload: async () => [task],
			onMutate: async (action, params) => {
				calls.push({ action, params });
				return [];
			},
		});

		board.handleInput("D");
		await board.waitForIdle();
		expect(calls).toEqual([]);
		expect(board.render(80).join("\n")).toContain("Confirm delete");
		board.handleInput("y");
		await board.waitForIdle();
		expect(calls).toEqual([{ action: "delete", params: { id: "PG4W2K4Q03" } }]);
	});

	test("/tasks opens task board overlay and reloads from ct", async () => {
		const commands = new Map<string, any>();
		let customOptions: any;
		let overlayText = "";
		const calls: string[][] = [];
		tasksExtension(
			{
				registerTool() {},
				on() {},
				registerCommand(name: string, definition: any) {
					commands.set(name, definition);
				},
			} as any,
			{
				runCommand: async (command: string, args: string[]) => {
					calls.push([command, ...args]);
					return { stdout: JSON.stringify({ tasks: [task] }), stderr: "", exitCode: 0 };
				},
			},
		);

		await commands.get("tasks").handler("", {
			cwd: "/tmp/project",
			ui: {
				custom(factory: any, options: any) {
					customOptions = options;
					const component = factory({ requestRender() {} }, theme, {}, () => {});
					overlayText = component.render(120).join("\n");
					return Promise.resolve();
				},
			},
		});

		expect(customOptions.overlay).toBe(true);
		expect(customOptions.overlayOptions.width).toBe("98%");
		expect(customOptions.overlayOptions.minWidth).toBe(90);
		expect(overlayText).toContain("Ready");
		expect(overlayText).toContain("Smoke test task tools");
		expect(calls).toContainEqual(["ct", "task", "list", "--all", "--json"]);
	});

	test("/tasks toggles an open task board closed", async () => {
		const commands = new Map<string, any>();
		let closeOverlay: (() => void) | undefined;
		let closed = false;
		tasksExtension(
			{
				registerTool() {},
				on() {},
				registerCommand(name: string, definition: any) {
					commands.set(name, definition);
				},
			} as any,
			{
				runCommand: async () => ({ stdout: JSON.stringify({ tasks: [task] }), stderr: "", exitCode: 0 }),
			},
		);

		const ctx = {
			cwd: "/tmp/project",
			ui: {
				custom(factory: any) {
					factory({ requestRender() {} }, theme, {}, () => {
						closed = true;
						closeOverlay?.();
					});
					return new Promise<void>((resolve) => {
						closeOverlay = resolve;
					});
				},
				setWidget() {},
			},
		};

		const opened = commands.get("tasks").handler("", ctx);
		await Promise.resolve();
		await Promise.resolve();
		await commands.get("tasks").handler("", ctx);
		await opened;

		expect(closed).toBe(true);
	});

	test("alt+t toggles only the task HUD Kanban", async () => {
		const shortcuts = new Map<string, any>();
		let widget: { render(width: number): string[] } | undefined;
		let listCalls = 0;
		tasksExtension(
			{
				registerTool() {},
				on() {},
				registerShortcut(key: string, definition: any) {
					shortcuts.set(key, definition);
				},
			} as any,
			{
				runCommand: async () => {
					listCalls++;
					return { stdout: JSON.stringify({ tasks: [task] }), stderr: "", exitCode: 0 };
				},
			},
		);
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				setWidget(_id: string, factory: any) {
					widget = factory({}, theme);
				},
			},
		};

		await shortcuts.get("alt+t").handler(ctx);
		expect(widget?.render(120).join("\n")).toContain("1 tasks");
		expect(widget?.render(120).join("\n")).not.toContain("Ready (1)");
		await shortcuts.get("alt+t").handler(ctx);
		expect(widget?.render(120).join("\n")).toContain("1 tasks");
		expect(widget?.render(120).join("\n")).toContain("Ready (1)");
		expect(listCalls).toBe(2);
	});

	test("/tasks task board mutations shell out through ct and refresh HUD", async () => {
		const commands = new Map<string, any>();
		const calls: string[][] = [];
		let component: any;
		let widgetText = "";
		tasksExtension(
			{
				registerTool() {},
				on() {},
				getSessionName: () => "Current Session",
				registerCommand(name: string, definition: any) {
					commands.set(name, definition);
				},
			} as any,
			{
				runCommand: async (command: string, args: string[]) => {
					calls.push([command, ...args]);
					if (args[1] === "update") {
						return {
							stdout: JSON.stringify({ task: { ...task, assigned_to: "session:current" } }),
							stderr: "",
							exitCode: 0,
						};
					}
					if (args[1] === "delete") {
						return { stdout: JSON.stringify({ deleted: args[2] }), stderr: "", exitCode: 0 };
					}
					return { stdout: JSON.stringify({ tasks: [task] }), stderr: "", exitCode: 0 };
				},
			},
		);

		await commands.get("tasks").handler("", {
			cwd: "/tmp/project",
			sessionId: "current",
			ui: {
				custom(factory: any) {
					component = factory({ requestRender() {} }, theme, {}, () => {});
					return Promise.resolve();
				},
				setWidget(_id: string, factory: any) {
					widgetText = factory({}, theme).render(220).join("\n");
				},
			},
		});

		component.handleInput("a");
		await component.waitForIdle();
		component.handleInput("+");
		await component.waitForIdle();
		component.handleInput("D");
		component.handleInput("y");
		await component.waitForIdle();

		expect(calls).toContainEqual([
			"ct",
			"task",
			"update",
			"PG4W2K4Q03",
			"--assigned-to",
			"session:current",
			"--assigned-label",
			"Current Session",
			"--json",
		]);
		expect(calls).toContainEqual(["ct", "task", "update", "PG4W2K4Q03", "--priority", "1", "--json"]);
		expect(calls).toContainEqual(["ct", "task", "delete", "PG4W2K4Q03", "--json"]);
		expect(calls.filter((call) => call.join(" ") === "ct task list --all --json").length).toBeGreaterThan(3);
		expect(widgetText).toContain("Smoke test");
	});

	test("builds ct task commands with json output", () => {
		expect(buildTaskCommand("add", { title: "Fix bug", body: "details" })).toEqual([
			"task",
			"add",
			"Fix bug",
			"--body",
			"details",
			"--json",
		]);
		expect(buildTaskCommand("update", { id: "ABC", status: "done", priority: 3 })).toEqual([
			"task",
			"update",
			"ABC",
			"--status",
			"done",
			"--priority",
			"3",
			"--json",
		]);
		expect(
			buildTaskCommand("update", {
				id: "ABC",
				epic_id: "task-board",
				epic_title: "Task Board",
				clear_epic: true,
			}),
		).toEqual([
			"task",
			"update",
			"ABC",
			"--epic-id",
			"task-board",
			"--epic-title",
			"Task Board",
			"--clear-epic",
			"--json",
		]);
		expect(
			buildTaskCommand("add", { title: "Render DAG", assigned_to: "session:abc", blocked_by: ["abc", "def"] }),
		).toEqual([
			"task",
			"add",
			"Render DAG",
			"--assigned-to",
			"session:abc",
			"--blocked-by",
			"abc",
			"--blocked-by",
			"def",
			"--json",
		]);
	});

	test("registers task tools that shell out to ct and return parsed details", async () => {
		const calls: string[][] = [];
		const tools: any[] = [];
		tasksExtension(
			{
				registerTool(tool: any) {
					tools.push(tool);
				},
				on() {},
			} as any,
			{
				runCommand: async (command: string, args: string[]) => {
					calls.push([command, ...args]);
					return { stdout: JSON.stringify({ task }), stderr: "", exitCode: 0 };
				},
			},
		);

		const add = tools.find((tool) => tool.name === "task_add");
		expect(add).toBeTruthy();
		const result = await add.execute("call-1", { title: "Persist task" }, undefined);
		expect(calls).toEqual([["ct", "task", "add", "Persist task", "--json"]]);
		expect(result.content[0].text).toBe(JSON.stringify({ task }));
		expect(result.details.task.id).toBe(task.id);
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"task_add",
			"task_delete",
			"task_list",
			"task_show",
			"task_update",
		]);
	});

	test("renders a compact HUD for active tasks", () => {
		const lines = renderHudLines(
			[
				{ ...task, id: "BLOCKED123", title: "Blocked task", priority: 100, blocked_by: ["PG4W2K4Q03"] },
				{ ...task, priority: 1, assigned_to: "session:test-session" },
				{ ...task, id: "DONE123ABC", title: "Done task", status: "done" },
				{ ...task, id: "CANCEL123A", title: "Canceled task", status: "canceled" },
			],
			theme as any,
			120,
			6,
			{ currentAssignment: "session:test-session", currentLabel: "Named Session" },
		);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
		expect(lines.join("\n")).toContain("3 tasks");
		expect(lines.join("\n")).toContain("1 done");
		expect(lines.join("\n")).toContain("PG4W2K4Q03");
		expect(lines.join("\n")).toContain("Ready (1)");
		expect(lines.join("\n")).toContain("Blocked (1)");
		expect(lines.join("\n")).toContain("Done (1)");
		expect(lines.join("\n")).toContain(" Ready");
		expect(lines.join("\n")).toContain(" Blocked");
		expect(lines.join("\n")).toContain(" In Progress");
		expect(lines.join("\n")).toContain(" Done");
		expect(lines.join("\n")).toContain("Smoke test");
		expect(lines.join("\n")).toContain("Done task");

		const empty = renderHudLines([], theme as any, 100);
		expect(empty).toEqual([]);
	});

	test("styles current and other session assignments differently", () => {
		const lines = renderHudLines(
			[
				{ ...task, title: "Current work", assigned_to: "session:current" },
				{ ...task, id: "OTHER1", title: "Other work", assigned_to: "session:other", assigned_label: "Other" },
			],
			markedTheme as any,
			1000,
			6,
			{ currentAssignment: "session:current", currentLabel: "Me" },
		).join("\n");

		expect(lines).toContain("<success> @Me");
		expect(lines).toContain("<dim>Other work</dim>");
		expect(lines).toContain("<dim> @Other</dim>");
		expect(lines).toContain("<mdHeading>●</mdHeading> <mdHeading>2 tasks</mdHeading> <muted>(");
		expect(lines).toContain("<syntaxPunctuation>OTHER</syntaxPunctuation><syntaxType>1</syntaxType>");
		expect(lines).toContain("<mdLink> Ready");
		expect(lines).toContain("<success> In Progress");
		expect(lines).toContain("<dim> Done");
		expect(lines).not.toContain("**<syntaxPunctuation>OTHER");
	});

	test("task HUD caps done tasks to five in recency order", () => {
		const lines = renderHudLines(
			Array.from({ length: 7 }, (_, index) => ({
				...task,
				id: `DONE${index}`,
				title: `Done ${index}`,
				status: "done",
				updated_at: index,
			})),
			theme as any,
			160,
			6,
		).join("\n");

		expect(lines).toContain("Done 6");
		expect(lines).toContain("Done 2");
		expect(lines).not.toContain("Done 1");
		expect(lines).not.toContain("Done 0");
		expect(lines).toContain("Done (7 – 2 hidden)");
		expect(lines).not.toContain("… and 2 more");
	});

	test("refreshes the HUD on session start and after mutations", async () => {
		const calls: string[][] = [];
		const handlers: Record<string, any> = {};
		let widgetText = "";
		const tools: any[] = [];
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				setWidget(_id: string, factory: any) {
					const component = factory({}, theme);
					widgetText = component.render(120).join("\n");
				},
			},
		};

		tasksExtension(
			{
				registerTool(tool: any) {
					tools.push(tool);
				},
				on(name: string, handler: any) {
					handlers[name] = handler;
				},
			} as any,
			{
				runCommand: async (command: string, args: string[]) => {
					calls.push([command, ...args]);
					if (args[1] === "list") return { stdout: JSON.stringify({ tasks: [task] }), stderr: "", exitCode: 0 };
					return { stdout: JSON.stringify({ task }), stderr: "", exitCode: 0 };
				},
			},
		);

		await handlers.session_start({}, ctx);
		expect(widgetText).toContain("PG4W2K4Q03");

		const update = tools.find((tool) => tool.name === "task_update");
		await update.execute("call-2", { id: "PG4", status: "done" }, undefined, undefined, ctx);
		expect(calls.map((call) => call.slice(1, 3))).toContainEqual(["task", "update"]);
		expect(calls.map((call) => call.slice(1, 3))).toContainEqual(["task", "list"]);
		expect(calls).toContainEqual(["ct", "task", "list", "--all", "--json"]);
		expect(widgetText).toContain("Smoke test");
	});

	test("task HUD switches between hidden and full as terminal rows change", async () => {
		const originalRows = process.stdout.rows;
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 20 });
		const handlers: Record<string, any> = {};
		let widget: { render(width: number): string[] } | undefined;
		try {
			tasksExtension(
				{
					registerTool() {},
					on(name: string, handler: any) {
						handlers[name] = handler;
					},
				} as any,
				{
					runCommand: async () => ({ stdout: JSON.stringify({ tasks: [task] }), stderr: "", exitCode: 0 }),
				},
			);

			await handlers.session_start(undefined, {
				cwd: "/tmp/project",
				ui: {
					setWidget(_id: string, factory: any) {
						widget = factory({}, theme);
					},
				},
			});
			expect(widget?.render(120)).toEqual([]);
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
			expect(widget?.render(120).join("\n")).toContain("Smoke test");
		} finally {
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: originalRows });
		}
	});

	test("renders names for assigned sessions from session files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-session-name-"));
		const sessionId = "2026-05-03T10-00-00-000Z_named-session";
		writeFileSync(
			join(dir, `${sessionId}.jsonl`),
			[
				JSON.stringify({ type: "session", id: "named-session" }),
				JSON.stringify({ type: "session_info", name: "Other Work" }),
				"",
			].join("\n"),
		);
		const handlers: Record<string, any> = {};
		let widgetText = "";
		tasksExtension(
			{
				registerTool() {},
				on(name: string, handler: any) {
					handlers[name] = handler;
				},
			} as any,
			{
				runCommand: async () => ({
					stdout: JSON.stringify({ tasks: [{ ...task, assigned_to: `session:${sessionId}` }] }),
					stderr: "",
					exitCode: 0,
				}),
			},
		);

		await handlers.session_start(undefined, {
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => join(dir, "current.jsonl") },
			ui: {
				setWidget(_id: string, factory: any) {
					widgetText = factory({}, theme).render(220).join("\n");
				},
			},
		});

		expect(widgetText).toContain("@Other Work");
		expect(widgetText).not.toContain(sessionId);
	});

	test("does not resolve assigned session labels outside the session directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-session-name-"));
		const handlers: Record<string, any> = {};
		let widgetText = "";
		tasksExtension(
			{
				registerTool() {},
				on(name: string, handler: any) {
					handlers[name] = handler;
				},
			} as any,
			{
				runCommand: async () => ({
					stdout: JSON.stringify({ tasks: [{ ...task, assigned_to: "session:../secret" }] }),
					stderr: "",
					exitCode: 0,
				}),
			},
		);

		await handlers.session_start(undefined, {
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => join(dir, "current.jsonl") },
			ui: {
				setWidget(_id: string, factory: any) {
					widgetText = factory({}, theme).render(220).join("\n");
				},
			},
		});

		expect(widgetText).toContain("@../secret");
	});

	test("reminds the current session about assigned unfinished tasks at turn end", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-current-name-"));
		writeFileSync(join(dir, "test-session.jsonl"), `${JSON.stringify({ type: "session_info", name: "Tasks" })}\n`);
		const handlers: Record<string, any> = {};
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				on(name: string, handler: any) {
					handlers[name] = handler;
				},
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			} as any,
			{
				runCommand: async () => ({
					stdout: JSON.stringify({
						tasks: [
							{ ...task, assigned_to: "session:test-session", status: "open" },
							{
								...task,
								id: "DONE1",
								title: "Done assigned",
								assigned_to: "session:test-session",
								status: "done",
							},
							{ ...task, id: "OTHER1", title: "Other session", assigned_to: "session:other", status: "open" },
						],
					}),
					stderr: "",
					exitCode: 0,
				}),
			},
		);

		await handlers.turn_end(
			{},
			{
				cwd: "/tmp/project",
				signal: undefined,
				sessionManager: { getSessionFile: () => join(dir, "test-session.jsonl") },
				ui: { notify() {} },
			},
		);

		expect(sent).toHaveLength(1);
		expect(sent[0].message.content[0].text).toContain("for @Tasks:");
		expect(sent[0].message.content[0].text).not.toContain("session:test-session");
		expect(sent[0].message.content[0].text).toContain("Smoke test task tools");
		expect(sent[0].message.content[0].text).not.toContain("Done assigned");
		expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });

		await handlers.turn_end(
			{},
			{
				cwd: "/tmp/project",
				signal: undefined,
				sessionManager: { getSessionFile: () => join(dir, "test-session.jsonl") },
				ui: { notify() {} },
			},
		);
		expect(sent).toHaveLength(1);
	});

	test("renders task calls and results without dumping raw JSON", () => {
		const tools: any[] = [];
		tasksExtension(
			{
				registerTool(tool: any) {
					tools.push(tool);
				},
				on() {},
			} as any,
			{
				runCommand: async () => ({ stdout: JSON.stringify({ task }), stderr: "", exitCode: 0 }),
			},
		);

		const add = tools.find((tool) => tool.name === "task_add");
		const callText = add.renderCall({ title: "Make HUD nice" }, theme).render(120).join("\n");
		expect(callText).toContain("Add task");
		expect(callText).toContain("Make HUD nice");

		const resultText = add.renderResult({ details: { action: "add", task } }, {}, theme, {
			lastComponent: createText(),
		});
		const rendered = resultText.render(120).join("\n");
		expect(rendered).toContain("Task added");
		expect(rendered).toContain("PG4W2K4Q03");
		expect(rendered).not.toContain('{"task"');

		expect(
			renderTaskResult({ action: "show", args: [], task: { ...task, blocked_by: ["abc"] } }, theme as any),
		).toContain("blocked by abc");
		expect(renderTaskResult({ action: "list", args: [], tasks: [task] }, theme as any)).toContain("Tasks (1)");
	});

	test("task renderer output is width-safe", () => {
		const longTask = {
			...task,
			title: "A very long task title that should never break the terminal layout even in narrow panes",
			body: "A very long body that should be safely truncated by the custom component renderer.",
		};
		const tools: any[] = [];
		tasksExtension(
			{
				registerTool(tool: any) {
					tools.push(tool);
				},
				on() {},
			} as any,
			{
				runCommand: async () => ({ stdout: JSON.stringify({ task: longTask }), stderr: "", exitCode: 0 }),
			},
		);

		const show = tools.find((tool) => tool.name === "task_show");
		const component = show.renderResult({ details: { action: "show", task: longTask } }, {}, theme, {});
		expect(component.render(30).every((line: string) => visibleWidth(line) <= 30)).toBe(true);
	});
});
