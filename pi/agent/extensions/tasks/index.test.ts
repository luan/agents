import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import tasksExtension, { buildTaskBoardItems, TaskBoardOverlay } from "./index";

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
		board.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	test("keeps HUD mode and remounts after extension UI resets", async () => {
		type Handler = (event: unknown, context: unknown) => unknown;
		type Shortcut = { handler: (context: unknown) => unknown };
		type WidgetComponent = { dispose?: () => void; isExpanded(): boolean };
		type WidgetFactory = (tui: { requestRender?: () => void }, widgetTheme: typeof theme) => WidgetComponent;
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-hud-mode-"));
		const sessionId = "hud-mode-session";
		let widget: WidgetComponent | undefined;
		const ctx = {
			cwd,
			sessionManager: { getSessionId: () => sessionId },
			signal: new AbortController().signal,
			ui: {
				notify() {},
				setWidget(_key: string, content: WidgetFactory | undefined) {
					if (content === undefined) {
						widget?.dispose?.();
						widget = undefined;
						return;
					}
					widget = content({ requestRender() {} }, theme);
				},
			},
		};
		const makePi = () => {
			const handlers = new Map<string, Handler[]>();
			let shortcut: Shortcut | undefined;
			const pi = {
				on(name: string, handler: Handler) {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				},
				registerShortcut(_name: string, definition: Shortcut) {
					shortcut = definition;
				},
				registerCommand() {},
				registerTool() {},
				sendMessage() {},
			};
			return {
				pi,
				handlers,
				get shortcut(): Shortcut {
					if (!shortcut) throw new Error("shortcut was not registered");
					return shortcut;
				},
			};
		};

		try {
			// Distinct specifiers force fresh extension module instances, matching /reload.
			const first = await import(`./index.ts?hud-mode-first-${Math.random()}`);
			const firstPi = makePi();
			first.default(firstPi.pi);
			await firstPi.handlers.get("session_start")?.[0]?.({}, ctx);
			expect(widget?.isExpanded()).toBe(true);
			ctx.ui.setWidget("project-tasks", undefined);
			expect(widget).toBeUndefined();
			await firstPi.handlers.get("session_start")?.[0]?.({}, ctx);
			expect(widget?.isExpanded()).toBe(true);
			await firstPi.shortcut.handler(ctx);
			expect(widget?.isExpanded()).toBe(false);

			const second = await import(`./index.ts?hud-mode-second-${Math.random()}`);
			const secondPi = makePi();
			second.default(secondPi.pi);
			await secondPi.handlers.get("session_start")?.[0]?.({}, ctx);
			expect(widget?.isExpanded()).toBe(false);
			const otherCtx = { ...ctx, sessionManager: { getSessionId: () => "other-session" } };
			await secondPi.handlers.get("session_start")?.[0]?.({}, otherCtx);
			expect(widget?.isExpanded()).toBe(true);
			await secondPi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "new" }, otherCtx);
			await secondPi.handlers.get("session_start")?.[0]?.({}, ctx);
			expect(widget?.isExpanded()).toBe(false);
			await secondPi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "new" }, ctx);
			await secondPi.handlers.get("session_start")?.[0]?.({}, ctx);
			expect(widget?.isExpanded()).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("task tools are extension-backed and session-scoped", async () => {
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
			sessionId: "tools-session",
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
		const otherSession = await tools
			.get("task_read")
			.execute("other", { all: true }, undefined, undefined, { ...ctx, sessionId: "other-session" });
		expect(otherSession.details.tasks).toEqual([]);

		await tools
			.get("task_write")
			.execute("2", { op: "update", id, data: { status: "in_progress" } }, undefined, undefined, ctx);
		await tools
			.get("task_write")
			.execute("3", { op: "update", id, data: { status: "done" } }, undefined, undefined, ctx);

		const storePath = join(cwd, ".pi", "tasks", "sessions", "tools-session.json");
		expect(existsSync(storePath)).toBe(true);
		expect(existsSync(join(cwd, ".pi", "tasks", "tasks.json"))).toBe(false);
		expect(JSON.parse(readFileSync(storePath, "utf8")).tasks[0].status).toBe("done");

		rmSync(cwd, { recursive: true, force: true });
	});

	test("sends active session task reminders with a rendered task card", async () => {
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
				data: { type: "feature", status: "in_progress" },
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
		expect(messages[0].message.content[0].text).toContain("Task reminder: 1 active task");
		expect(messages[0].message.content[0].text).toContain("Run reminder regression");
		expect(messages[0].message.details.attempts).toBe(1);
		expect(messages[0].message.details.maxAttempts).toBe(3);
		expect(messages[0].options).toBeUndefined();

		rmSync(cwd, { recursive: true, force: true });
	});

	test("does not send task reminders for another session's work", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-reminder-other-session-"));
		const storePath = join(cwd, ".pi", "tasks", "sessions", "other-session.json");
		mkdirSync(join(cwd, ".pi", "tasks", "sessions"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Do not remind another session's work",
						status: "in_progress",
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
		const storePath = join(cwd, ".pi", "tasks", "sessions", "reminder-session.json");
		mkdirSync(join(cwd, ".pi", "tasks", "sessions"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Limit reminder repeats",
						status: "in_progress",
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
		const storePath = join(cwd, ".pi", "tasks", "sessions", "migrate-session.json");
		mkdirSync(join(cwd, ".pi", "tasks", "sessions"), { recursive: true });
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
		const ctx = { cwd, sessionId: "migrate-session", ui: { notify() {}, setWidget() {} } };

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
