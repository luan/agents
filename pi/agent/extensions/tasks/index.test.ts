import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

import tasksExtension, { buildTaskBoardItems, renderHudLines, renderTaskBoardLines, TaskBoardOverlay } from "./index";

const now = 10 * 60 * 1000;

const task = {
	id: "1",
	title: "Implement task timers",
	body: "Verify the task HUD and renderers.",
	status: "open",
	type: "feature",
	created_at: 1,
	updated_at: 2,
	blocked_by: [],
	labels: [],
	priority: 0,
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

describe("tasks extension", () => {
	test("builds a flat task list instead of board columns", () => {
		const tasks = [
			{ ...task, id: "done9q", status: "done", title: "Finished" },
			{ ...task, id: "act2k7", status: "in_progress", title: "Active", started_at: now - 12_000 },
			{ ...task, id: "blk3m8", status: "open", title: "Blocked", blocked_by: ["act2k7"] },
			{ ...task, id: "cncl4x", status: "canceled", title: "Hidden" },
		];

		const items = buildTaskBoardItems(tasks);

		expect(items.map((item) => item.task.id)).toEqual(["act2k7", "blk3m8", "done9q"]);
		expect(items.map((item) => item.blocked)).toEqual([false, true, false]);
	});

	test("renders pi-tasks style HUD rows with active gerund timers and blockers", () => {
		const tasks = [
			{ ...task, id: "done9q", status: "done", title: "Design task UI" },
			{
				...task,
				id: "act2k7",
				status: "in_progress",
				title: "Run task tests",
				active_form: "Running task tests",
				started_at: now - 169_000,
			},
			{ ...task, id: "blk3m8", status: "open", title: "Wire task storage", blocked_by: ["act2k7"] },
		];

		const lines = renderHudLines(tasks, theme as any, 90, 10, {}, { frame: 2, now });

		expect(lines[0]).toBe("● 3 tasks (1 done, 1 in progress, 1 open)");
		expect(lines.join("\n")).toContain("✵ a Running task tests… (2m 49s)");
		expect(lines.join("\n")).toContain("◻ b Wire task storage › blocked by a");
		expect(lines.join("\n")).toContain("✔ ~~d Design task UI~~");
		expect(lines.every((line) => visibleWidth(line) <= 90)).toBe(true);
	});

	test("expands displayed prefixes only as far as needed for uniqueness", () => {
		const tasks = [
			{ ...task, id: "abc123", status: "in_progress", title: "First collision" },
			{ ...task, id: "abd456", status: "open", title: "Second collision", blocked_by: ["abc123"] },
		];

		const lines = renderHudLines(tasks, theme as any, 90, 10, {}, { frame: 0, now });
		const text = lines.join("\n");

		expect(text).toContain("abc Working on collision…");
		expect(text).toContain("abd Second collision › blocked by abc");
		expect(text).not.toContain("abc123");
	});

	test("renders a flat task overlay with details and no lane headings", () => {
		const tasks = [
			{ ...task, id: "block1", title: "Blocking task", body: "Important context", priority: 7 },
			{ ...task, id: "child2", title: "Blocked task", blocked_by: ["block1"] },
		];

		const lines = renderTaskBoardLines(tasks, theme as any, 70, { row: 0 });
		const text = lines.join("\n");

		expect(lines.every((line) => visibleWidth(line) <= 70)).toBe(true);
		expect(text).toContain("╭ Tasks");
		expect(text).toContain("b Blocking task");
		expect(text).toContain("Details");
		expect(text).toContain("Important context");
		expect(text).not.toContain("Ready (");
		expect(text).not.toContain("In Progress (");
	});

	test("renders structured task body sections in details", () => {
		const tasks = [
			{
				...task,
				id: "1",
				title: "Structured task",
				body: [
					"Context / problem:",
					"",
					"The body should stay readable.",
					"",
					"Agent-verifiable acceptance criteria:",
					"- Shows body sections",
					"- Preserves bullet content",
				].join("\n"),
			},
		];

		const rendered = renderTaskBoardLines(tasks, markedTheme as any, 100).join("\n");

		expect(rendered).toContain("<dim>Body:</dim>");
		expect(rendered).toContain("<mdHeading>Context / problem:</mdHeading>");
		expect(rendered).toContain("<mdHeading>Agent-verifiable acceptance criteria:</mdHeading>");
		expect(rendered).toContain("<dim>•</dim> Shows body sections");
	});

	test("task overlay handles vertical navigation, reload, and close keys", async () => {
		let closed = false;
		let reloads = 0;
		const board = new TaskBoardOverlay({
			tasks: [
				{ ...task, id: "1", title: "First" },
				{ ...task, id: "2", title: "Second" },
			],
			theme: theme as any,
			onClose: () => {
				closed = true;
			},
			onReload: async () => {
				reloads++;
				return [{ ...task, id: "3", title: "Reloaded" }];
			},
		});

		board.handleInput("j");
		expect(board.selection()).toEqual({ row: 1 });
		board.handleInput("k");
		expect(board.selection()).toEqual({ row: 0 });
		board.handleInput("r");
		await board.waitForIdle();
		expect(reloads).toBe(1);
		expect(board.render(80).join("\n")).toContain("Reloaded");
		board.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	test("task tools are extension-backed and acceptance is agent-driven", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-"));
		const commands = new Map<string, any>();
		const tools = new Map<string, any>();
		const handlers = new Map<string, any>();
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool(toolDef: any) {
				tools.set(toolDef.name, toolDef);
			},
			sendMessage() {},
		};
		const ctx = {
			cwd,
			signal: new AbortController().signal,
			ui: {
				notify() {},
				setWidget() {},
				async editor(_title: string, value: string) {
					return value;
				},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);

		expect(commands.has("accept")).toBe(false);
		expect(commands.has("reject")).toBe(false);
		await expect(
			tools.get("task_write").execute("1", { op: "accept", id: "1" }, undefined, undefined, ctx),
		).rejects.toThrow("add, update, or delete");
		await expect(
			tools
				.get("task_write")
				.execute("epic", { op: "add", title: "Umbrella", data: { type: "epic" } }, undefined, undefined, ctx),
		).rejects.toThrow("Epic tasks are no longer supported");

		const created = await tools
			.get("task_write")
			.execute(
				"1",
				{ op: "add", title: "Implement task storage", data: { type: "feature" } },
				undefined,
				undefined,
				ctx,
			);
		const id = created.details.task.id;
		expect(id).toMatch(/^[0-9a-z]{6}$/);
		expect(id).not.toMatch(/^\d+$/);
		await tools
			.get("task_write")
			.execute("2", { op: "update", id, data: { status: "in_progress" } }, undefined, undefined, ctx);
		await expect(
			tools
				.get("task_write")
				.execute("3", { op: "update", id, data: { status: "done" } }, undefined, undefined, ctx),
		).rejects.toThrow("user_approved_completion=true");
		await tools
			.get("task_write")
			.execute(
				"4",
				{ op: "update", id, data: { status: "done" }, user_approved_completion: true },
				undefined,
				undefined,
				ctx,
			);

		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		expect(existsSync(storePath)).toBe(true);
		expect(JSON.parse(readFileSync(storePath, "utf8")).tasks[0].status).toBe("done");

		rmSync(cwd, { recursive: true, force: true });
	});

	test("sends assigned task reminders with a rendered task card", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-reminder-send-"));
		const commands = new Map<string, any>();
		const tools = new Map<string, any>();
		const handlers = new Map<string, any>();
		const renderers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool(toolDef: any) {
				tools.set(toolDef.name, toolDef);
			},
			registerMessageRenderer(name: string, renderer: any) {
				renderers.set(name, renderer);
			},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "reminder-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		expect(commands.has("task-guard")).toBe(false);

		await tools.get("task_write").execute(
			"add",
			{
				op: "add",
				title: "Run reminder regression",
				data: { type: "feature", status: "in_progress", assigned_to: "current" },
			},
			undefined,
			undefined,
			ctx,
		);
		await handlers.get("turn_end")?.({}, ctx);
		expect(messages).toHaveLength(0);

		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(1);
		expect(messages[0].message.customType).toBe("task-reminder");
		expect(messages[0].message.content[0].text).toContain("Task reminder: 1 assigned active task");
		expect(messages[0].message.content[0].text).toContain("Run reminder regression");
		expect(messages[0].message.details.attempts).toBe(1);
		expect(messages[0].message.details.maxAttempts).toBe(3);
		expect(messages[0].options).toBeUndefined();

		const rendered = renderers
			.get("task-reminder")(messages[0].message, undefined, theme as any)
			.render(90)
			.join("\n");
		expect(rendered).toContain("Task reminder");
		expect(rendered).toContain("Run reminder regression");
		expect(rendered).toContain("1/3");

		rmSync(cwd, { recursive: true, force: true });
	});

	test("does not send task reminders for unassigned work", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-reminder-unassigned-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Do not remind unassigned work",
						status: "in_progress",
						assigned_to: null,
					},
				],
			}),
		);
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			registerMessageRenderer() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "reminder-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(0);

		rmSync(cwd, { recursive: true, force: true });
	});

	test("waits for real user input before repeating a no-tool task reminder", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-reminder-max-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Limit reminder repeats",
						status: "in_progress",
						assigned_to: "session:reminder-session",
					},
				],
			}),
		);
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			registerMessageRenderer() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "reminder-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		for (let index = 0; index < 5; index++) await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(1);
		expect(messages[0].message.details.attempts).toBe(1);

		await handlers.get("message_end")?.({ message: { role: "user", content: "continue" } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(2);
		expect(messages.at(-1)?.message.details.attempts).toBe(1);

		rmSync(cwd, { recursive: true, force: true });
	});
	test("migrates persisted numeric demo ids to short hash ids", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-migrate-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{ ...task, id: "1", title: "Old numeric blocker", status: "in_progress" },
					{ ...task, id: "2", title: "Old numeric blocked", blocked_by: ["1"] },
				],
			}),
		);
		const tools = new Map<string, any>();
		const handlers = new Map<string, any>();
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand() {},
			registerShortcut() {},
			registerTool(toolDef: any) {
				tools.set(toolDef.name, toolDef);
			},
			sendMessage() {},
		};
		const ctx = { cwd, ui: { notify() {}, setWidget() {} } };

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		const result = await tools.get("task_read").execute("read", { all: true }, undefined, undefined, ctx);
		const ids = result.details.tasks.map((item: typeof task) => item.id);

		expect(ids).toHaveLength(2);
		expect(ids.every((id: string) => /^[0-9a-z]{6}$/.test(id))).toBe(true);
		expect(ids.some((id: string) => /^\d+$/.test(id))).toBe(false);
		expect(result.details.tasks[1].blocked_by).toEqual([result.details.tasks[0].id]);
		expect(JSON.parse(readFileSync(storePath, "utf8")).tasks.map((item: typeof task) => item.id)).toEqual(ids);

		rmSync(cwd, { recursive: true, force: true });
	});
});
