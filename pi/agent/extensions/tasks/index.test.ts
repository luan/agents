import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@mariozechner/pi-tui";

import tasksExtension, { buildTaskCommand, renderHudLines, renderTaskResult } from "./index";

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
			80,
			6,
			{ currentAssignment: "session:test-session", currentLabel: "Named Session" },
		);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		expect(lines.join("\n")).toContain("3 tasks");
		expect(lines.join("\n")).toContain("1 done");
		expect(lines.join("\n")).toContain("PG4W2K4Q03");
		expect(lines.join("\n")).toContain("› blocked by PG4W2K4Q03");
		expect(lines.join("\n")).toContain("Smoke test");
		expect(lines.join("\n")).toContain("@Named Session");
		expect(lines.join("\n")).toContain("Done task");
		expect(lines.findIndex((line) => line.includes("Smoke test"))).toBeLessThan(
			lines.findIndex((line) => line.includes("Blocked task")),
		);

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
			160,
			6,
			{ currentAssignment: "session:current", currentLabel: "Me" },
		).join("\n");

		expect(lines).toContain("<success> @Me</success>");
		expect(lines).toContain("<muted>Other work</muted>");
		expect(lines).toContain("<dim> @Other</dim>");
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
		expect(widgetText).toContain("Smoke test task tools");
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
					widgetText = factory({}, theme).render(120).join("\n");
				},
			},
		});

		expect(widgetText).toContain("@Other Work");
		expect(widgetText).not.toContain(sessionId);
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
