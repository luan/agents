import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

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
	epic_id: "test-epic",
	epic_title: "Test Epic",
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
			{ ...task, id: "REVIEW", status: "in_review", type: "feature", title: "Review" },
			{ ...task, id: "READY", status: "todo", title: "Ready todo", priority: 1 },
			{ ...task, id: "BLOCK", title: "Blocked by active", blocked_by: ["ACTIVE"] },
			{ ...task, id: "UNBLOCK", title: "Unblocked by done", blocked_by: ["DONE"], priority: 5 },
			{ ...task, id: "CANCEL", status: "canceled", title: "Hidden" },
		];

		const columns = buildTaskBoardColumns(tasks);
		expect(columns.map((column) => column.label)).toEqual(["Ready", "Blocked", "In Progress", "In Review", "Done"]);
		expect(columns[0].tasks.map((item) => item.id)).toEqual(["UNBLOCK", "READY"]);
		expect(columns[1].tasks.map((item) => item.id)).toEqual(["BLOCK"]);
		expect(columns[2].tasks.map((item) => item.id)).toEqual(["ACTIVE"]);
		expect(columns[3].tasks.map((item) => item.id)).toEqual(["REVIEW"]);
		expect(columns[4].tasks.map((item) => item.id)).toEqual(["DONE"]);
	});

	test("treats blocked in-review tasks as blocked instead of ready", () => {
		const tasks = [
			{ ...task, id: "BLOCKER", status: "in_progress", title: "Blocking task" },
			{
				...task,
				id: "REVIEW",
				status: "in_review",
				type: "bug",
				title: "Needs review after blocker",
				blocked_by: ["BLOCKER"],
			},
		];

		const columns = buildTaskBoardColumns(tasks);
		expect(columns.find((column) => column.id === "ready")?.tasks).toEqual([]);
		expect(columns.find((column) => column.id === "blocked")?.tasks.map((item) => item.id)).toEqual(["REVIEW"]);
		expect(columns.find((column) => column.id === "in_review")?.tasks).toEqual([]);
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

	test("renders structured task body sections in details", () => {
		const tasks = [
			{
				...task,
				id: "SPEC",
				title: "Structured task",
				body: [
					"Context / problem:",
					"",
					"The body should stay readable.",
					"",
					"Agent-verifiable acceptance criteria:",
					"- Shows body sections",
					"- Preserves bullet content",
					"",
					"Delivery evidence:",
					"- To be filled after commit",
				].join("\n"),
			},
		];

		const rendered = renderTaskBoardLines(tasks, markedTheme as any, 100).join("\n");

		expect(rendered).toContain("<dim>Body:</dim>");
		expect(rendered).toContain("<mdHeading>Context / problem:</mdHeading>");
		expect(rendered).toContain("<mdHeading>Agent-verifiable acceptance criteria:</mdHeading>");
		expect(rendered).toContain("<dim>•</dim> Shows body sections");
		expect(rendered).toContain("<mdHeading>Delivery evidence:</mdHeading>");
		expect(rendered).toContain("To be filled after commit");
	});

	test("renders per-epic task boards with hidden empty sections and progress", () => {
		const tasks = [
			{
				...task,
				id: "EPIC1",
				type: "epic",
				title: "Configurable Pi Git Tool Strategy",
				epic_id: "git-tool",
				priority: 10,
			},
			{ ...task, id: "READY1", type: "feature", title: "Ready child", epic_id: "git-tool" },
			{ ...task, id: "REVIEW1", type: "feature", title: "Review child", status: "in_review", epic_id: "git-tool" },
			{ ...task, id: "DONE1", type: "bug", title: "Done child", status: "done", epic_id: "git-tool" },
			{ ...task, id: "REJ1", type: "bug", title: "Rejected child", status: "rejected", epic_id: "git-tool" },
			{ ...task, id: "NOEPIC", type: "chore", title: "Ungrouped child", epic_id: undefined, epic_title: undefined },
		];

		const lines = renderTaskBoardLines(tasks, markedTheme as any, 220).join("\n");
		expect(lines).toContain("Epic:");
		expect(lines).toContain("Configurable Pi Git Tool Strategy");
		expect(lines).toContain("<success>git-tool</success>");
		expect(lines).toContain("1/4");
		expect(lines).toContain("<error> Rejected (1)</error>");
		expect(lines).toContain("<mdLink> Ready (1)</mdLink>");
		expect(lines).toContain("<accent> In Review (1)</accent>");
		expect(lines).toContain("<success> Done (1)</success>");
		expect(lines).not.toContain("No Epic:");
		expect(lines).not.toContain("Ungrouped child");
		expect(lines).not.toContain("In Progress (0)");
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
		done.handleInput("l");
		done.handleInput(" ");
		await done.waitForIdle();
		expect(calls.at(-1)).toEqual({ action: "update", params: { id: "PG4W2K4Q03", status: "open" } });
	});

	test("task board cycles feature and bug tasks through review lifecycle", async () => {
		const calls: Record<string, unknown>[] = [];
		const makeBoard = (selectedTask: Record<string, unknown>) =>
			new TaskBoardOverlay({
				tasks: [{ ...task, ...selectedTask }],
				theme: theme as any,
				onClose: () => {},
				onReload: async () => [{ ...task, ...selectedTask }],
				onMutate: async (_action, params) => {
					calls.push(params);
					return [{ ...task, ...selectedTask }];
				},
			});

		for (const selectedTask of [
			{ type: "feature", status: "open", expected: "in_progress" },
			{ type: "feature", status: "in_progress", expected: "in_review" },
			{ type: "bug", status: "rejected", expected: "in_progress" },
		]) {
			const board = makeBoard(selectedTask);
			if (selectedTask.status === "in_progress") {
				board.handleInput("l");
				board.handleInput("l");
			}
			board.handleInput(" ");
			await board.waitForIdle();
			expect(calls.at(-1)).toEqual({ id: "PG4W2K4Q03", status: selectedTask.expected });
		}

		const featureDoneKey = makeBoard({ type: "feature", status: "in_progress" });
		featureDoneKey.handleInput("l");
		featureDoneKey.handleInput("l");
		featureDoneKey.handleInput("d");
		await featureDoneKey.waitForIdle();
		expect(calls.at(-1)).toEqual({ id: "PG4W2K4Q03", status: "in_review" });

		const choreDoneKey = makeBoard({ type: "chore", status: "in_progress" });
		choreDoneKey.handleInput("l");
		choreDoneKey.handleInput("l");
		choreDoneKey.handleInput("d");
		await choreDoneKey.waitForIdle();
		expect(calls.at(-1)).toEqual({ id: "PG4W2K4Q03", status: "done" });
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
		expect(board.render(100).join("\n")).toContain("›  MID");
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
		expect(calls).toContainEqual(["ct", "task", "tui", "--json"]);
	});

	test("/tasks overlay navigation is local and does not shell out per key", async () => {
		const commands = new Map<string, any>();
		const calls: string[][] = [];
		let component: any;
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
					return {
						stdout: JSON.stringify({
							tasks: [
								{ ...task, id: "AAA", priority: 2 },
								{ ...task, id: "BBB", priority: 1 },
							],
						}),
						stderr: "",
						exitCode: 0,
					};
				},
			},
		);

		await commands.get("tasks").handler("", {
			cwd: "/tmp/project",
			ui: {
				custom(factory: any) {
					component = factory({ requestRender() {} }, theme, {}, () => {});
					return Promise.resolve();
				},
			},
		});
		const before = component.render(160).join("\n");
		const callsBeforeNavigation = calls.length;
		component.handleInput("j");
		component.handleInput("k");
		await component.waitForIdle();
		const after = component.render(160).join("\n");

		expect(before).toContain("AAA");
		expect(after).toContain("AAA");
		expect(calls.length).toBe(callsBeforeNavigation);
		expect(calls.filter((call) => call.join(" ") === "ct task tui --json")).toHaveLength(2);
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
		while (!closeOverlay) await Promise.resolve();
		await commands.get("tasks").handler("", ctx);
		await opened;

		expect(closed).toBe(true);
	});

	test("/tasks with an id opens the board focused on that task body", async () => {
		const calls: string[][] = [];
		const commands = new Map<string, any>();
		let overlayText = "";
		const body = [
			"Context / problem:",
			"",
			"Humans need to inspect this body.",
			"",
			"Agent-verifiable acceptance criteria:",
			"- Shows the full body",
			"- Does not truncate delivery evidence",
			"",
			"Delivery evidence:",
			"- Commit: abc123",
		].join("\n");
		tasksExtension(
			{
				registerCommand(name: string, command: any) {
					commands.set(name, command);
				},
				registerTool() {},
				on() {},
			} as any,
			{
				runCommand: async (command: string, args: string[]) => {
					calls.push([command, ...args]);
					return {
						stdout: JSON.stringify({
							tasks: [
								{ ...task, id: "OTHER", title: "Other task", body: "Wrong body" },
								{ ...task, id: "SPEC", title: "Structured issue", body, priority: 10 },
							],
						}),
						stderr: "",
						exitCode: 0,
					};
				},
			},
		);

		await commands.get("tasks").handler("SPEC", {
			cwd: "/repo",
			ui: {
				custom(factory: any) {
					const component = factory({ requestRender() {} }, markedTheme, {}, () => {});
					overlayText = component.render(120).join("\n");
					return Promise.resolve();
				},
			},
		});

		expect(calls).toContainEqual(["ct", "task", "tui", "--json"]);
		expect(overlayText).toContain("SPEC Structured issue");
		expect(overlayText).toContain("<dim>Body:</dim>");
		expect(overlayText).toContain("<mdHeading>Agent-verifiable acceptance criteria:</mdHeading>");
		expect(overlayText).toContain("<dim>•</dim> Does not truncate delivery evidence");
		expect(overlayText).toContain("Commit: abc123");
		expect(overlayText).not.toContain("Wrong body");
	});

	test("/accept and /reject shell out through shared ct review transitions", async () => {
		const calls: string[][] = [];
		const notifications: Array<{ message: string; type?: string }> = [];
		const sent: any[] = [];
		const commands = new Map<string, any>();
		tasksExtension(
			{
				registerCommand(name: string, command: any) {
					commands.set(name, command);
				},
				registerTool() {},
				on() {},
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			} as any,
			{
				runCommand: async (command: string, args: string[]) => {
					calls.push([command, ...args]);
					const status = args[1] === "reject" ? "rejected" : args[1] === "accept" ? "done" : task.status;
					return { stdout: JSON.stringify({ task: { ...task, status } }), stderr: "", exitCode: 0 };
				},
			},
		);

		const ctx = {
			cwd: "/repo",
			ui: {
				notify(message: string, type?: string) {
					notifications.push({ message, type });
				},
				setWidget() {},
			},
		};
		await commands.get("accept").handler("ABC do the next thing", ctx);
		await commands.get("reject").handler("ABC needs tests", ctx);

		expect(calls).toContainEqual(["ct", "task", "accept", "ABC", "--json"]);
		expect(calls).toContainEqual(["ct", "task", "reject", "ABC", "needs", "tests", "--json"]);
		expect(notifications).toContainEqual({ message: "Accepted PG4W2K4Q03: Smoke test task tools", type: "info" });
		expect(notifications).toContainEqual({ message: "Rejected PG4W2K4Q03: Smoke test task tools", type: "info" });
		expect(sent.map((item) => item.message)).toContainEqual({
			customType: "task-transition",
			content: [
				{
					type: "text",
					text: "Accepted PG4W2K4Q03: Smoke test task tools\n\nHuman note: do the next thing",
				},
			],
			display: true,
			details: { action: "accept", taskId: "PG4W2K4Q03", status: "done", note: "do the next thing" },
		});
		expect(sent.map((item) => item.message)).toContainEqual({
			customType: "task-transition",
			content: [{ type: "text", text: "Rejected PG4W2K4Q03: Smoke test task tools\n\nRejection note: needs tests" }],
			display: true,
			details: { action: "reject", taskId: "PG4W2K4Q03", status: "rejected", note: "needs tests" },
		});
		expect(sent.find((item) => item.message.details.action === "accept")?.options).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
		});
		expect(sent.find((item) => item.message.details.action === "reject")?.options).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
		});
		expect(sent.filter((item) => item.message.customType === "task-guard")).toHaveLength(0);
	});

	test("/accept triggers continuation for next ready task in the same epic", async () => {
		const commands = new Map<string, any>();
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, command: any) {
					commands.set(name, command);
				},
				on() {},
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			} as any,
			{
				runCommand: async (_command: string, args: string[]) => {
					if (args[1] === "accept") {
						return {
							stdout: JSON.stringify({
								task: {
									...task,
									id: "DONE",
									title: "Delivered task",
									type: "feature",
									status: "done",
									epic_id: "workflow",
									assigned_to: "session:test-session",
								},
							}),
							stderr: "",
							exitCode: 0,
						};
					}
					return {
						stdout: JSON.stringify({
							tasks: [
								{
									...task,
									id: "DONE",
									title: "Delivered task",
									type: "feature",
									status: "done",
									epic_id: "workflow",
									assigned_to: "session:test-session",
								},
								{ ...task, id: "NEXT", title: "Next ready task", type: "feature", epic_id: "workflow" },
							],
						}),
						stderr: "",
						exitCode: 0,
					};
				},
			},
		);
		const ctx = {
			cwd: "/repo",
			sessionId: "test-session",
			signal: undefined,
			ui: { notify() {}, setWidget() {} },
		};

		await commands.get("accept").handler("DONE", ctx);

		const taskGuardMessage = sent.find((item) => item.message.customType === "task-guard");
		expect(taskGuardMessage.message.content[0].text).toContain("Claim task NEXT");
		expect(taskGuardMessage.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	test("alt+t cycles compact and visible task HUD epics", async () => {
		const shortcuts = new Map<string, any>();
		let widget: { render(width: number): string[] } | undefined;
		let listCalls = 0;
		const tasks = [
			{ ...task, id: "EA", type: "epic", title: "Epic A", epic_id: "a", priority: 10 },
			{ ...task, id: "TA", title: "Task A", epic_id: "a", priority: 10 },
			{ ...task, id: "EB", type: "epic", title: "Epic B", epic_id: "b", priority: 1 },
			{ ...task, id: "TB", title: "Task B", epic_id: "b", priority: 1 },
		];
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
					return { stdout: JSON.stringify({ tasks }), stderr: "", exitCode: 0 };
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
		expect(widget?.render(120).join("\n")).toContain("2 tasks");
		expect(widget?.render(120).join("\n")).not.toContain("Task A");
		await shortcuts.get("alt+t").handler(ctx);
		expect(widget?.render(120).join("\n")).toContain("Task A");
		expect(widget?.render(120).join("\n")).not.toContain("Task B");
		await shortcuts.get("alt+t").handler(ctx);
		expect(widget?.render(120).join("\n")).toContain("Task B");
		expect(widget?.render(120).join("\n")).not.toContain("Task A");
		await shortcuts.get("alt+t").handler(ctx);
		expect(widget?.render(120).join("\n")).toContain("2 tasks");
		expect(widget?.render(120).join("\n")).not.toContain("Task A");
		expect(listCalls).toBe(1);
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
		expect(calls.filter((call) => call.join(" ") === "ct task tui --json").length).toBeGreaterThan(3);
		expect(widgetText).toContain("Smoke test");
	});

	test("builds ct task commands with json output", () => {
		expect(buildTaskCommand("add", { title: "Fix bug", type: "bug", body: "details", labels: ["setup"] })).toEqual([
			"task",
			"add",
			"Fix bug",
			"--type",
			"bug",
			"--body",
			"details",
			"--label",
			"setup",
			"--json",
		]);
		expect(buildTaskCommand("list", { type: "feature", label: "setup", epic_id: "task-board", all: true })).toEqual([
			"task",
			"list",
			"--type",
			"feature",
			"--label",
			"setup",
			"--epic-id",
			"task-board",
			"--all",
			"--json",
		]);
		expect(buildTaskCommand("update", { id: "ABC", type: "feature", status: "done", priority: 3 })).toEqual([
			"task",
			"update",
			"ABC",
			"--type",
			"feature",
			"--status",
			"done",
			"--priority",
			"3",
			"--json",
		]);
		expect(buildTaskCommand("accept", { id: "ABC" })).toEqual(["task", "accept", "ABC", "--json"]);
		expect(buildTaskCommand("reject", { id: "ABC", note: "needs tests" })).toEqual([
			"task",
			"reject",
			"ABC",
			"needs",
			"tests",
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

		const write = tools.find((tool) => tool.name === "task_write");
		const read = tools.find((tool) => tool.name === "task_read");
		expect(write).toBeTruthy();
		expect(read).toBeTruthy();
		const result = await write.execute("call-1", { op: "add", title: "Persist task" }, undefined);
		await read.execute("call-2", { mode: "show", id: "PG4" }, undefined);
		expect(calls).toEqual([
			["ct", "task", "add", "Persist task", "--json"],
			["ct", "task", "show", "PG4", "--json"],
		]);
		expect(result.content[0].text).toBe(JSON.stringify({ task }));
		expect(result.details.task.id).toBe(task.id);
		expect(tools.map((tool) => tool.name).sort()).toEqual(["task_read", "task_write"]);
		expect(Object.keys(write.parameters.properties).sort()).toEqual(["clear", "data", "id", "note", "op", "title"]);
	});

	test("task_write blocks agent story acceptance while slash accept remains human-owned", async () => {
		const calls: string[][] = [];
		const tools: any[] = [];
		const commands = new Map<string, any>();
		tasksExtension(
			{
				registerTool(tool: any) {
					tools.push(tool);
				},
				registerCommand(name: string, command: any) {
					commands.set(name, command);
				},
				on() {},
			} as any,
			{
				runCommand: async (command: string, args: string[]) => {
					calls.push([command, ...args]);
					return {
						stdout: JSON.stringify({ task: { ...task, type: "feature", status: "in_review" } }),
						stderr: "",
						exitCode: 0,
					};
				},
			},
		);

		const write = tools.find((tool) => tool.name === "task_write");
		await expect(write.execute("call-accept", { op: "accept", id: "PG4" }, undefined)).rejects.toThrow(
			"Agents cannot accept tasks",
		);
		await expect(
			write.execute("call-reject", { op: "reject", id: "PG4", note: "needs tests" }, undefined),
		).rejects.toThrow("Agents cannot reject tasks");
		await expect(
			write.execute("call-done", { op: "update", id: "PG4", data: { status: "done" } }, undefined),
		).rejects.toThrow("Agents cannot mark feature or bug tasks done");
		await write.execute(
			"call-chore-done",
			{ op: "update", id: "CHORE", data: { type: "chore", status: "done" } },
			undefined,
		);
		await commands.get("accept").handler("PG4", { cwd: "/repo", ui: {} });

		expect(calls).toContainEqual(["ct", "task", "show", "PG4", "--json"]);
		expect(calls).toContainEqual(["ct", "task", "update", "CHORE", "--type", "chore", "--status", "done", "--json"]);
		expect(calls).toContainEqual(["ct", "task", "accept", "PG4", "--json"]);
		expect(calls).not.toContainEqual(["ct", "task", "accept", "PG4", "--json", "--from-tool"]);
		expect(calls).not.toContainEqual(["ct", "task", "update", "PG4", "--status", "done", "--json"]);
	});

	test("renders a scoped columnar HUD for active tasks", () => {
		const lines = renderHudLines(
			[
				{ ...task, id: "BLOCKED123", title: "Blocked task", priority: 100, blocked_by: ["PG4W2K4Q03"] },
				{ ...task, priority: 1, assigned_to: "session:test-session" },
				{
					...task,
					id: "DONE123ABC",
					title: "Done task",
					status: "done",
					assigned_to: "session:test-session",
					updated_at: 1_000,
				},
				{ ...task, id: "REVIEW123", title: "Review task", type: "feature", status: "in_review" },
				{ ...task, id: "CANCEL123A", title: "Canceled task", status: "canceled" },
			],
			theme as any,
			120,
			6,
			{ currentAssignment: "session:test-session", currentLabel: "Named Session" },
			{ now: 1_000 },
		);
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
		expect(lines.join("\n")).not.toContain("● 3 tasks");
		expect(lines.join("\n")).toContain("PG4W2K4Q03");
		expect(lines.join("\n")).toContain("←1");
		expect(lines.join("\n")).toContain("Ready (1)");
		expect(lines.join("\n")).toContain("In Review (1)");
		expect(lines.join("\n")).toContain("Done (1)");
		expect(lines.join("\n")).toContain("Smoke test");
		expect(lines.join("\n")).toContain("Review task");
		expect(lines.join("\n")).toContain("Done task");

		const compact = renderHudLines(
			[
				{ ...task, id: "BLOCKED123", title: "Blocked task", priority: 100, blocked_by: ["PG4W2K4Q03"] },
				{ ...task, priority: 1, assigned_to: "session:test-session" },
				{ ...task, id: "REVIEW123", title: "Review task", type: "feature", status: "in_review" },
				{ ...task, id: "DONE123ABC", title: "Done task", status: "done", assigned_to: "session:test-session" },
			],
			theme as any,
			120,
			6,
			{ currentAssignment: "session:test-session", currentLabel: "Named Session" },
			{ hideKanban: true },
		).join("\n");
		expect(compact).toContain("3 tasks");
		expect(compact).toContain("1 in review");
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
			{ expandedEpicKey: "unknown:test-epic" },
		).join("\n");

		expect(lines).toContain("<muted>\x1b[3mself\x1b[23m</muted>");
		expect(lines).toContain("<dim>Other work</dim>");
		expect(lines).toContain("<mdLink>\x1b[3m@Other\x1b[23m</mdLink>");
		expect(lines).not.toContain("<mdHeading>●</mdHeading> <mdHeading>2 tasks</mdHeading> <muted>(");
		expect(lines).toContain("<syntaxPunctuation>OTHER</syntaxPunctuation><syntaxType>1</syntaxType>");
		expect(lines).toContain("<mdHeading>Epic:");
		expect(lines).not.toContain("<warning> In Progress (0)");
		expect(lines).not.toContain(" Done (0)");
		expect(lines).not.toContain("**<syntaxPunctuation>OTHER");
	});

	test("task rows render type icons labels assignees and hide priorities", () => {
		const lines = renderHudLines(
			[
				{
					...task,
					type: "feature",
					labels: ["setup", "agent-ui"],
					priority: 100,
					assigned_to: "session:current",
				},
				{
					...task,
					id: "BUG1",
					type: "bug",
					title: "Other bug",
					assigned_to: "session:other",
					assigned_label: "Other",
				},
			],
			markedTheme as any,
			1000,
			6,
			{ currentAssignment: "session:current", currentLabel: "Me" },
		).join("\n");

		expect(lines).toContain("<warning></warning>");
		expect(lines).toContain("<error></error>");
		expect(lines).toContain(
			"<syntaxString>\x1b[3msetup\x1b[23m</syntaxString>, <syntaxString>\x1b[3magent-ui\x1b[23m</syntaxString>",
		);
		expect(lines).toContain("<muted>\x1b[3mself\x1b[23m</muted>");
		expect(lines).toContain("<mdLink>\x1b[3m@Other\x1b[23m</mdLink>");
		expect(lines).not.toContain("p100");
		expect(lines).not.toContain("◻");
	});

	test("task HUD shows only current-session done tasks", () => {
		const lines = renderHudLines(
			[
				{ ...task, id: "OTHERDONE", title: "Other done", status: "done", assigned_to: "session:other" },
				{
					...task,
					id: "CURDONE",
					title: "Current done",
					status: "done",
					assigned_to: "session:current",
					updated_at: 1_000,
				},
				{ ...task, id: "READY", title: "Ready", blocked_by: ["OTHERDONE"] },
			],
			theme as any,
			140,
			6,
			{ currentAssignment: "session:current", currentLabel: "Current" },
			{ now: 1_000, expandedEpicKey: "unknown:test-epic" },
		).join("\n");

		expect(lines).not.toContain("2 tasks");
		expect(lines).toContain("Current done");
		expect(lines).toContain("READY");
		expect(lines).not.toContain("Other done");
		expect(lines).not.toContain("Blocked (1)");
	});

	test("task HUD shows only current-session epics plus ungrouped work", () => {
		const lines = renderHudLines(
			[
				{ ...task, id: "EHIGH", type: "epic", title: "High Epic", epic_id: "high", priority: 100 },
				{ ...task, id: "ECURRENT", type: "epic", title: "Current Epic", epic_id: "current", priority: 2 },
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
				{ ...task, id: "NOEPIC", title: "Ungrouped task", priority: 0, epic_id: undefined, epic_title: undefined },
			],
			theme as any,
			180,
			6,
			{ currentAssignment: "session:current", currentLabel: "Current" },
		).join("\n");

		expect(lines).toContain("Current Epic");
		expect(lines).not.toContain("High Epic");
		expect(lines).not.toContain("Ungrouped task");
		expect(lines).toContain("0/1 [");
		expect(lines).not.toContain("No Epic:");
	});

	test("task HUD shows flat epic list when current session has no active epic", () => {
		const lines = renderHudLines(
			[
				{ ...task, id: "EHIGH", type: "epic", title: "High Epic", epic_id: "high", priority: 100 },
				{ ...task, id: "ELOW", type: "epic", title: "Low Epic", epic_id: "low", priority: 2 },
				{ ...task, id: "HIGHWORK", title: "High epic task", epic_id: "high", priority: 100 },
				{ ...task, id: "LOWWORK", title: "Low epic task", epic_id: "low", priority: 2 },
				{ ...task, id: "NOEPIC", title: "Ungrouped task", priority: 0, epic_id: undefined, epic_title: undefined },
			],
			theme as any,
			180,
			6,
			{ currentAssignment: "session:current", currentLabel: "Current" },
		).join("\n");

		expect(lines.indexOf("High Epic")).toBeLessThan(lines.indexOf("Low Epic"));
		expect(lines).not.toContain("No Epic:");
		expect(lines).not.toContain("NOEPIC");
		expect(lines).not.toContain("HIGHWORK");
		expect(lines).not.toContain("LOWWORK");
	});

	test("task HUD summarizes completed-only epics", () => {
		const lines = renderHudLines(
			[
				{ ...task, id: "EDONE", type: "epic", title: "Completed Epic", epic_id: "done-epic", priority: 100 },
				{ ...task, id: "DONEA", title: "Done A", epic_id: "done-epic", status: "done" },
				{ ...task, id: "DONEB", title: "Done B", epic_id: "done-epic", status: "done" },
			],
			theme as any,
			160,
		).join("\n");

		expect(lines).toContain("✓ Completed Epic");
		expect(lines).toContain("2 done");
		expect(lines).not.toContain("DONEA");
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
			{ flashTaskIds: new Set(["FLASH"]), expandedEpicKey: "unknown:test-epic" },
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
				expandedEpicKey: "unknown:test-epic",
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
				expandedEpicKey: "unknown:test-epic",
			},
		).join("\n");

		expect(start).toContain("\x1b[48;2;18;14;36m");
		expect(peak).toContain("\x1b[48;2;63;50;126m");
		expect(start).not.toContain("\x1b[2m");
		expect(peak).toContain("Pulsing task");
	});

	test("task HUD limits done tasks to the past hour", () => {
		const lines = renderHudLines(
			[
				{ ...task, id: "READY", title: "Ready task" },
				{
					...task,
					id: "RECENT",
					title: "Recent done",
					status: "done",
					assigned_to: "session:current",
					updated_at: 3_000,
				},
				{
					...task,
					id: "OLD",
					title: "Old done",
					status: "done",
					assigned_to: "session:current",
					updated_at: 1_000,
				},
			],
			theme as any,
			160,
			6,
			{ currentAssignment: "session:current" },
			{ now: 3_000 + 60 * 60 * 1000, expandedEpicKey: "unknown:test-epic" },
		).join("\n");

		expect(lines).toContain("Recent done");
		expect(lines).not.toContain("Old done");
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
					if (args[1] === "tui") {
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

		const write = tools.find((tool) => tool.name === "task_write");
		await write.execute(
			"call-2",
			{ op: "update", id: "PG4", data: { title: "Updated smoke test task tools" } },
			undefined,
			undefined,
			ctx,
		);
		expect(calls.map((call) => call.slice(1, 3))).toContainEqual(["task", "update"]);
		expect(calls.map((call) => call.slice(1, 3))).toContainEqual(["task", "tui"]);
		expect(calls).toContainEqual(["ct", "task", "tui", "--json"]);
		expect(widgetRegistrations).toBe(1);
		expect(widgetText).toContain("Updated smoke");
	});

	test("task HUD shows when task guard is on", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		let widgetText = "";
		let widget: { render(width: number): string[] } | undefined;
		const ctx = {
			cwd: "/tmp/project",
			sessionId: "test-session",
			ui: {
				setWidget(_id: string, factory: any) {
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
				notify() {},
			},
		};

		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
				on(name: string, handler: any) {
					handlers[name] = handler;
				},
			} as any,
			{
				runCommand: async () => ({ stdout: JSON.stringify({ tasks: [task] }), stderr: "", exitCode: 0 }),
			},
		);

		await handlers.session_start({}, ctx);
		expect(widgetText).not.toContain("Task guard on");

		await commands["task-guard"].handler("on", ctx);
		expect(widgetText).toContain("Task guard on");
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
					if (args[1] === "tui") return { stdout: JSON.stringify({ tasks: [task] }), stderr: "", exitCode: 0 };
					return { stdout: JSON.stringify({ task }), stderr: "", exitCode: 0 };
				},
			},
		);

		const write = tools.find((tool) => tool.name === "task_write");
		await write.execute(
			"call-2",
			{ op: "update", id: "PG4", data: { status: "in_progress" } },
			undefined,
			undefined,
			{
				cwd: "/tmp/project",
				ui: {
					setWidget(_id: string, factory: any) {
						widgetText = factory({}, markedTheme).render(1000).join("\n");
					},
					notify() {},
				},
			},
		);

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

	test("task guard keeps answers visible and sends a soft visible nudge", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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

		await commands["task-guard"].handler("on", ctx);
		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
			ctx,
		);
		await handlers.turn_end({}, ctx);

		expect(replacement).toBeUndefined();
		expect(sent).toHaveLength(1);
		expect(sent[0].message.customType).toBe("task-guard");
		expect(sent[0].message.display).toBe(true);
		expect(sent[0].message.content[0].text).toContain("Task nudge");
		expect(sent[0].message.content[0].text).toContain("Start assigned task t");
		expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	test("task guard continues when user says the task is not done", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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
							{
								...task,
								id: "t",
								title: "Continue me",
								assigned_to: "session:test-session",
								status: "in_progress",
							},
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

		await commands["task-guard"].handler("on", ctx);
		await handlers.message_end(
			{
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: "you are not done, i'm not sure why you didn't get a task completion reminder",
						},
					],
				},
			},
			ctx,
		);
		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Continuing task t." }] } },
			ctx,
		);
		await handlers.turn_end({}, ctx);

		expect(replacement).toBeUndefined();
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content[0].text).toContain("Continue in-progress task t");
		expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	test("task guard describes assigned rejected tasks as revision work", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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
							{
								...task,
								id: "z",
								title: "Test reject notification flow",
								type: "bug",
								assigned_to: "session:test-session",
								status: "rejected",
								body: "Task body.\n\n## Rejection notes\n\n- 1000: first note\n- 2000: move both tasks to in review again",
							},
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

		await commands["task-guard"].handler("on", ctx);
		await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		await handlers.turn_end({}, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0].message.content[0].text).toContain("Revise rejected task z");
		expect(sent[0].message.content[0].text).toContain("Rejection note: move both tasks to in review again");
		expect(sent[0].message.content[0].text).not.toContain("Start assigned task z");
	});

	test("task guard restores an explicit on preference after extension reload", async () => {
		const previousStateHome = process.env.XDG_STATE_HOME;
		const stateHome = mkdtempSync(join(tmpdir(), "pi-task-guard-state-"));
		process.env.XDG_STATE_HOME = stateHome;
		try {
			const sessionFile = join(stateHome, "sessions", "test-session.jsonl");
			const ctx = {
				cwd: "/tmp/project",
				signal: undefined,
				sessionManager: { getSessionFile: () => sessionFile },
				ui: { notify() {} },
			};
			const runCommand = async () => ({
				stdout: JSON.stringify({
					tasks: [
						{
							...task,
							id: "t",
							title: "Continue me",
							assigned_to: "session:test-session",
							status: "in_progress",
						},
					],
				}),
				stderr: "",
				exitCode: 0,
			});
			const firstCommands: Record<string, any> = {};
			tasksExtension(
				{
					registerTool() {},
					registerCommand(name: string, definition: any) {
						firstCommands[name] = definition;
					},
					on() {},
				} as any,
				{ runCommand },
			);

			await firstCommands["task-guard"].handler("on", ctx);

			const handlers: Record<string, any> = {};
			const sent: any[] = [];
			tasksExtension(
				{
					registerTool() {},
					registerCommand() {},
					on(name: string, handler: any) {
						handlers[name] = handler;
					},
					sendMessage(message: any, options: any) {
						sent.push({ message, options });
					},
				} as any,
				{ runCommand },
			);

			await handlers.session_start({}, ctx);
			await handlers.message_end(
				{ message: { role: "assistant", content: [{ type: "text", text: "Continuing." }] } },
				ctx,
			);
			await handlers.turn_end({}, ctx);

			expect(sent).toHaveLength(1);
			expect(sent[0].message.content[0].text).toContain("Continue in-progress task t");
		} finally {
			if (previousStateHome === undefined) {
				delete process.env.XDG_STATE_HOME;
			} else {
				process.env.XDG_STATE_HOME = previousStateHome;
			}
			rmSync(stateHome, { recursive: true, force: true });
		}
	});

	test("task guard command disables and re-enables nudges for the session", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		const notifications: string[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		};

		await commands["task-guard"].handler("off", ctx);
		await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		await handlers.turn_end({}, ctx);
		await commands["task-guard"].handler("on", ctx);
		await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Done again." }] } },
			ctx,
		);
		await handlers.turn_end({}, ctx);

		expect(notifications).toEqual(["Task guard disabled for this session.", "Task guard enabled for this session."]);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content[0].text).toContain("Task nudge");
	});

	test("task guard defaults off and bare command reports status without toggling", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		const notifications: string[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		};

		await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		await handlers.turn_end({}, ctx);
		await commands["task-guard"].handler("", ctx);
		await commands["task-guard"].handler("toggle", ctx);
		await commands["task-guard"].handler("status", ctx);
		await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Done again." }] } },
			ctx,
		);
		await handlers.turn_end({}, ctx);

		expect(sent).toEqual([]);
		expect(notifications).toEqual([
			"Task guard is disabled for this session. Use /task-guard [on/off] to change it.",
			"Usage: /task-guard [on|off|status]",
			"Task guard is disabled for this session. Use /task-guard [on/off] to change it.",
		]);
	});

	test("task guard stays quiet for user-directed status answers", async () => {
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
		expect(sent).toHaveLength(0);
	});

	test("task guard keeps answers visible when evaluation fails", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const notifications: string[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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
		const ctx = {
			cwd: "/tmp/project",
			sessionId: "test-session",
			signal: undefined,
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		};

		await commands["task-guard"].handler("on", ctx);
		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
			ctx,
		);

		expect(replacement).toBeUndefined();
		expect(notifications.at(-1)).toContain("Task guard failed");
	});

	test("task guard repeats a soft nudge without escalating", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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

		await commands["task-guard"].handler("on", ctx);
		await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		await handlers.turn_end({}, ctx);
		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "Done again." }] } },
			ctx,
		);
		await handlers.turn_end({}, ctx);

		expect(replacement).toBeUndefined();
		expect(sent).toHaveLength(2);
		expect(sent[1].message.display).toBe(true);
		expect(sent[1].message.content[0].text).toContain("Task nudge");
		expect(sent[1].message.content[0].text).toContain("Start assigned task t");
		expect(sent.map((item) => item.options)).toEqual([
			{ deliverAs: "followUp", triggerTurn: true },
			{ deliverAs: "followUp", triggerTurn: true },
		]);
	});

	test("task guard stays quiet when a user question follows a nudge", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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
			ui: { notify() {} },
		};

		await commands["task-guard"].handler("on", ctx);
		await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		await handlers.turn_end({}, ctx);
		await handlers.message_end(
			{ message: { role: "user", content: [{ type: "text", text: "what happened?" }] } },
			ctx,
		);
		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "The task guard stalled." }] } },
			ctx,
		);
		await handlers.turn_end({}, ctx);

		expect(sent).toHaveLength(1);
		expect(replacement).toBeUndefined();
	});

	test("task guard auto-triggers continuation turns after progress", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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
							{
								...task,
								id: "t",
								title: "Long-running task",
								status: "in_progress",
								assigned_to: "session:test-session",
							},
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

		await commands["task-guard"].handler("on", ctx);
		for (let i = 0; i < 4; i++) {
			handlers.tool_execution_end({ result: { details: { filesChanged: 1 } } });
			await handlers.message_end(
				{ message: { role: "assistant", content: [{ type: "text", text: `Progress ${i}` }] } },
				ctx,
			);
			await handlers.turn_end({}, ctx);
		}

		expect(sent).toHaveLength(4);
		expect(sent.map((item) => item.options)).toEqual([
			{ deliverAs: "followUp", triggerTurn: true },
			{ deliverAs: "followUp", triggerTurn: true },
			{ deliverAs: "followUp", triggerTurn: true },
			{ deliverAs: "followUp", triggerTurn: true },
		]);
		expect(sent.every((item) => item.message.display === true)).toBe(true);
		expect(sent[3].message.content[0].text).toContain("Task nudge");
	});

	test("task guard stops auto-triggering repeated nudges without progress", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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
							{
								...task,
								id: "t",
								title: "Long-running task",
								status: "in_progress",
								assigned_to: "session:test-session",
							},
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

		await commands["task-guard"].handler("on", ctx);
		for (let i = 0; i < 3; i++) {
			await handlers.message_end(
				{ message: { role: "assistant", content: [{ type: "text", text: `No progress ${i}` }] } },
				ctx,
			);
			await handlers.turn_end({}, ctx);
		}

		expect(sent).toHaveLength(3);
		expect(sent.map((item) => item.options)).toEqual([
			{ deliverAs: "followUp", triggerTurn: true },
			{ deliverAs: "followUp", triggerTurn: true },
			{ deliverAs: "followUp" },
		]);
	});

	test("task guard stays quiet for arbitrary user-directed answers", async () => {
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
			ui: { notify() {} },
		};

		await handlers.message_end(
			{ message: { role: "user", content: [{ type: "text", text: "task guard is breaking everything" }] } },
			ctx,
		);
		const replacement = await handlers.message_end(
			{ message: { role: "assistant", content: [{ type: "text", text: "I'll fix the guard." }] } },
			ctx,
		);
		await handlers.turn_end({}, ctx);

		expect(replacement).toBeUndefined();
		expect(sent).toHaveLength(0);
	});

	test("task guard nudges about unassigned blockers without assigning", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		const calls: string[][] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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

		await commands["task-guard"].handler("on", ctx);
		await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		await handlers.turn_end({}, ctx);

		expect(calls).toEqual([["ct", "task", "tui", "--json"]]);
		expect(sent[0].message.content[0].text).toContain("Claim task b to unblock a");
		expect(sent[0].message.display).toBe(true);
	});

	test("task guard does not suggest claiming epic container tasks", async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const sent: any[] = [];
		tasksExtension(
			{
				registerTool() {},
				registerCommand(name: string, definition: any) {
					commands[name] = definition;
				},
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
							{
								...task,
								id: "t",
								type: "bug",
								title: "Concrete task in review",
								status: "in_review",
								assigned_to: "session:test-session",
								epic_id: "codex-provider",
							},
							{
								...task,
								id: "4",
								type: "epic",
								title: "Codex provider fork",
								status: "open",
								assigned_to: undefined,
								epic_id: "codex-provider",
							},
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

		await commands["task-guard"].handler("on", ctx);
		await handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, ctx);
		await handlers.turn_end({}, ctx);

		expect(sent).toEqual([]);
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

		const write = tools.find((tool) => tool.name === "task_write");
		expect(write.renderCall({ op: "add", title: "Make HUD nice" }, theme).render(120)).toEqual([]);
		expect(write.renderResult({ details: { action: "add", task } }, {}, theme, {}).render(120)).toEqual([]);
		const row = new ToolExecutionComponent(
			"task_write",
			"call-1",
			{ op: "add", title: "Make HUD nice" },
			{},
			write,
			{ requestRender() {} } as any,
			"/tmp/project",
		);
		expect(row.render(120)).toEqual([]);
		row.updateResult({ content: [], details: { action: "add", task }, isError: false });
		expect(row.render(120)).toEqual([]);
	});
});
