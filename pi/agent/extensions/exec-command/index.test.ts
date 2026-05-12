import { beforeAll, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import execCommandExtension from "./index.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import {
	formatElapsedTime,
	type RenderTheme,
	renderExecCommandCall,
	renderGroupedExecCommandCall,
	renderOutputBlock,
	renderWriteStdinCall,
} from "./tools/exec-rendering.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import { computeRtkRewriteDecision, parseRtkExecutablePath } from "./tools/rtk-wrapper.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";

const testTheme: RenderTheme = {
	fg: (role, text) => `<${role}>${text}</${role}>`,
	bold: (text) => `<bold>${text}</bold>`,
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeAll(() => {
	initTheme("dark");
});

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function processList(): string {
	return execSync("ps -axo pid,ppid,pgid,stat,command", { encoding: "utf8" });
}

async function waitForProcessListToExclude(marker: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (!processList().includes(marker)) return;
		await Bun.sleep(100);
	}
	expect(processList()).not.toContain(marker);
}

test("exec command call renders inline syntax-highlighted commands", () => {
	const rendered = renderExecCommandCall(
		`git diff --stat luan/pbt...luan/pbt-fixes && gh pr edit 57220 --title "fix(sync): resolve PBT convergence failures"`,
		"done",
		testTheme,
	);
	expect(
		rendered.startsWith(
			`<success>•</success> <bold>Ran</bold> <syntaxFunction>git</syntaxFunction> diff <syntaxKeyword>--stat</syntaxKeyword>`,
		),
	).toBe(true);
	expect(rendered).toContain(
		`<syntaxOperator>&&</syntaxOperator> <syntaxFunction>gh</syntaxFunction> pr edit 57220 <syntaxKeyword>--title</syntaxKeyword> <syntaxString>"fix(sync): resolve PBT convergence failures"</syntaxString>`,
	);
	expect(rendered).not.toContain("\n<dim>  └ ");
});

test("exec command call unwraps simple shell wrappers before rendering", () => {
	const rendered = renderExecCommandCall(`bash -lc 'git status --short'`, "running", testTheme);
	expect(rendered).toBe(
		`<dim>⠋</dim> <bold>Running</bold> <syntaxFunction>git</syntaxFunction> status <syntaxKeyword>--short</syntaxKeyword>`,
	);
});

test("exec command call limits very long command lines", () => {
	const rendered = renderExecCommandCall(`printf ${"x".repeat(300)}`, "done", testTheme);
	expect(rendered).toEndWith("...");
	expect(rendered).not.toContain("x".repeat(200));
});

test("write stdin call uses unwrapped command previews", () => {
	const rendered = renderWriteStdinCall(3, "", `bash -lc 'git status --short'`, testTheme);
	expect(rendered).toBe(
		`<success>• </success><bold>Waited for background terminal</bold><dim> · </dim><muted>git status --short</muted>`,
	);
});

test("running terminal calls show elapsed time", () => {
	expect(formatElapsedTime(65_400)).toBe("1m 05s");
	const firstFrame = renderExecCommandCall("sleep 60", "running", testTheme, false, 0);
	const secondFrame = renderExecCommandCall("sleep 60", "running", testTheme, false, 120);
	expect(firstFrame).not.toBe(secondFrame);
	expect(renderExecCommandCall("sleep 60", "running", testTheme, false, 65_400)).toContain(
		`<bold>Running</bold> <syntaxFunction>sleep</syntaxFunction> 60<dim> · 1m 05s</dim>`,
	);
	expect(renderWriteStdinCall(3, "", "sleep 60", testTheme, "running", false, 65_400)).toBe(
		`<dim>• </dim><bold>Waiting for background terminal</bold><dim> · 1m 05s</dim><dim> · </dim><muted>sleep 60</muted>`,
	);
});

test("grouped exploration rows use a one-line in-flight placeholder", () => {
	const actionGroups = [[{ kind: "read", title: "Read", body: "a.ts" }]] as any;
	const running = renderGroupedExecCommandCall(actionGroups, "running", testTheme, false, 0);
	const done = renderGroupedExecCommandCall(actionGroups, "done", testTheme, false, 120);

	expect(running).toBe("<dim>⠋</dim> <bold>Exploring</bold>");
	expect(running).not.toContain("a.ts");
	expect(done).toContain("<success>•</success> <bold>Explored</bold>");
	expect(done).toContain("<accent>Read</accent>");
});

test("exploration grouping keeps the first row as the visible anchor", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);

		tracker.recordStart("call-1", "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts");
		tracker.recordStart("call-2", "sed -n '1,20p' pi/agent/extensions/exec-command/tools/exec-command-tool.ts");

		const firstRow = tool
			.renderCall({ cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts" }, testTheme, {
				toolCallId: "call-1",
				state: {},
				isPartial: true,
				invalidate() {},
			})
			.render(200)
			.join("\n");
		const secondRow = tool
			.renderCall({ cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/tools/exec-command-tool.ts" }, testTheme, {
				toolCallId: "call-2",
				state: {},
				isPartial: true,
				invalidate() {},
			})
			.render(200)
			.join("\n");

		expect(firstRow).toContain("<bold>Exploring</bold>");
		expect(firstRow).not.toContain("index.ts");
		expect(firstRow).not.toContain("exec-command-tool.ts");
		expect(secondRow).toBe("");
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exploration grouping hides later placeholders before execution starts", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);

		const firstRow = tool
			.renderCall({ cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts" }, testTheme, {
				toolCallId: "call-1",
				state: {},
				isPartial: true,
				invalidate() {},
			})
			.render(200)
			.join("\n");
		const secondRow = tool
			.renderCall({ cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/tools/exec-command-tool.ts" }, testTheme, {
				toolCallId: "call-2",
				state: {},
				isPartial: true,
				invalidate() {},
			})
			.render(200)
			.join("\n");

		expect(firstRow).toContain("<bold>Exploring</bold>");
		expect(secondRow).toBe("");
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exploration grouping does not append a single command output preview", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);

		tracker.recordStart("call-1", "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts");
		const resultRow = tool.renderResult(
			{
				content: [{ type: "text", text: "fallback" }],
				details: { output: "arbitrary file preview\n", exit_code: 0 },
			},
			{ expanded: false, isPartial: false },
			testTheme,
			{
				toolCallId: "call-1",
				args: { cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts" },
				state: {},
			},
		);

		expect(resultRow.render(200)).toEqual([]);
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("yielded background exec calls do not keep scheduling elapsed redraws", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "sleep 60");
		tracker.recordPersistentSession("call", 7);

		const state: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			toolCallId: "call",
			state,
			isPartial: false,
			invalidate: () => {
				throw new Error("final background row should not schedule redraws");
			},
		});

		expect(state.elapsedTimer).toBeUndefined();
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exec command call renders failed status as a red dot", () => {
	const rendered = renderExecCommandCall("false", "done", testTheme, true);
	expect(rendered).toBe(`<error>•</error> <bold>Ran</bold> <syntaxFunction>false</syntaxFunction>`);
});

test("exec command call can show an RTK routing marker", () => {
	const rendered = renderExecCommandCall("cargo test", "done", testTheme, false, undefined, true);
	expect(rendered).toBe(
		`<success>•</success> <bold>Ran</bold> <syntaxFunction>cargo</syntaxFunction> test<dim> · </dim><mdLink>\x1b[3mvia rtk\x1b[23m</mdLink>`,
	);
});

test("line-safe rg summaries do not display numeric limits as the query", () => {
	const rendered = renderExecCommandCall(
		`rg -n -M 400 --max-columns-preview "struct SyncPersistenceUtilities|class SyncPersistenceUtilities"`,
		"done",
		testTheme,
	);
	expect(rendered).toContain("<bold>Explored</bold>");
	expect(rendered).toContain(
		"<accent>Search</accent> <muted>struct SyncPersistenceUtilities|class SyncPersistenceUtilities</muted>",
	);
	expect(rendered).not.toContain("<muted>400");
});

test("compact rtk grep summaries do not display output limits as the query", () => {
	const rendered = renderExecCommandCall(
		`rtk grep -m 100 -l 400 "struct SyncPersistenceUtilities|class SyncPersistenceUtilities" src`,
		"done",
		testTheme,
	);
	expect(rendered).toContain("<bold>Explored</bold>");
	expect(rendered).toContain(
		"<accent>Search</accent> <muted>struct SyncPersistenceUtilities|class SyncPersistenceUtilities in src</muted>",
	);
	expect(rendered).not.toContain("<muted>400");
});

test("output block uses Codex-like prefixes and preserves ANSI color", () => {
	const rendered = renderOutputBlock("plain\n\u001b[32m✓ green\u001b[0m\n", testTheme);
	expect(rendered).toBe(`<dim>  └ </dim><dim>plain</dim>\n<dim>    </dim>\u001b[32m✓ green\u001b[0m`);
});

test("output block preserves plain line spacing", () => {
	const rendered = renderOutputBlock("  indented  ", testTheme);
	expect(rendered).toBe("<dim>  └ </dim><dim>  indented  </dim>");
});

test("output block limits very long plain lines", () => {
	const rendered = renderOutputBlock("x".repeat(300), testTheme);
	expect(rendered).toBe(`<dim>  └ </dim><dim>${"x".repeat(217)}...</dim>`);
});

test("output block truncates by displayed rows for long URL-like lines", () => {
	const longUrl = "https://example.test/api/v1/projects/alpha-team/releases/2026-02-17/builds/1234567890";
	const rendered = renderOutputBlock(`${longUrl}\ntail`, testTheme, undefined, {
		maxLines: 2,
		width: 32,
	});

	expect(rendered).toContain("… +");
	expect(rendered).toContain("tail");
});

test("output block collapses large output in the middle", () => {
	const rendered = renderOutputBlock(
		Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"),
		testTheme,
		undefined,
		{ maxLines: 5 },
	);

	expect(stripAnsi(rendered)).toBe(
		[
			"<dim>  └ </dim><dim>line 1</dim>",
			"<dim>    </dim><dim>line 2</dim>",
			"<dim>    </dim>… +4 lines ( transcript)",
			"<dim>    </dim><dim>line 7</dim>",
			"<dim>    </dim><dim>line 8</dim>",
		].join("\n"),
	);
	expect(rendered).toContain("\x1b[");
});

test("output block marks token-truncated output at the top", () => {
	const rendered = renderOutputBlock("tail", testTheme, undefined, {
		truncatedAbove: true,
		originalTokenCount: 1234,
	});

	expect(rendered).toBe(
		"<dim>  └ </dim><dim>… output truncated above (original ~1234 tokens)</dim>\n<dim>    </dim><dim>tail</dim>",
	);
});

test("exec renderers self-render without the default success shell", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool(
			{ registerTool: (definition: any) => (tool = definition) } as any,
			createExecCommandTracker(),
			sessions,
		);

		expect(tool.renderShell).toBe("self");
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "fallback" }],
				details: { output: "visible output\nnext line\n", exit_code: 0 },
			},
			{ expanded: false, isPartial: false },
			testTheme,
			{ toolCallId: "call", args: { cmd: "printf visible" } },
		);
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("<dim>  └ </dim><dim>visible output</dim>");
		expect(rendered).toContain("<dim>    </dim><dim>next line</dim>");
		expect(rendered).not.toContain("Exit code: 0");
	} finally {
		sessions.shutdown();
	}
});

test("exec result renderer truncates output by rendered width", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool(
			{ registerTool: (definition: any) => (tool = definition) } as any,
			createExecCommandTracker(),
			sessions,
		);

		const longUrl = `https://example.test/${"very-long-segment/".repeat(20)}`;
		const rendered = tool
			.renderResult(
				{
					content: [{ type: "text", text: "fallback" }],
					details: { output: `${longUrl}\ntail`, exit_code: 0 },
				},
				{ expanded: false, isPartial: false },
				testTheme,
				{ toolCallId: "call", args: { cmd: "printf long" }, state: {} },
			)
			.render(32)
			.join("\n");

		expect(rendered).toContain("… +");
		expect(rendered).toContain("tail");
	} finally {
		sessions.shutdown();
	}
});

test("extension hides empty self-rendered tool rows", () => {
	type Handler = () => void;
	const handlers = new Map<string, Handler[]>();
	execCommandExtension({
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any);

	const hiddenTool = {
		renderShell: "self",
		renderCall() {
			return new Container();
		},
		renderResult() {
			return new Container();
		},
	};
	const component = new ToolExecutionComponent(
		"hidden",
		"call-hidden",
		{},
		{},
		hiddenTool as any,
		{ requestRender() {} } as any,
		process.cwd(),
	);

	expect(component.render(80)).toEqual([]);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("exec command streams partial output while the process is still running", async () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager({ minNonInteractiveExecYieldTimeMs: 50 });
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		const updates: any[] = [];
		const result = await tool.execute(
			"call-stream",
			{ cmd: "printf first; sleep 0.25; printf second", yield_time_ms: 5000 },
			undefined,
			(update: any) => updates.push(update),
			{ cwd: process.cwd() },
		);

		expect(result.details.output).toBe("firstsecond");
		expect(updates.some((update) => update.details?.output?.includes("first"))).toBe(true);
		expect(updates.some((update) => update.details?.session_id !== undefined)).toBe(true);
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exec command suppresses partial output streaming for exploration commands", async () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	let receivedUpdateCallback = false;
	const sessions = {
		exec: async (_input: unknown, _cwd: string, _signal?: AbortSignal, onUpdate?: unknown) => {
			receivedUpdateCallback = typeof onUpdate === "function";
			return {
				chunk_id: "explore",
				wall_time_seconds: 0,
				output: "content",
				exit_code: 0,
			};
		},
		write: async () => {
			throw new Error("unexpected write");
		},
		hasSession: () => false,
		getSessionCommand: () => undefined,
		onSessionExit: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions as any);

	await tool.execute(
		"call-explore-stream",
		{ cmd: "sed -n '1,80p' pi/agent/extensions/exec-command/index.ts", yield_time_ms: 5000 },
		undefined,
		() => {
			throw new Error("exploration command should not stream partial output");
		},
		{ cwd: process.cwd() },
	);

	expect(receivedUpdateCallback).toBe(false);
	tracker.clear();
});

test("write stdin renderer self-renders without the default success shell", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerWriteStdinTool({ registerTool: (definition: any) => (tool = definition) } as any, sessions);

		expect(tool.renderShell).toBe("self");
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { output: "poll output\n", exit_code: 0 },
			},
			{ expanded: false, isPartial: false },
			testTheme,
		);
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("<dim>  └ </dim><dim>poll output</dim>");
		expect(rendered).not.toContain("Exit code: 0");
	} finally {
		sessions.shutdown();
	}
});

test("shutdown terminates descendant processes that escaped the shell process group", async () => {
	const marker = `exec-command-shutdown-descendant-${process.pid}-${Date.now()}`;
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 250 });
	const childCode = [
		"import signal,time",
		"signal.signal(signal.SIGTERM, signal.SIG_IGN)",
		"signal.signal(signal.SIGHUP, signal.SIG_IGN)",
		"time.sleep(30)",
	].join("; ");
	const parentCode = [
		"import subprocess,time",
		`p=subprocess.Popen(["python3","-c",${JSON.stringify(childCode)},${JSON.stringify(`${marker}-child`)}], start_new_session=True)`,
		'print("child="+str(p.pid), flush=True)',
		"time.sleep(30)",
	].join("; ");

	try {
		const result = await sessions.exec(
			{
				cmd: `python3 -c ${shellQuote(parentCode)} ${shellQuote(`${marker}-parent`)}`,
				yield_time_ms: 250,
			},
			process.cwd(),
		);
		expect(result.session_id).toBeDefined();
		let output = result.output;
		for (let attempt = 0; !output.includes("child=") && attempt < 12; attempt += 1) {
			const poll = await sessions.write({ session_id: result.session_id!, yield_time_ms: 250 });
			output += poll.output;
		}
		expect(output).toContain("child=");
		expect(processList()).toContain(`${marker}-child`);

		sessions.shutdown();

		await waitForProcessListToExclude(marker);
	} finally {
		sessions.shutdown();
		try {
			execSync(`pkill -KILL -f ${shellQuote(marker)}`);
		} catch {
			// Process already exited.
		}
	}
});

test("extension marks nonzero exec results as errors for red status dots", () => {
	type Handler = (event?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const toolResultHandlers = handlers.get("tool_result") ?? [];
	const nonzero = toolResultHandlers.map((handler) =>
		handler({
			toolName: "exec_command",
			details: { output: "", exit_code: 1 },
		}),
	);
	const zero = toolResultHandlers.map((handler) =>
		handler({
			toolName: "exec_command",
			details: { output: "", exit_code: 0 },
		}),
	);

	expect(nonzero).toContainEqual({ isError: true });
	expect(zero.every((result) => result === undefined)).toBe(true);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("extension disables bash and activates exec_command plus write_stdin for every model", () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let activeTools = ["read", "bash"];
	const setActiveToolsCalls: string[][] = [];
	const pi = {
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => activeTools,
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "exec_command" }, { name: "write_stdin" }],
		setActiveTools: (next: string[]) => {
			activeTools = next;
			setActiveToolsCalls.push(next);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	for (const handler of handlers.get("session_start") ?? []) {
		handler(undefined, { model: { provider: "anthropic", id: "claude-sonnet" } });
	}

	expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
	expect(setActiveToolsCalls).toContainEqual(["read", "exec_command", "write_stdin"]);

	const block = handlers
		.get("tool_call")
		?.map((handler) => handler({ toolName: "bash" }, { model: { provider: "anthropic", id: "claude-sonnet" } }))
		.find((result) => result?.block);

	expect(block).toEqual({
		block: true,
		reason: "bash is disabled. Use exec_command instead.",
	});
	const writeBlock = handlers
		.get("tool_call")
		?.map((handler) =>
			handler({ toolName: "write_stdin" }, { model: { provider: "anthropic", id: "claude-sonnet" } }),
		)
		.find((result) => result?.block);
	expect(writeBlock).toBeUndefined();

	for (const handler of handlers.get("model_select") ?? []) {
		handler(undefined, { model: { provider: "anthropic", id: "claude-sonnet" } });
	}

	expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("exec_command keeps write_stdin active across non-interactive and tty runs", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let activeTools = ["read", "bash"];
	let execTool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => activeTools,
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "exec_command" }, { name: "write_stdin" }],
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		model: { provider: "anthropic", id: "claude-sonnet" },
		ui: { notify() {} },
	};
	for (const handler of handlers.get("session_start") ?? []) {
		handler(undefined, ctx);
	}
	try {
		await commands.get("rtk").handler("off", ctx);

		expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
		const nonTty = await execTool.execute(
			"call-non-tty",
			{ cmd: "sleep 0.5; printf done", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(nonTty.details.session_id).toBeNumber();
		expect(nonTty.terminate).toBeUndefined();
		expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);

		const tty = await execTool.execute(
			"call-tty",
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(tty.details.session_id).toBeNumber();
		expect(tty.terminate).toBeUndefined();
		expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler();
	}
});

test("rtk command toggles default-on exec command wrapping", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const commands = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	let tool: any;
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			if (command === "which") return { code: 0, stdout: "/usr/local/bin/rtk\n", stderr: "" };
			return { code: 3, stdout: "printf rtk-wrapped\n", stderr: "" };
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		cwd: process.cwd(),
	};
	const rtkCommand = commands.get("rtk");
	expect(rtkCommand).toBeDefined();
	expect(await rtkCommand.getArgumentCompletions("o")).toEqual([
		{ value: "on", label: "on" },
		{ value: "off", label: "off" },
	]);

	const enabled = await tool.execute(
		"call-enabled",
		{ cmd: "printf original", yield_time_ms: 5000 },
		undefined,
		undefined,
		ctx,
	);

	expect(enabled.details.output).toBe("rtk-wrapped");
	expect(enabled.content[0].text).toContain("Command: printf original");
	expect(enabled.content[0].text).not.toContain("printf rtk-wrapped");
	expect(execCalls).toEqual([
		{ command: "which", args: ["rtk"] },
		{ command: "/usr/local/bin/rtk", args: ["rewrite", "printf original"] },
	]);
	expect(notifications.some((notice) => notice.message.startsWith("RTK rewrite:"))).toBe(false);

	for (const handler of handlers.get("tool_execution_start") ?? []) {
		handler({
			toolName: "exec_command",
			toolCallId: "call-render",
			args: { cmd: "printf original" },
		});
	}
	await tool.execute("call-render", { cmd: "printf original", yield_time_ms: 5000 }, undefined, undefined, ctx);
	for (const handler of handlers.get("tool_execution_end") ?? []) {
		handler({ toolName: "exec_command", toolCallId: "call-render" });
	}
	const renderedCall = tool
		.renderCall({ cmd: "printf original" }, testTheme, {
			toolCallId: "call-render",
			state: {},
			isPartial: false,
			invalidate() {},
		})
		.render(200)
		.join("\n");
	expect(renderedCall).toContain("<mdLink>\x1b[3mvia rtk\x1b[23m</mdLink>");
	expect(renderedCall).not.toContain("printf rtk-wrapped");

	await rtkCommand.handler("off", ctx);
	const off = await tool.execute("call-off", { cmd: "printf off", yield_time_ms: 5000 }, undefined, undefined, ctx);
	expect(off.details.output).toBe("off");
	expect(notifications).toContainEqual({ message: "RTK wrapping disabled.", type: "info" });

	await rtkCommand.handler("on", ctx);
	expect(notifications).toContainEqual({ message: "RTK wrapping enabled.", type: "info" });

	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("rtk wrapping updates legacy command argument aliases", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const commands = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	let tool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		exec: async (command: string) => {
			if (command === "which") return { code: 0, stdout: "/usr/local/bin/rtk\n", stderr: "" };
			return { code: 0, stdout: "printf alias-wrapped\n", stderr: "" };
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const ctx = { hasUI: false, ui: { notify() {} }, cwd: process.cwd() };
	const prepared = tool.prepareArguments({ command: "printf alias-original", yield_time_ms: 5000 });
	const result = await tool.execute("call-alias", prepared, undefined, undefined, ctx);

	expect(result.details.output).toBe("alias-wrapped");
	expect(result.content[0].text).toContain("Command: printf alias-original");

	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("rtk helper parses executable paths", () => {
	expect(parseRtkExecutablePath("'rtk path'\n")).toBe("rtk path");
});

test("rtk rewrite is allowed to rewrite rg commands", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			if (command === "which") return { code: 0, stdout: "/usr/local/bin/rtk\n", stderr: "" };
			return { code: 0, stdout: "rtk grep --files\n", stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "pwd && rg --files -g '!*node_modules*' | head -200", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("rtk grep --files");
	expect(execCalls).toEqual([
		{ command: "which", args: ["rtk"] },
		{
			command: "/usr/local/bin/rtk",
			args: ["rewrite", "pwd && rg --files -g '!*node_modules*' | head -200"],
		},
	]);
});

test("rtk grep rewrite of rg uses raw rg immediately", async () => {
	let tool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
	} as any;
	const tracker = createExecCommandTracker();
	const executedCommands: string[] = [];
	const sessions = {
		exec: async (input: { cmd: string }) => {
			executedCommands.push(input.cmd);
			return {
				chunk_id: "ok",
				wall_time_seconds: 0,
				output: "pi/agent/extensions/exec-command/tools/rtk-wrapper.ts\n",
				exit_code: 0,
			};
		},
		write: async () => {
			throw new Error("unexpected write");
		},
		hasSession: () => false,
		getSessionCommand: () => undefined,
		onSessionExit: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool(pi, tracker, sessions as any, {
		rewriteCommand: () => "pwd && rtk grep --files",
	});

	const result = await tool.execute(
		"call-rg-fallback",
		{ cmd: "rg --files pi/agent/extensions/exec-command/tools/rtk-wrapper.ts" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	expect(executedCommands).toEqual(["rg --files pi/agent/extensions/exec-command/tools/rtk-wrapper.ts"]);
	expect(result.details.output).toContain("rtk-wrapper.ts");
	expect(result.isError).toBe(false);
});

test("rtk grep rewrite of raw-only rg modes uses raw rg immediately", async () => {
	let tool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
	} as any;
	const tracker = createExecCommandTracker();
	const executedCommands: string[] = [];
	const sessions = {
		exec: async (input: { cmd: string }) => {
			executedCommands.push(input.cmd);
			return {
				chunk_id: "rg",
				wall_time_seconds: 0,
				output: "ripgrep 15.1.0\n",
				exit_code: 0,
			};
		},
		write: async () => {
			throw new Error("unexpected write");
		},
		hasSession: () => false,
		getSessionCommand: () => undefined,
		onSessionExit: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool(pi, tracker, sessions as any, {
		rewriteCommand: () => "rtk grep --version",
	});

	const result = await tool.execute("call-rg-version", { cmd: "rg --version" }, undefined, undefined, {
		cwd: process.cwd(),
	});

	expect(executedCommands).toEqual(["rg --version"]);
	expect(result.details.output).toContain("ripgrep");
	expect(result.isError).toBe(false);
});

test("non-rtk safety rewrites do not render a via rtk marker", async () => {
	let tool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
	} as any;
	const tracker = createExecCommandTracker();
	const sessions = {
		exec: async () => ({
			chunk_id: "git",
			wall_time_seconds: 0,
			output: "",
			exit_code: 0,
		}),
		write: async () => {
			throw new Error("unexpected write");
		},
		hasSession: () => false,
		getSessionCommand: () => undefined,
		onSessionExit: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool(pi, tracker, sessions as any, {
		rewriteCommand: () => ({ command: "GIT_OPTIONAL_LOCKS=0 git status --short", rtkWrapped: false }),
	});

	await tool.execute("call-git-safety", { cmd: "git status --short" }, undefined, undefined, { cwd: process.cwd() });

	const renderedCall = tool
		.renderCall({ cmd: "git status --short" }, testTheme, {
			toolCallId: "call-git-safety",
			state: {},
			isPartial: false,
			invalidate() {},
		})
		.render(200)
		.join("\n");
	expect(renderedCall).not.toContain("via rtk");
});

test("rtk rewrite preserves returned shell-expanded path globs", async () => {
	const original = `rg -n "pub fn draw|fn draw" src/font/sprite/draw/*.zig`;
	const rewritten = `rtk rg -n "pub fn draw|fn draw" src/font/sprite/draw/*.zig`;
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			if (command === "which") return { code: 0, stdout: "/usr/local/bin/rtk\n", stderr: "" };
			return { code: 0, stdout: `${rewritten}\n`, stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, original, true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe(rewritten);
	expect(execCalls).toEqual([
		{ command: "which", args: ["rtk"] },
		{ command: "/usr/local/bin/rtk", args: ["rewrite", original] },
	]);
});

test("rtk rewrite adds optional-lock suppression to git commands without invoking rtk", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "rtk git status --short\n", stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "git status --short", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("GIT_OPTIONAL_LOCKS=0 git status --short");
	expect(execCalls).toEqual([]);
});

test("rtk rewrite does not wrap git write commands", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "rtk git add file.txt\n", stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "git add file.txt", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("GIT_OPTIONAL_LOCKS=0 git add file.txt");
	expect(execCalls).toEqual([]);
});

test("rtk rewrite applies git optional-lock suppression across shell segments", async () => {
	const pi = {
		exec: async () => {
			throw new Error("rtk should not be invoked for git commands");
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "git add file.txt && git status -sb", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe(
		"GIT_OPTIONAL_LOCKS=0 git add file.txt && GIT_OPTIONAL_LOCKS=0 git status -sb",
	);
});

test("rtk rewrite applies git optional-lock suppression inside shell scripts", async () => {
	const pi = {
		exec: async () => {
			throw new Error("rtk should not be invoked for git commands");
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "bash -lc 'git status --short'", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("bash -lc 'GIT_OPTIONAL_LOCKS=0 git status --short'");
});

test("rtk rewrite suppresses optional locks for explicit rtk git commands", async () => {
	const pi = {
		exec: async () => {
			throw new Error("rtk rewrite should not be invoked for explicit rtk commands");
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "rtk git status -sb", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("GIT_OPTIONAL_LOCKS=0 rtk git status -sb");
});

test("rtk rewrite leaves already-protected git commands raw", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "rtk git status --short\n", stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "GIT_OPTIONAL_LOCKS=0 git status --short", true);

	expect(decision.changed).toBe(false);
	expect(decision.rewrittenCommand).toBe("GIT_OPTIONAL_LOCKS=0 git status --short");
	expect(execCalls).toEqual([]);
});

test("rtk rewrite does not wrap graphite or gh commands", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "rtk gt up\n", stderr: "" };
		},
	} as any;

	const graphite = await computeRtkRewriteDecision(pi, "gt up", true);
	const github = await computeRtkRewriteDecision(pi, "gh pr view", true);

	expect(graphite.changed).toBe(false);
	expect(graphite.rewrittenCommand).toBe("gt up");
	expect(github.changed).toBe(false);
	expect(github.rewrittenCommand).toBe("gh pr view");
	expect(execCalls).toEqual([]);
});

test("extension truncates oversized non-exec tool results before session history", () => {
	type Handler = (event?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const toolResultHandlers = handlers.get("tool_result") ?? [];
	const output = `${"head\n"}${"x".repeat(200000)}${"\ntail"}`;
	const results = toolResultHandlers.map((handler) =>
		handler({
			toolName: "read",
			content: [{ type: "text", text: output }],
			details: undefined,
			isError: false,
		}),
	);

	const patch = results.find((result) => result?.content);
	const text = patch.content[0].text;
	expect(text).toStartWith("Total output lines: 3\n\nhead\n");
	expect(text).toContain("chars truncated");
	expect(text).toContain("\ntail");
	expect(text.length).toBeLessThan(41_000);
	expect(text.split("\n").every((line: string) => line.length <= 430)).toBe(true);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("exec session manager runs short non-interactive commands", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec({ cmd: "printf exec-command", yield_time_ms: 5000 }, process.cwd());
		expect(result.output).toBe("exec-command");
		expect(result.exit_code).toBe(0);
		expect(result.session_id).toBeUndefined();
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager uses middle truncation", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: "node -e \"process.stdout.write('x'.repeat(200000))\"", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output_truncated).toBe(true);
		expect(result.output).toStartWith("Total output lines: 1\n\n");
		expect(result.output).toContain("chars truncated");
		expect(result.output.length).toBeLessThan(41_000);
		expect(result.output.split("\n").every((line) => line.length <= 430)).toBe(true);
		expect(result.original_token_count).toBe(50000);
		expect("full_output_path" in result).toBe(false);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager keeps head and tail when truncating many output lines", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: "node -e \"for (let i = 0; i < 12000; i++) console.log('line ' + i)\"", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output_truncated).toBe(true);
		expect(result.output).toContain("Total output lines: 12000");
		expect(result.output).toContain("line 0\n");
		expect(result.output).toContain("line 11999");
		expect(result.output).not.toContain("line 6000\n");
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager preserves ANSI SGR color output", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: "printf '\\033[32m✓ green\\033[0m\\n'", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output).toBe("\u001b[32m✓ green\u001b[0m\n");
		expect(result.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager uses a non-color environment", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{
				cmd: '[ -z "$FORCE_COLOR" ] && fc=unset || fc="$FORCE_COLOR"; printf "%s|%s|%s" "$NO_COLOR" "$TERM" "$fc"',
				yield_time_ms: 5000,
			},
			process.cwd(),
		);
		expect(result.output).toBe("1|dumb|unset");
		expect(result.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager can poll running sessions", async () => {
	const sessions = createExecSessionManager();
	try {
		const first = await sessions.exec({ cmd: "sleep 1; printf done", yield_time_ms: 250 }, process.cwd());
		expect(first.session_id).toBeNumber();
		const next = await sessions.write({
			session_id: first.session_id!,
			chars: "",
			yield_time_ms: 5000,
		});
		expect(next.output).toContain("done");
		expect(next.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager can write to tty-requested sessions", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const first = await sessions.exec(
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(first.session_id).toBeNumber();
		const next = await sessions.write({
			session_id: first.session_id!,
			chars: "hi\n",
			yield_time_ms: 5000,
		});
		expect(next.output).toContain("got:hi");
		expect(next.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});
