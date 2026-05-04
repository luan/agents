import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionComponent } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

import tasksExtension, {
	buildTaskBoardColumns,
	buildTaskCommand,
	renderHudLines,
	renderTaskBoardLines,
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

const ansiTheme = {
	fg(_role: string, text: string) {
		return `\x1b[31m${text}\x1b[39m`;
	},
	bg(_role: string, text: string) {
		return `\x1b[48;5;24m${text}\x1b[49m`;
	},
	bold(text: string) {
		return `\x1b[1m${text}\x1b[22m`;
	},
	strikethrough(text: string) {
		return `\x1b[9m${text}\x1b[29m`;
	},
};

const truecolorTheme = {
	...theme,
	bg(_role: string, text: string) {
		return `\x1b[48;2;100;80;200m${text}\x1b[49m`;
	},
	getBgAnsi() {
		return "\x1b[48;2;100;80;200m";
	},
};

describe("tasks extension", () => {
	test("groups task board columns with derived blocked state", () => {
		const tasks = [
			{ ...task, id: "DONE", status: "done", title: "Finished" },
			{ ...task, id: "ACTIVE", status: "in_progress", title: "Active" },
			{ ...task, id: "READY", status: "todo", title: "Ready todo", priority: 1 },
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

	test("treats active child tasks as parent blockers", () => {
		const tasks = [
			{ ...task, id: "PARENT", title: "Parent", priority: 10 },
			{ ...task, id: "CHILD", title: "Child", parent_id: "PARENT", priority: 1 },
		];

		const columns = buildTaskBoardColumns(tasks);
		expect(columns[0].tasks.map((item) => item.id)).toEqual(["CHILD"]);
		expect(columns[1].tasks.map((item) => item.id)).toEqual(["PARENT"]);
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

	test("task board does not space-cycle parents with active children", async () => {
		const calls: unknown[] = [];
		const board = new TaskBoardOverlay({
			tasks: [
				{ ...task, id: "PARENT", status: "open", priority: 10 },
				{ ...task, id: "CHILD", status: "open", parent_id: "PARENT" },
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

	test("task board shows mutation failures without throwing raw runner errors", async () => {
		const board = new TaskBoardOverlay({
			tasks: [task],
			theme: theme as any,
			onClose: () => {},
			onReload: async () => [task],
			onMutate: async () => {
				throw new Error(
					"ct task delete vf --json failed with exit code 1: Error: cannot delete task vf; blocked by mg",
				);
			},
		});

		board.handleInput("D");
		board.handleInput("y");
		await board.waitForIdle();

		const rendered = board.render(100).join("\n");
		expect(rendered).toContain("Delete failed: cannot delete task vf; blocked by mg");
		expect(rendered).not.toContain("ct task delete");
	});

	test("task board blocks deleting tasks with dependents before shelling out", async () => {
		const calls: unknown[] = [];
		const board = new TaskBoardOverlay({
			tasks: [
				{ ...task, id: "vf" },
				{ ...task, id: "mg", blocked_by: ["vf"] },
			],
			theme: theme as any,
			onClose: () => {},
			onReload: async () => [],
			onMutate: async (_action, params) => {
				calls.push(params);
				return [];
			},
		});

		board.handleInput("D");
		board.handleInput("y");
		await board.waitForIdle();

		expect(calls).toEqual([]);
		expect(board.render(100).join("\n")).toContain("Delete failed: cannot delete task vf; blocked by mg");
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
		expect(widget?.render(120).join("\n")).not.toContain("1 tasks");
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
				parent_id: "parent",
				clear_parent: true,
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
			"--parent-id",
			"parent",
			"--clear-parent",
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

	test("renders a full HUD for active tasks", () => {
		const lines = renderHudLines(
			[
				{ ...task, id: "BLOCKED123", title: "Blocked task", priority: 100, blocked_by: ["PG4W2K4Q03"] },
				{ ...task, priority: 1, assigned_to: "session:test-session" },
				{ ...task, id: "DONE123ABC", title: "Done task", status: "done", assigned_to: "session:test-session" },
				{ ...task, id: "CANCEL123A", title: "Canceled task", status: "canceled" },
			],
			theme as any,
			120,
			6,
			{ currentAssignment: "session:test-session", currentLabel: "Named Session" },
		);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
		expect(lines.join("\n")).not.toContain("● 3 tasks");
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

		const compact = renderHudLines(
			[
				{ ...task, id: "BLOCKED123", title: "Blocked task", priority: 100, blocked_by: ["PG4W2K4Q03"] },
				{ ...task, priority: 1, assigned_to: "session:test-session" },
				{ ...task, id: "DONE123ABC", title: "Done task", status: "done", assigned_to: "session:test-session" },
			],
			theme as any,
			120,
			6,
			{ currentAssignment: "session:test-session", currentLabel: "Named Session" },
			{ hideKanban: true },
		).join("\n");
		expect(compact).toContain("3 tasks");
		expect(compact).toContain("1 done");

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
		expect(lines).not.toContain("<mdHeading>●</mdHeading> <mdHeading>2 tasks</mdHeading> <muted>(");
		expect(lines).toContain("<syntaxPunctuation>OTHER</syntaxPunctuation><syntaxType>1</syntaxType>");
		expect(lines).toContain("<mdLink> Ready");
		expect(lines).toContain("<success> In Progress");
		expect(lines).toContain("<dim> Done");
		expect(lines).not.toContain("**<syntaxPunctuation>OTHER");
	});

	test("task HUD shows only current-session done tasks", () => {
		const lines = renderHudLines(
			[
				{ ...task, id: "OTHERDONE", title: "Other done", status: "done", assigned_to: "session:other" },
				{ ...task, id: "CURDONE", title: "Current done", status: "done", assigned_to: "session:current" },
				{ ...task, id: "READY", title: "Ready", blocked_by: ["OTHERDONE"] },
			],
			theme as any,
			140,
			6,
			{ currentAssignment: "session:current", currentLabel: "Current" },
		).join("\n");

		expect(lines).not.toContain("2 tasks");
		expect(lines).toContain("Current done");
		expect(lines).toContain("READY");
		expect(lines).not.toContain("Other done");
		expect(lines).not.toContain("Blocked (1)");
	});

	test("task HUD shows epic group headers ordered by current session then priority with ungrouped first", () => {
		const lines = renderHudLines(
			[
				{
					...task,
					id: "CURREPIC",
					title: "Current epic task",
					epic_id: "current",
					epic_title: "Current Epic",
					priority: 2,
					assigned_to: "session:current",
				},
				{
					...task,
					id: "HIGHEPIC",
					title: "High epic task",
					epic_id: "high",
					epic_title: "High Epic",
					priority: 100,
				},
				{ ...task, id: "NOEPIC", title: "Ungrouped task", priority: 0 },
			],
			theme as any,
			180,
			6,
			{ currentAssignment: "session:current", currentLabel: "Current" },
		).join("\n");

		expect(lines).toContain("No epic");
		expect(lines).toContain("Current Epic");
		expect(lines).toContain("High Epic");
		expect(lines.indexOf("No epic")).toBeLessThan(lines.indexOf("Current Epic"));
		expect(lines.indexOf("Current Epic")).toBeLessThan(lines.indexOf("High Epic"));
	});

	test("task HUD highlights flashed task cards with background", () => {
		const lines = renderHudLines(
			[
				{
					...task,
					id: "FLASH",
					title: "Flashed task with a very long title that must truncate inside the highlighted card",
				},
			],
			ansiTheme as any,
			66,
			6,
			{},
			{ flashTaskIds: new Set(["FLASH"]) },
		).join("\n");

		expect(lines).toContain("…");
		expect(lines).not.toContain("...");
		expect(lines).toMatch(/\x1b\[48;5;24m[^\n]*…[^\n]*\x1b\[49m/);
	});

	test("task HUD pulse uses an opacity-gradient background for active flashes", () => {
		const start = renderHudLines(
			[{ ...task, id: "PULSE", title: "Pulsing task" }],
			truecolorTheme as any,
			100,
			6,
			{},
			{
				flashTasks: new Map([["PULSE", { startedAt: 1000, until: 6000 }]]),
				now: 1000,
			},
		).join("\n");
		const peak = renderHudLines(
			[{ ...task, id: "PULSE", title: "Pulsing task" }],
			truecolorTheme as any,
			100,
			6,
			{},
			{
				flashTasks: new Map([["PULSE", { startedAt: 1000, until: 6000 }]]),
				now: 1450,
			},
		).join("\n");

		expect(start).toContain("\x1b[48;2;18;14;36m");
		expect(peak).toContain("\x1b[48;2;63;50;126m");
		expect(start).not.toContain("\x1b[2m");
		expect(peak).toContain("Pulsing task");
	});

	test("task HUD caps current-session done tasks to five in recency order", () => {
		const lines = renderHudLines(
			Array.from({ length: 7 }, (_, index) => ({
				...task,
				id: `DONE${index}`,
				title: `Done ${index}`,
				status: "done",
				assigned_to: "session:current",
				updated_at: index,
			})),
			theme as any,
			160,
			6,
			{ currentAssignment: "session:current" },
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
		let widget: { render(width: number): string[] } | undefined;
		let widgetRegistrations = 0;
		let currentTask = task;
		const tools: any[] = [];
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				setWidget(_id: string, factory: any) {
					widgetRegistrations++;
					widget = factory(
						{
							requestRender() {
								widgetText = widget?.render(120).join("\n") ?? "";
							},
						},
						theme,
					);
					widgetText = widget?.render(120).join("\n") ?? "";
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
					if (args[1] === "list") {
						return { stdout: JSON.stringify({ tasks: [currentTask] }), stderr: "", exitCode: 0 };
					}
					currentTask = { ...task, title: "Updated smoke test task tools" };
					return { stdout: JSON.stringify({ task: currentTask }), stderr: "", exitCode: 0 };
				},
			},
		);

		await handlers.session_start({}, ctx);
		expect(widgetText).toContain("PG4W2K4Q03");
		expect(widgetRegistrations).toBe(1);

		const update = tools.find((tool) => tool.name === "task_update");
		await update.execute("call-2", { id: "PG4", title: "Updated smoke test task tools" }, undefined, undefined, ctx);
		expect(calls.map((call) => call.slice(1, 3))).toContainEqual(["task", "update"]);
		expect(calls.map((call) => call.slice(1, 3))).toContainEqual(["task", "list"]);
		expect(calls).toContainEqual(["ct", "task", "list", "--all", "--json"]);
		expect(widgetRegistrations).toBe(1);
		expect(widgetText).toContain("Updated smoke");
	});

	test("task mutations flash the changed task in the HUD", async () => {
		const tools: any[] = [];
		let widgetText = "";
		tasksExtension(
			{
				registerTool(tool: any) {
					tools.push(tool);
				},
				on() {},
			} as any,
			{
				runCommand: async (_command: string, args: string[]) => {
					if (args[1] === "list") return { stdout: JSON.stringify({ tasks: [task] }), stderr: "", exitCode: 0 };
					return { stdout: JSON.stringify({ task }), stderr: "", exitCode: 0 };
				},
			},
		);

		const update = tools.find((tool) => tool.name === "task_update");
		await update.execute("call-2", { id: "PG4", status: "in_progress" }, undefined, undefined, {
			cwd: "/tmp/project",
			ui: {
				setWidget(_id: string, factory: any) {
					widgetText = factory({}, markedTheme).render(1000).join("\n");
				},
				notify() {},
			},
		});

		expect(widgetText).toContain("<selectedBg>");
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

	test("renders short uuid prefixes for unnamed sessions", async () => {
		const sessionA = "2026-05-03T10-00-00-000Z_019df09a-b948-778e-bd9f-553ff3d237d3";
		const sessionB = "2026-05-03T10-00-00-000Z_019df09b-b948-778e-bd9f-553ff3d237d3";
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
					stdout: JSON.stringify({
						tasks: [
							{ ...task, id: "SESSIONA", assigned_to: `session:${sessionA}` },
							{ ...task, id: "SESSIONB", assigned_to: `session:${sessionB}` },
						],
					}),
					stderr: "",
					exitCode: 0,
				}),
			},
		);

		await handlers.session_start(undefined, {
			cwd: "/tmp/project",
			ui: {
				setWidget(_id: string, factory: any) {
					widgetText = factory({ requestRender() {} }, theme)
						.render(260)
						.join("\n");
				},
			},
		});

		expect(widgetText).toContain("@019df09a");
		expect(widgetText).toContain("@019df09b");
		expect(widgetText).not.toContain("2026-05-03");
		expect(widgetText).not.toContain("b948-778e");
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

	test("task guard hides premature stop and triggers hidden continuation", async () => {
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
							{ ...task, id: "t", title: "Continue me", assigned_to: "session:test-session", status: "open" },
						],
					}),
					stderr: "",
					exitCode: 0,
				}),
			},
		);
		const ctx = {
			cwd: "/tmp/project",
			sessionId: "test-session",
			signal: undefined,
			ui: { notify() {} },
		};

		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
			ctx,
		);
		await handlers.turn_end({}, ctx);

		expect(replacement.message.content).toEqual([]);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.customType).toBe("task-guard");
		expect(sent[0].message.display).toBe(false);
		expect(sent[0].message.content[0].text).toContain("Start assigned task t");
		expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	test("task guard keeps imperative answers visible while continuing", async () => {
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
							{ ...task, id: "t", title: "Continue me", assigned_to: "session:test-session", status: "open" },
						],
					}),
					stderr: "",
					exitCode: 0,
				}),
			},
		);
		const ctx = {
			cwd: "/tmp/project",
			sessionId: "test-session",
			signal: undefined,
			ui: { notify() {} },
		};

		await handlers.message_end({ message: { role: "user", content: [{ type: "text", text: "show status" }] } }, ctx);
		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Status: one task remains." }] } },
			ctx,
		);
		await handlers.turn_end({}, ctx);

		expect(replacement).toBeUndefined();
		expect(sent).toHaveLength(1);
		expect(sent[0].message.display).toBe(false);
	});

	test("task guard keeps answers visible when evaluation fails", async () => {
		const handlers: Record<string, any> = {};
		const notifications: string[] = [];
		tasksExtension(
			{
				registerTool() {},
				on(name: string, handler: any) {
					handlers[name] = handler;
				},
			} as any,
			{
				runCommand: async () => {
					throw new Error("ct unavailable");
				},
			},
		);

		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
			{
				cwd: "/tmp/project",
				sessionId: "test-session",
				signal: undefined,
				ui: {
					notify(message: string) {
						notifications.push(message);
					},
				},
			},
		);

		expect(replacement).toBeUndefined();
		expect(notifications[0]).toContain("Task guard failed");
	});

	test("task guard escalates after one retry without progress", async () => {
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
							{ ...task, id: "t", title: "Still open", status: "open", assigned_to: "session:test-session" },
						],
					}),
					stderr: "",
					exitCode: 0,
				}),
			},
		);
		const ctx = {
			cwd: "/tmp/project",
			sessionId: "test-session",
			signal: undefined,
			ui: {
				setWidget() {},
				notify() {},
			},
		};

		await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		await handlers.turn_end({}, ctx);
		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Done again." }] } },
			ctx,
		);

		expect(sent).toHaveLength(1);
		expect(replacement.message.content[0].text).toContain("Task guard stalled");
		expect(replacement.message.content[0].text).toContain("Required next action");
	});

	test("task guard assigns unassigned blockers before continuing", async () => {
		const handlers: Record<string, any> = {};
		const sent: any[] = [];
		const calls: string[][] = [];
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
				runCommand: async (command: string, args: string[]) => {
					calls.push([command, ...args]);
					if (args[1] === "update") {
						return {
							stdout: JSON.stringify({ task: { ...task, id: "b", assigned_to: "session:test-session" } }),
							stderr: "",
							exitCode: 0,
						};
					}
					return {
						stdout: JSON.stringify({
							tasks: [
								{
									...task,
									id: "a",
									title: "Assigned task",
									assigned_to: "session:test-session",
									blocked_by: ["b"],
								},
								{ ...task, id: "b", title: "Unassigned blocker" },
							],
						}),
						stderr: "",
						exitCode: 0,
					};
				},
			},
		);
		const ctx = {
			cwd: "/tmp/project",
			sessionId: "test-session",
			signal: undefined,
			ui: {
				setWidget() {},
				notify() {},
			},
		};

		await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		await handlers.turn_end({}, ctx);

		expect(calls).toContainEqual(["ct", "task", "update", "b", "--assigned-to", "session:test-session", "--json"]);
		expect(sent[0].message.content[0].text).toContain("Task b to unblock a has been assigned");
		expect(sent[0].message.display).toBe(false);
	});

	test("task tools render no call or result UI", () => {
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
		expect(add.renderCall({ title: "Make HUD nice" }, theme).render(120)).toEqual([]);
		expect(add.renderResult({ details: { action: "add", task } }, {}, theme, {}).render(120)).toEqual([]);
		const row = new ToolExecutionComponent(
			"task_add",
			"call-1",
			{ title: "Make HUD nice" },
			{},
			add,
			{ requestRender() {} } as any,
			"/tmp/project",
		);
		expect(row.render(120)).toEqual([]);
		row.updateResult({ content: [], details: { action: "add", task }, isError: false });
		expect(row.render(120)).toEqual([]);
	});
});
