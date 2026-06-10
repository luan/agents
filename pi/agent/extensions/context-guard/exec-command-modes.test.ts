import "./setup-home";
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecCommandTracker } from "../exec-command/tools/exec-command-state.ts";
import { registerExecCommandTool } from "../exec-command/tools/exec-command-tool.ts";

const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
const originalSkipLocalBin = process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN;
const originalPath = process.env.PATH;

afterEach(() => {
	if (originalCoreBin === undefined) {
		delete process.env.CONTEXT_GUARD_BIN;
	} else {
		process.env.CONTEXT_GUARD_BIN = originalCoreBin;
	}
	if (originalSkipLocalBin === undefined) {
		delete process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN;
	} else {
		process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN = originalSkipLocalBin;
	}
	process.env.PATH = originalPath;
});

function createExecTool(options: { contextGuardEnabled?: boolean } = {}) {
	let tool: any;
	const sessions = {
		exec: async () => {
			throw new Error("sessions.exec should not be used for context-guard-wrapped commands");
		},
		write: async () => {
			throw new Error("sessions.write should not be used in these tests");
		},
		hasSession: () => false,
		getSessionCommand: () => undefined,
		getSessionSnapshot: () => undefined,
		onSessionExit: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool(
		{ registerTool: (definition: any) => (tool = definition) } as any,
		createExecCommandTracker(),
		sessions as any,
		{
			contextGuardEnabled: () => options.contextGuardEnabled ?? false,
		},
	);
	return tool;
}

describe("exec_command context-guard wrapping", () => {
	it("wraps a plain cmd through Context Guard batch when enabled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "exec-command-cg-wrap-"));
		const coreBin = join(dir, "context-guard-core.js");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  if (request.command !== 'batch') process.exit(2);",
				"  const command = request.params.commands[0].command;",
				"  process.stdout.write(JSON.stringify({",
				"    ok: true,",
				"    content: [{ type: 'text', text: 'ignored batch text' }],",
				"    details: {",
				"      commandCount: 1,",
				"      concurrency: 1,",
				"      queries: [],",
				"      results: [{ label: request.params.commands[0].label, command, output: 'wrapped output\\n', summary: 'ok', exitCode: 0 }]",
				"    }",
				"  }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const tool = createExecTool({ contextGuardEnabled: true });
		const result = await tool.execute("call-wrap", { cmd: "printf hello" }, undefined, undefined, {
			cwd: join(dir, "workspace"),
		});

		expect(result.details.output).toBe("wrapped output\n");
		expect(result.content[0]?.text).toContain("Command: printf hello");
		expect(result.content[0]?.text).toContain("wrapped output");
		expect(result.isError).toBe(false);

		tool.renderCall(
			{ cmd: "printf hello" },
			{ fg: (_role: string, text: string) => text, bold: (text: string) => text },
			{ toolCallId: "call-wrap", state: {}, isPartial: true, invalidate() {} },
		);
		const renderedCall = tool
			.renderCall(
				{ cmd: "printf hello" },
				{ fg: (_role: string, text: string) => text, bold: (text: string) => text },
				{ toolCallId: "call-wrap", state: {}, isPartial: false, invalidate() {} },
			)
			.render(120)
			.join("\n");
		expect(renderedCall).toContain("via context-guard");

		const rendered = tool
			.renderResult(
				result,
				{ expanded: false, isPartial: false },
				{ fg: (_role: string, text: string) => text },
				{ toolCallId: "call-wrap", args: { cmd: "printf hello" }, state: {} },
			)
			.render(120)
			.join("\n");
		expect(rendered).toContain("wrapped output");
		expect(rendered).not.toContain("Context:");
	});

	it("records wrapped plain cmd telemetry as exec_command.batch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "exec-command-cg-wrap-telemetry-"));
		const coreBin = join(dir, "context-guard-core.js");
		const logPath = join(dir, "requests.log");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"const fs = require('node:fs');",
				`const logPath = ${JSON.stringify(logPath)};`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  fs.appendFileSync(logPath, JSON.stringify(request) + '\\n', 'utf8');",
				"  const text = request.command === 'batch' ? 'ignored' : '{}';",
				"  process.stdout.write(JSON.stringify({",
				"    ok: true,",
				"    content: [{ type: 'text', text }],",
				"    details: { results: [{ output: 'hello from rust core', summary: 'ok', exitCode: 0 }] }",
				"  }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const tool = createExecTool({ contextGuardEnabled: true });
		const result = await tool.execute("call-wrap-telemetry", { cmd: "printf hello" }, undefined, undefined, {
			cwd: join(dir, "workspace"),
		});
		expect(result.details.output).toBe("hello from rust core");

		await Bun.sleep(25);

		const requests = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)) as Array<{
			command: string;
			params?: { action?: string; toolName?: string };
		}>;
		expect(requests.some((request) => request.command === "batch")).toBe(true);
		expect(
			requests.some(
				(request) =>
					request.command === "session" &&
					request.params?.action === "record_tool_telemetry" &&
					request.params?.toolName === "exec_command.batch",
			),
		).toBe(true);
	});

	it("wraps a plain cmd without using local exec", async () => {
		const dir = mkdtempSync(join(tmpdir(), "exec-command-cg-precedence-"));
		const coreBin = join(dir, "context-guard-core.js");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  if (request.command !== 'batch') process.exit(2);",
				"  const command = request.params.commands[0].command;",
				"  process.stdout.write(JSON.stringify({",
				"    ok: true,",
				"    content: [{ type: 'text', text: 'ignored' }],",
				"    details: { results: [{ label: request.params.commands[0].label, command, output: command, summary: 'ok', exitCode: 0 }] }",
				"  }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const tool = createExecTool({ contextGuardEnabled: true });
		const result = await tool.execute("call-precedence", { cmd: "printf original" }, undefined, undefined, {
			cwd: join(dir, "workspace"),
		});

		expect(result.details.output).toBe("printf original");

		tool.renderCall(
			{ cmd: "printf original" },
			{ fg: (_role: string, text: string) => text, bold: (text: string) => text },
			{ toolCallId: "call-precedence", state: {}, isPartial: true, invalidate() {} },
		);
		const renderedCall = tool
			.renderCall(
				{ cmd: "printf original" },
				{ fg: (_role: string, text: string) => text, bold: (text: string) => text },
				{ toolCallId: "call-precedence", state: {}, isPartial: false, invalidate() {} },
			)
			.render(120)
			.join("\n");
		expect(renderedCall).toContain("via context-guard");
	});

	it("delegates explicit mode:'batch' to the core and renders with exec styling", async () => {
		const dir = mkdtempSync(join(tmpdir(), "exec-command-cg-batch-"));
		const coreBin = join(dir, "context-guard-core.js");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  if (request.command !== 'batch') process.exit(2);",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(request.params) }], details: { results: [] } }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const tool = createExecTool({ contextGuardEnabled: true });
		const workdir = join(dir, "workspace");
		const result = await tool.execute(
			"call-batch",
			{
				mode: "batch",
				commands: [
					{ label: "one", command: "printf one" },
					{ label: "two", command: "printf two" },
				],
				queries: ["one", "two"],
				concurrency: 3,
				workdir,
			},
			undefined,
			undefined,
			{ cwd: join(dir, "ignored-cwd") },
		);
		const payload = JSON.parse(result.content[0]?.text ?? "{}");

		expect(payload.concurrency).toBe(3);
		expect(payload.projectDir).toBe(workdir);
		expect(payload.commands).toHaveLength(2);
		expect(payload.queries).toEqual(["one", "two"]);
		expect(String(payload.dbPath)).toContain("context-guard");

		const renderedCall = tool
			.renderCall(
				{
					mode: "batch",
					commands: [
						{ label: "one", command: "printf one" },
						{ label: "two", command: "printf two" },
					],
				},
				testTheme,
				{ isPartial: false, state: {}, invalidate() {} },
			)
			.render(120)
			.join("\n");
		expect(renderedCall).toContain("<bold>Ran</bold>");
		expect(renderedCall).not.toContain("Context:");
	});
});

const testTheme = {
	fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
};
