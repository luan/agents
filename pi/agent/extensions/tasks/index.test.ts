import { describe, expect, test } from "bun:test";

import tasksExtension, { buildTaskCommand } from "./index";

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
		expect(buildTaskCommand("update", { id: "ABC", status: "done" })).toEqual([
			"task",
			"update",
			"ABC",
			"--status",
			"done",
			"--json",
		]);
	});

	test("registers task tools that shell out to ct", async () => {
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
					return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
				},
			},
		);

		const add = tools.find((tool) => tool.name === "task_add");
		expect(add).toBeTruthy();
		const result = await add.execute("call-1", { title: "Persist task" }, undefined);
		expect(calls).toEqual([["ct", "task", "add", "Persist task", "--json"]]);
		expect(result.content[0].text).toBe('{"ok":true}');
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"task_add",
			"task_delete",
			"task_list",
			"task_show",
			"task_update",
		]);
	});
});
