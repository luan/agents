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

	test("persists task guard preference across extension reloads", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-"));
		const notices: string[] = [];
		const makePi = () => {
			const commands = new Map<string, any>();
			const handlers = new Map<string, any>();
			return {
				commands,
				handlers,
				pi: {
					on(name: string, handler: any) {
						handlers.set(name, handler);
					},
					registerCommand(name: string, command: any) {
						commands.set(name, command);
					},
					registerShortcut() {},
					registerTool() {},
					sendMessage() {},
				},
			};
		};
		const ctx = {
			cwd,
			ui: {
				notify(message: string) {
					notices.push(message);
				},
				setWidget() {},
			},
		};

		const first = makePi();
		tasksExtension(first.pi as any);
		await first.handlers.get("session_start")?.({}, ctx);
		await first.commands.get("task-guard").handler("on", ctx);

		const prefPath = join(cwd, ".pi", "tasks", "task-guard.json");
		expect(JSON.parse(readFileSync(prefPath, "utf8"))).toEqual({ enabled: true });

		const second = makePi();
		tasksExtension(second.pi as any);
		await second.handlers.get("session_start")?.({}, ctx);
		await second.commands.get("task-guard").handler("status", ctx);

		expect(notices.at(-1)).toContain("Task guard is enabled");

		rmSync(cwd, { recursive: true, force: true });
	});

	test("sends persisted task guard nudges after extension reload", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-send-"));
		const makePi = () => {
			const commands = new Map<string, any>();
			const tools = new Map<string, any>();
			const handlers = new Map<string, any>();
			const messages: Array<{ message: any; options: any }> = [];
			return {
				commands,
				tools,
				handlers,
				messages,
				pi: {
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
					sendMessage(message: any, options: any) {
						messages.push({ message, options });
					},
				},
			};
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		const first = makePi();
		tasksExtension(first.pi as any);
		await first.handlers.get("session_start")?.({}, ctx);
		await first.tools.get("task_write").execute(
			"add",
			{
				op: "add",
				title: "Run guard regression",
				data: { type: "feature", status: "in_progress", assigned_to: "current" },
			},
			undefined,
			undefined,
			ctx,
		);
		await first.commands.get("task-guard").handler("on", ctx);

		const second = makePi();
		tasksExtension(second.pi as any);
		await second.handlers.get("session_start")?.({}, ctx);
		await second.handlers.get("message_end")?.({ message: { role: "user", content: "try it yourself" } }, ctx);
		await second.handlers.get("message_end")?.({ message: { role: "assistant", content: "Continuing." } }, ctx);
		await second.handlers.get("turn_end")?.({}, ctx);

		expect(second.messages).toHaveLength(1);
		expect(second.messages[0].message.customType).toBe("task-guard");
		expect(second.messages[0].message.content[0].text).toContain("Continue in-progress task");
		expect(second.messages[0].message.content[0].text).not.toContain("/task-guard off");
		expect(second.messages[0].options).toBeUndefined();

		rmSync(cwd, { recursive: true, force: true });
	});

	test("sends task guard nudges when session identity only comes from session manager id", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-session-id-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Continue from session manager id",
						status: "in_progress",
						assigned_to: "session:live-session-id",
					},
				],
			}),
		);
		const commands = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionManager: {
				getSessionId() {
					return "live-session-id";
				},
				getSessionFile() {
					return undefined;
				},
			},
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.({ message: { role: "user", content: "continue" } }, ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Continuing." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(1);
		expect(messages[0].message.content[0].text).toContain("Continue from session manager id");

		rmSync(cwd, { recursive: true, force: true });
	});

	test("continues bootty-style in-progress tasks after a do-it directive", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-do-it-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		const sessionFile = join(
			cwd,
			".pi",
			"agent",
			"sessions",
			"2026-06-19T16-19-32-675Z_019ee0ae-30c3-7158-a7ee-e7b37c3f6b6a.jsonl",
		);
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "5z2zdd",
						title: "Evaluate egui-shadcn as Bootty component layer",
						status: "in_progress",
						assigned_to: "session:2026-06-19T16-19-32-675Z_019ee0ae-30c3-7158-a7ee-e7b37c3f6b6a",
					},
				],
			}),
		);
		const commands = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionManager: {
				getSessionFile() {
					return sessionFile;
				},
			},
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.({ message: { role: "user", content: "let's do it" } }, ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Done." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(1);
		expect(messages[0].message.content[0].text).toContain("Continue in-progress task");
		expect(messages[0].options).toBeUndefined();

		rmSync(cwd, { recursive: true, force: true });
	});

	test("does not send task guard nudges for unassigned in-progress tasks", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-unassigned-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Continue unassigned active work",
						status: "in_progress",
						assigned_to: null,
					},
				],
			}),
		);
		const commands = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.({ message: { role: "user", content: "continue" } }, ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Continuing." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(0);

		rmSync(cwd, { recursive: true, force: true });
	});

	test("stops nudging after two no-tool turns until the next user message", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-no-tools-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Continue assigned active work",
						status: "in_progress",
						assigned_to: "session:guard-session",
					},
				],
			}),
		);
		const commands = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.({ message: { role: "user", content: "continue" } }, ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "No tools." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Still no tools." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Still no tools." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(2);
		expect(messages.every((message) => message.options === undefined)).toBe(true);

		await handlers.get("message_end")?.({ message: { role: "user", content: "continue again" } }, ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "No tools after reset." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(3);

		rmSync(cwd, { recursive: true, force: true });
	});

	test("does not reset no-tool nudge suppression for task-guard follow-up messages", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-self-loop-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Avoid self-loop nudges",
						status: "in_progress",
						assigned_to: "session:guard-session",
					},
				],
			}),
		);
		const commands = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.({ message: { role: "user", content: "continue" } }, ctx);
		for (let index = 0; index < 5; index++) {
			await handlers.get("message_end")?.({ message: { role: "assistant", content: `No tools ${index}.` } }, ctx);
			await handlers.get("turn_end")?.({}, ctx);
			const latest = messages.at(-1)?.message;
			if (latest) await handlers.get("message_end")?.({ message: { role: "user", ...latest } }, ctx);
		}

		expect(messages).toHaveLength(2);

		rmSync(cwd, { recursive: true, force: true });
	});

	test("aborts and hides a queued task-guard message after the referenced task completes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-stale-queued-"));
		const commands = new Map<string, any>();
		const tools = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		let aborted = false;
		let queueCleared = false;
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
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			abort() {
				aborted = true;
			},
			clearQueue() {
				queueCleared = true;
			},
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await tools.get("task_write").execute(
			"add",
			{
				op: "add",
				title: "Complete after first guard",
				data: { type: "feature", status: "in_progress", assigned_to: "current" },
			},
			undefined,
			undefined,
			ctx,
		);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.(
			{ message: { role: "assistant", content: "Stopping before task completion." } },
			ctx,
		);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(1);
		const queuedGuard = { role: "custom", ...messages[0].message };
		const id = messages[0].message.details.taskId;

		await tools
			.get("task_write")
			.execute(
				"done",
				{ op: "update", id, data: { status: "done" }, auto_verified_completion: true },
				undefined,
				undefined,
				ctx,
			);
		expect(queueCleared).toBe(true);

		await handlers.get("message_start")?.({ message: queuedGuard }, ctx);
		expect(aborted).toBe(true);

		const replacement = await handlers.get("message_end")?.({ message: queuedGuard }, ctx);
		expect(replacement?.message.role).toBe("custom");
		expect(replacement?.message.display).toBe(false);
		expect(replacement?.message.content[0].text).toContain("skipped");
		expect(replacement?.message.details).toEqual({ taskId: id, stale: true });

		await handlers.get("turn_end")?.({}, ctx);
		expect(messages).toHaveLength(1);

		rmSync(cwd, { recursive: true, force: true });
	});

	test("re-evaluates deferred task guard after task completion before sending", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-deferred-complete-"));
		const commands = new Map<string, any>();
		const tools = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		let idle = false;
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
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			isIdle() {
				return idle;
			},
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await tools.get("task_write").execute(
			"add",
			{
				op: "add",
				title: "Complete before deferred guard sends",
				data: { type: "feature", status: "in_progress", assigned_to: "current" },
			},
			undefined,
			undefined,
			ctx,
		);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Done soon." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(0);
		const taskList = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", "tasks.json"), "utf8")).tasks;
		const id = taskList[0].id;

		await tools
			.get("task_write")
			.execute(
				"done",
				{ op: "update", id, data: { status: "done" }, auto_verified_completion: true },
				undefined,
				undefined,
				ctx,
			);
		idle = true;
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(messages).toHaveLength(0);
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("allows current task-guard extension input through", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-current-input-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Current task",
						status: "in_progress",
						assigned_to: "session:guard-session",
					},
				],
			}),
		);
		const commands = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("turn_end")?.({}, ctx);
		const text = messages[0].message.content[0].text;
		const result = await handlers.get("input")?.({ type: "input", source: "extension", text }, ctx);

		expect(result).toEqual({ action: "continue" });

		rmSync(cwd, { recursive: true, force: true });
	});

	test("does not nudge when queued or steered messages are pending", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-pending-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "act2k7",
						title: "Continue assigned work after queued message",
						status: "in_progress",
						assigned_to: "session:guard-session",
					},
				],
			}),
		);
		const commands = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		let pendingMessages = true;
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			hasPendingMessages() {
				return pendingMessages;
			},
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Waiting." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(0);

		pendingMessages = false;
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Still waiting." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(1);

		rmSync(cwd, { recursive: true, force: true });
	});

	test("nudges in-review tasks once with review-specific guidance", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-review-"));
		const storePath = join(cwd, ".pi", "tasks", "tasks.json");
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		writeFileSync(
			storePath,
			JSON.stringify({
				tasks: [
					{
						...task,
						id: "rev2k7",
						title: "Clarify review scope",
						status: "in_review",
						assigned_to: "session:guard-session",
					},
				],
			}),
		);
		const commands = new Map<string, any>();
		const handlers = new Map<string, any>();
		const messages: Array<{ message: any; options: any }> = [];
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			registerTool() {},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Waiting." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Still waiting." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(1);
		expect(messages[0].message.content[0].text).toContain("Review clarification needed");
		expect(messages[0].message.content[0].text).toContain("what needs to be reviewed and how");
		expect(messages[0].options).toBeUndefined();

		rmSync(cwd, { recursive: true, force: true });
	});

	test("stops nudging after the assigned task is completed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-guard-completed-"));
		const commands = new Map<string, any>();
		const tools = new Map<string, any>();
		const handlers = new Map<string, any>();
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
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		};
		const ctx = {
			cwd,
			sessionId: "guard-session",
			ui: {
				notify() {},
				setWidget() {},
			},
		};

		tasksExtension(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await tools.get("task_write").execute(
			"add",
			{
				op: "add",
				title: "Complete assigned task",
				data: { type: "feature", status: "in_progress", assigned_to: "current" },
			},
			undefined,
			undefined,
			ctx,
		);
		await commands.get("task-guard").handler("on", ctx);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Stopping too soon." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(1);
		const id = messages[0].message.details.taskId;

		await tools
			.get("task_write")
			.execute(
				"done",
				{ op: "update", id, data: { status: "done" }, auto_verified_completion: true },
				undefined,
				undefined,
				ctx,
			);
		await handlers.get("message_end")?.({ message: { role: "assistant", content: "Completed." } }, ctx);
		await handlers.get("turn_end")?.({}, ctx);

		expect(messages).toHaveLength(1);

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
