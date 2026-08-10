import { beforeAll, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { setCurrentContextGuardSessionId } from "../context-guard/pi/current-session.ts";
import { markExecCommandContextGuardEnabled, resetExecCommandContextGuardEnabled } from "../context-guard/pi/index.ts";
import type { PtyBackend, PtyProcess, PtySpawnOptions } from "./adapter/pty-backend.ts";
import { createRmuxPtyBackend, resolveRmuxBinary } from "./adapter/rmux-pty-backend.ts";
import { DEFAULT_EXEC_SHELL, resolveRuntimeShell } from "./adapter/runtime-shell.ts";
import execCommandExtension from "./index.ts";
import { type RenderTheme, rawCommandToExecCell, renderExecCellComponent } from "./tools/exec-cell-presentation.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import { BackgroundTerminalOverlay } from "./ui/background-terminal-overlay.ts";

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

test("extension rewrites exec_command commands when rtk is installed", async () => {
	type Handler = (event: any, ctx: any) => any;
	let toolCallHandler: Handler | undefined;
	const execCalls: string[][] = [];
	const pi = {
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			if (event === "tool_call") toolCallHandler = handler;
		},
		exec: async (_command: string, args: string[]) => {
			execCalls.push(args);
			if (args[0] === "--version") return { code: 0, stdout: "rtk 0.23.0", stderr: "" };
			return { code: 0, stdout: "rtk git status", stderr: "" };
		},
	} as any;
	execCommandExtension(pi);
	const event = { toolName: "exec_command", input: { cmd: "git status" } };

	await toolCallHandler?.(event, {});

	expect(event.input.cmd).toBe("rtk git status");
	expect(execCalls).toEqual([["--version"], ["rewrite", "git status"]]);
});

test("extension leaves exec_command commands unchanged when rtk is unavailable", async () => {
	type Handler = (event: any, ctx: any) => any;
	let toolCallHandler: Handler | undefined;
	const execCalls: string[][] = [];
	const pi = {
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			if (event === "tool_call") toolCallHandler = handler;
		},
		exec: async (_command: string, args: string[]) => {
			execCalls.push(args);
			return { code: 1, stdout: "", stderr: "" };
		},
	} as any;
	execCommandExtension(pi);
	const event = { toolName: "exec_command", input: { cmd: "git status" } };

	await toolCallHandler?.(event, {});

	expect(event.input.cmd).toBe("git status");
	expect(execCalls).toEqual([["--version"]]);
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

async function waitForCondition(condition: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(50);
	}
	expect(condition()).toBe(true);
}

async function runExecCommandCompletionScenario(command: string, toolCallId: string) {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	let renderer: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	let resolveSentMessage: (() => void) | undefined;
	const sentMessage = new Promise<void>((resolve) => {
		resolveSentMessage = resolve;
	});
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer: (_customType: string, registered: any) => {
			renderer = registered;
		},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
			resolveSentMessage?.();
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const result = await execTool.execute(
			toolCallId,
			{ cmd: command, yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.process_id).toBeNumber();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				sentMessage,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error("completion message timed out")), 5_000);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return { result, sentMessages, renderer };
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
}

test("exec cell facade caches stable component renders by width", () => {
	const component = renderExecCellComponent(
		{
			kind: "command",
			status: "done",
			command: "printf 'hello'",
			outputBlock: { output: "hello" },
		},
		{ theme: testTheme },
	);

	const first = component.render(80);
	expect(component.render(80)).toBe(first);
	expect(component.render(72)).not.toBe(first);
	component.invalidate();
	expect(component.render(80)).not.toBe(first);
});

test("exec cell facade does not retain render caches for large output blocks", () => {
	const component = renderExecCellComponent(
		{
			kind: "command",
			status: "done",
			command: "printf large",
			outputBlock: { output: `${"x".repeat(20_000)}\nend` },
		},
		{ theme: testTheme },
	);

	const first = component.render(80);
	expect(component.render(80)).not.toBe(first);
});

test("exec cell facade reuses running renders when visible text is unchanged", () => {
	const component = renderExecCellComponent(
		{
			kind: "command",
			status: "running",
			command: "sleep 60",
			elapsedMs: 0,
		},
		{ theme: testTheme },
	);

	const first = component.render(80);
	expect(component.render(80)).toBe(first);
});

test("background terminal overlay supports vim navigation, attach, and kill", async () => {
	let records: any[] = [
		{
			id: 3,
			command: "sleep 60",
			output: "tick 1\n",
			running: true,
			stdinOpen: false,
		},
		{
			id: 4,
			attachCommand: "attach node-repl",
			command: "node repl.js",
			output: "ready\nprompt\n",
			running: true,
			stdinOpen: true,
		},
	];
	const listeners: Array<() => void> = [];
	const killed: number[] = [];
	const writes: Array<{ process_id: number; chars: string }> = [];
	const copied: string[] = [];
	const resized: Array<{ processId: number; cols: number; rows: number }> = [];
	let renderRequests = 0;
	const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const overlay = new BackgroundTerminalOverlay(
		{
			listSessions: () => records,
			write: async (input: { process_id: number; chars: string }) => {
				writes.push(input);
				return {} as any;
			},
			resize: async (processId: number, cols: number, rows: number) => {
				resized.push({ processId, cols, rows });
				return true;
			},
			stopSession: (processId: number) => {
				killed.push(processId);
				records = records.filter((record) => record.id !== processId);
				for (const listener of listeners) listener();
				return true;
			},
			onSessionUpdate: (listener) => {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
		} as any,
		{ terminal: { rows: 18 }, requestRender: () => renderRequests++ } as any,
		plainTheme,
		() => {},
		async (text) => {
			copied.push(text);
		},
	);

	overlay.handleInput("j");
	overlay.handleInput("c");
	await Promise.resolve();
	expect(copied).toEqual(["attach node-repl"]);

	overlay.handleInput("l");
	overlay.render(80);
	await Promise.resolve();
	expect(resized).toEqual([{ processId: 4, cols: 76, rows: 8 }]);

	records = [{ ...records[1], output: "ready\nprompt\nnext\n" }];
	listeners[0]?.();
	expect(renderRequests).toBeGreaterThan(0);

	overlay.handleInput("h");
	await Promise.resolve();
	expect(writes).toEqual([{ process_id: 4, chars: "h" }]);

	overlay.handleInput("\u001d");

	overlay.handleInput("x");
	expect(killed).toEqual([4]);
});

test("background terminal overlay closes from interactive mode with escape", () => {
	const writes: Array<{ process_id: number; chars: string }> = [];
	let doneCalls = 0;
	const overlay = new BackgroundTerminalOverlay(
		{
			listSessions: () => [
				{
					id: 4,
					command: "node repl.js",
					output: "ready\n",
					running: true,
					stdinOpen: true,
				},
			],
			write: async (input: { process_id: number; chars: string }) => {
				writes.push(input);
				return {} as any;
			},
			onSessionUpdate: () => () => {},
		} as any,
		{ terminal: { rows: 18 }, requestRender() {} } as any,
		{ fg: (_role: string, text: string) => text, bold: (text: string) => text },
		() => doneCalls++,
	);

	overlay.handleInput("l");
	overlay.handleInput("\u001b");

	expect(doneCalls).toBe(1);
	expect(writes).toEqual([]);
});

test("completed render contexts do not keep running-command elapsed timers alive", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "sleep 60");

		const state: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			toolCallId: "call",
			state,
			isPartial: false,
			invalidate() {},
		});

		expect(state.elapsedTimer).toBeUndefined();
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("running render contexts keep only one elapsed timer per tool call", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "sleep 60");

		const firstState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		const secondState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			toolCallId: "call",
			state: firstState,
			isPartial: true,
			invalidate() {},
		});
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			toolCallId: "call",
			state: secondState,
			isPartial: true,
			invalidate() {},
		});

		expect(firstState.elapsedTimer).toBeDefined();
		expect(secondState.elapsedTimer).toBeUndefined();
		if (firstState.elapsedTimer) clearTimeout(firstState.elapsedTimer);
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("running render contexts without tool call ids de-dupe by command", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "sleep 60");

		const firstState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		const secondState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			state: firstState,
			isPartial: true,
			invalidate() {},
		});
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			state: secondState,
			isPartial: true,
			invalidate() {},
		});

		expect(firstState.elapsedTimer).toBeDefined();
		expect(secondState.elapsedTimer).toBeUndefined();
		if (firstState.elapsedTimer) clearTimeout(firstState.elapsedTimer);
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exec command streams output into its terminal frame", async () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager({ minNonInteractiveExecYieldTimeMs: 50 });
	const command = "printf first; sleep 0.25; printf second";
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call-stream", command);
		const updates: any[] = [];
		const result = await tool.execute(
			"call-stream",
			{ cmd: command, yield_time_ms: 5000 },
			undefined,
			(update: any) => updates.push(update),
			{ cwd: process.cwd() },
		);

		expect(result.details.output).toBe("firstsecond");
		expect(updates).toEqual([]);
		expect(tracker.getRenderInfo("call-stream", command).output).toBe("first");
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exec command streams partial output for file-reading commands", async () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	let receivedUpdateCallback = false;
	const sessions = {
		exec: async (_input: unknown, _cwd: string, _signal?: AbortSignal, onUpdate?: unknown) => {
			receivedUpdateCallback = typeof onUpdate === "function";
			return {
				chunk_id: "read",
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
		"call-read-stream",
		{ cmd: "sed -n '1,80p' pi/agent/extensions/exec-command/index.ts", yield_time_ms: 5000 },
		undefined,
		() => {},
		{ cwd: process.cwd() },
	);

	expect(receivedUpdateCallback).toBe(true);
	tracker.clear();
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
		expect(result.process_id).toBeDefined();
		let output = result.output;
		for (let attempt = 0; !output.includes("child=") && attempt < 12; attempt += 1) {
			const poll = await sessions.write({ process_id: result.process_id!, yield_time_ms: 250 });
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

test("extension appends a new completion message when a background terminal exits", async () => {
	const { result, sentMessages } = await runExecCommandCompletionScenario(
		"sleep 0.3; printf done",
		"call-finished-message",
	);

	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
	expect(sentMessages[0]?.message.display).toBe(true);
	expect(sentMessages[0]?.message.details.process_id).toBe(result.details.process_id);
	expect(sentMessages[0]?.message.details.elapsed_ms).toBeNumber();
	expect(sentMessages[0]?.message.details.exit_code).toBe(0);
	expect(sentMessages[0]?.message.details.output).toBe("done");
	expect(sentMessages[0]?.message.details.output_truncated).toBe(false);
});

test("extension emits completion message for quiet successful background terminal", async () => {
	const { result, sentMessages } = await runExecCommandCompletionScenario("sleep 0.3", "call-quiet-finished-message");

	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
	expect(sentMessages[0]?.message.details.process_id).toBe(result.details.process_id);
	expect(sentMessages[0]?.message.details.exit_code).toBe(0);
	expect(sentMessages[0]?.message.details.output).toBe("");
	expect(sentMessages[0]?.message.details.output_truncated).toBe(false);
	expect(sentMessages[0]?.message.content).toContain("Process exited with code 0");
	expect(sentMessages[0]?.message.content).toContain("Output:\n");
});

test("escape interrupts a foreground exec_command while the tool is waiting", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	let terminalInputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	let abortCalled = false;
	const controller = new AbortController();
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus(_key: string, text: string | undefined) {
				statuses.push(text);
			},
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			onTerminalInput(handler: typeof terminalInputHandler) {
				terminalInputHandler = handler;
				return () => {
					terminalInputHandler = undefined;
				};
			},
		},
		cwd: process.cwd(),
		abort() {
			abortCalled = true;
			controller.abort();
		},
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		for (const handler of handlers.get("tool_execution_start") ?? []) {
			handler({ toolName: "exec_command", toolCallId: "call-foreground-abort", args: { cmd: "sleep 60" } }, ctx);
		}

		const execution = execTool.execute(
			"call-foreground-abort",
			{ cmd: "sleep 60", yield_time_ms: 120_000 },
			controller.signal,
			undefined,
			ctx,
		);
		expect(statuses.filter((status) => status?.includes("background terminal"))).toEqual([]);
		await waitForCondition(() => terminalInputHandler !== undefined);
		expect(terminalInputHandler?.("\x1b")?.consume).toBe(true);

		const result = await Promise.race([
			execution,
			Bun.sleep(1500).then(() => {
				throw new Error("foreground exec_command did not abort promptly");
			}),
		]);

		expect(abortCalled).toBe(true);
		expect(notifications.at(-1)).toEqual({ message: "Interrupting foreground exec_command...", type: "info" });
		expect(result.details.terminal_state).toBe("cancelled");
		expect(result.details.cancelled).toBe(true);
	} finally {
		for (const handler of handlers.get("tool_execution_end") ?? []) {
			handler({ toolName: "exec_command", toolCallId: "call-foreground-abort" }, ctx);
		}
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension reports stopped background terminals as cancelled completions", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let execTool: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-cancelled-completion",
			{ cmd: "printf before-cancel; sleep 60", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const processId = spawned.details.process_id;
		expect(processId).toBeNumber();

		await commands.get("stop").handler(String(processId), ctx);
		await waitForCondition(() => sentMessages.length === 1);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
		expect(sentMessages[0]?.message.details.process_id).toBe(processId);
		expect(sentMessages[0]?.message.details.terminal_state).toBe("cancelled");
		expect(sentMessages[0]?.message.details.cancelled).toBe(true);
		expect(sentMessages[0]?.message.details.exit_code).toBeUndefined();
		expect(sentMessages[0]?.message.details.output).toContain("before-cancel");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension reports nonzero background terminal exit as command completion", async () => {
	const { result, sentMessages } = await runExecCommandCompletionScenario(
		"sleep 0.3; printf failed; exit 7",
		"call-nonzero-finished-message",
	);

	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
	expect(sentMessages[0]?.message.details.process_id).toBe(result.details.process_id);
	expect(sentMessages[0]?.message.details.terminal_state).toBe("exited");
	expect(sentMessages[0]?.message.details.exit_code).toBe(7);
	expect(sentMessages[0]?.message.details.timed_out).toBeUndefined();
	expect(sentMessages[0]?.message.details.cancelled).toBeUndefined();
	expect(sentMessages[0]?.message.details.output).toBe("failed");
});

test("extension does not emit speculative events for idle-running background terminals", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-idle-running",
			{ cmd: "sleep 2", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(spawned.details.process_id).toBeNumber();

		await Bun.sleep(600);

		expect(sentMessages).toHaveLength(0);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("exec session manager reports spawn failures as session errors, not command exits", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
	});
	try {
		const result = await sessions.exec(
			{ cmd: "printf unreachable", shell: "/tmp/definitely-missing-pi-shell", yield_time_ms: 250 },
			process.cwd(),
		);

		expect(result.terminal_state).toBe("session_error");
		expect(result.session_error).toContain("definitely-missing-pi-shell");
		expect(result.exit_code).toBeUndefined();
		expect(result.output).toContain("definitely-missing-pi-shell");
	} finally {
		sessions.shutdown();
	}
});

test("extension completion message includes truncation metadata for large final output", async () => {
	const { result, sentMessages } = await runExecCommandCompletionScenario(
		"sleep 0.3; node -e \"process.stdout.write('x'.repeat(1000))\"",
		"call-truncated-finished-message",
	);

	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
	expect(sentMessages[0]?.message.details.process_id).toBe(result.details.process_id);
	expect(sentMessages[0]?.message.details.exit_code).toBe(0);
	expect(sentMessages[0]?.message.details.output_truncated).toBe(true);
	expect(sentMessages[0]?.message.details.original_token_count).toBeNumber();
	expect(sentMessages[0]?.message.details.output).toContain("chars truncated");
	expect(sentMessages[0]?.message.content).toContain("chars truncated");
});

test("extension bounds ANSI-heavy completion message content", async () => {
	const { sentMessages } = await runExecCommandCompletionScenario(
		`sleep 0.3; node -e "for (let i = 0; i < 100; i++) console.log('\\\\x1b[1mline ' + i + '\\\\x1b[0m')"`,
		"call-ansi-heavy-finished-message",
	);

	const content = sentMessages[0]?.message.content ?? "";
	expect(content).not.toContain("\u001b[");
	expect(content.split("\n").length).toBeLessThanOrEqual(30);
	expect(content).toContain("lines omitted");
	expect(content).toContain("line 99");
});

test("background capture keeps the session that launched the command", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const dir = mkdtempSync(join(tmpdir(), "exec-command-capture-session-"));
	const logPath = join(dir, "capture.json");
	const corePath = join(dir, "core.js");
	const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
	let execTool: any;
	writeFileSync(
		corePath,
		[
			`#!${process.execPath}`,
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.on('data', chunk => input += chunk);",
			"process.stdin.on('end', () => {",
			`  fs.writeFileSync(${JSON.stringify(logPath)}, input);`,
			"  const capture = { artifactId: 'capture-1', byteCount: 1, lineCount: 1, preview: 'captured' };",
			"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(capture) }] }));",
			"});",
		].join("\n"),
	);
	chmodSync(corePath, 0o755);
	process.env.CONTEXT_GUARD_BIN = corePath;
	markExecCommandContextGuardEnabled();
	setCurrentContextGuardSessionId("launch-session");
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);
	const ctx = { hasUI: true, ui: { setStatus() {}, notify() {} }, cwd: process.cwd() };
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const result = await execTool.execute(
			"capture-session",
			{ cmd: "sleep 0.6; printf captured", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.process_id).toBeNumber();
		setCurrentContextGuardSessionId("new-session");
		await waitForCondition(() => Bun.file(logPath).size > 0);
		const request = JSON.parse(await Bun.file(logPath).text());
		expect(request.params.sessionId).toBe("launch-session");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
		setCurrentContextGuardSessionId(undefined);
		resetExecCommandContextGuardEnabled();
		if (originalCoreBin === undefined) delete process.env.CONTEXT_GUARD_BIN;
		else process.env.CONTEXT_GUARD_BIN = originalCoreBin;
	}
});

test("extension leaves active-turn background terminal completion for write_stdin instead of follow-up", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	let writeStdinTool: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeStdinTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);
	for (const handler of handlers.get("agent_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-active-turn-background",
			{ cmd: "sleep 0.3; printf ACTIVE_TURN_OK", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const processId = spawned.details.process_id;
		expect(processId).toBeNumber();

		await Bun.sleep(700);
		expect(sentMessages).toHaveLength(0);

		const poll = await writeStdinTool.execute(
			"poll-active-turn-background",
			{ process_id: processId, chars: "", yield_time_ms: 5000 },
			undefined,
			undefined,
			ctx,
		);
		expect(poll.details.exit_code).toBe(0);
		expect(poll.details.output).toContain("ACTIVE_TURN_OK");

		for (const handler of handlers.get("agent_end") ?? []) handler(undefined, ctx);
		await Bun.sleep(250);
		expect(sentMessages).toHaveLength(0);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension exposes active-turn background capture failures through write_stdin", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const dir = mkdtempSync(join(tmpdir(), "exec-command-capture-failure-"));
	const corePath = join(dir, "core.js");
	const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
	const sentMessages: Array<{ message: any; options: any }> = [];
	let execTool: any;
	let writeStdinTool: any;
	writeFileSync(corePath, `#!${process.execPath}\nprocess.exit(1);\n`);
	chmodSync(corePath, 0o755);
	process.env.CONTEXT_GUARD_BIN = corePath;
	markExecCommandContextGuardEnabled();
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeStdinTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);
	const ctx = { hasUI: true, ui: { setStatus() {}, notify() {} }, cwd: process.cwd() };
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);
	for (const handler of handlers.get("agent_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-active-turn-capture-failure",
			{ cmd: "sleep 0.3; printf CAPTURE_FAILURE", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const processId = spawned.details.process_id;
		expect(processId).toBeNumber();

		await Bun.sleep(700);
		expect(sentMessages).toHaveLength(0);

		const poll = await writeStdinTool.execute(
			"poll-active-turn-capture-failure",
			{ process_id: processId, chars: "", yield_time_ms: 5000 },
			undefined,
			undefined,
			ctx,
		);
		expect(poll.details.context_guard_capture_failure).toContain("Context Guard core exited 1");
		expect(poll.content[0]?.text).toContain("Context Guard capture failed:");

		for (const handler of handlers.get("agent_end") ?? []) handler(undefined, ctx);
		await Bun.sleep(250);
		expect(sentMessages).toHaveLength(0);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
		resetExecCommandContextGuardEnabled();
		if (originalCoreBin === undefined) delete process.env.CONTEXT_GUARD_BIN;
		else process.env.CONTEXT_GUARD_BIN = originalCoreBin;
	}
});

test("exec command does not register a second Hub entry point", () => {
	const commands = new Map<string, any>();
	execCommandExtension({
		registerTool() {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		on() {},
	} as any);

	expect(commands.has("ps")).toBe(false);
});

test("stop command stops one background terminal and completes visible ids", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let execTool: any;
	let writeTool: any;
	const notifications: Array<{ message: string; type?: string }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus() {},
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const first = await execTool.execute(
			"call-stop-1",
			{ cmd: "sleep 60", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const second = await execTool.execute(
			"call-stop-2",
			{ cmd: "sleep 60", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const firstId = first.details.process_id;
		const secondId = second.details.process_id;
		expect(firstId).toBeNumber();
		expect(secondId).toBeNumber();

		expect(await commands.get("stop").getArgumentCompletions("")).toEqual([
			{ value: String(firstId), label: `#${firstId}`, description: "sleep 60" },
			{ value: String(secondId), label: `#${secondId}`, description: "sleep 60" },
		]);

		await commands.get("stop").handler(String(firstId), ctx);

		expect(notifications).toContainEqual({ message: `Stopped background terminal #${firstId}.`, type: "info" });
		await expect(
			writeTool.execute(
				"write-stopped",
				{ process_id: firstId, chars: "", yield_time_ms: 250 },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(`Unknown process id ${firstId}`);
		const pollSecond = await writeTool.execute(
			"write-running",
			{ process_id: secondId, chars: "", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(pollSecond.details.process_id).toBe(secondId);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("stop command warns for invalid ids without stopping sessions", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let execTool: any;
	let writeTool: any;
	const notifications: Array<{ message: string; type?: string }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus() {},
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const result = await execTool.execute(
			"call-invalid-stop",
			{ cmd: "sleep 60", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const processId = result.details.process_id;
		expect(processId).toBeNumber();

		await commands.get("stop").handler("999999", ctx);
		await commands.get("stop").handler("not-a-number", ctx);

		expect(notifications).toContainEqual({ message: "No background terminal with id 999999.", type: "warning" });
		expect(notifications).toContainEqual({ message: "Usage: /stop [id]", type: "warning" });
		const poll = await writeTool.execute(
			"write-after-invalid-stop",
			{ process_id: processId, chars: "", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(poll.details.process_id).toBe(processId);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("stop command without arguments stops all background terminals and clears status", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let execTool: any;
	const notifications: Array<{ message: string; type?: string }> = [];
	const statusCalls: Array<{ key: string; text: string | undefined }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		await execTool.execute("call-stop-all-1", { cmd: "sleep 60", yield_time_ms: 250 }, undefined, undefined, ctx);
		await execTool.execute("call-stop-all-2", { cmd: "sleep 60", yield_time_ms: 250 }, undefined, undefined, ctx);
		expect(statusCalls.at(-1)?.text).toBe("2 background terminals · 2 running");

		await commands.get("stop").handler("", ctx);

		expect(notifications).toContainEqual({ message: "Stopped 2 background terminals.", type: "info" });
		expect(statusCalls.at(-1)).toEqual({ key: "background-terminals", text: undefined });
		expect(await commands.get("stop").getArgumentCompletions("")).toBeNull();
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension disables bash and activates managed process tools for every model", () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let activeTools = ["read", "bash"];
	const setActiveToolsCalls: string[][] = [];
	const pi = {
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => activeTools,
		getAllTools: () => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "exec_command" },
			{ name: "write_stdin" },
			{ name: "process_logs" },
			{ name: "process_list" },
			{ name: "process_describe" },
			{ name: "process_wait" },
			{ name: "process_resize" },
			{ name: "process_signal" },
			{ name: "process_restart" },
			{ name: "process_stop" },
		],
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

	expect(activeTools).toEqual([
		"read",
		"exec_command",
		"write_stdin",
		"process_logs",
		"process_list",
		"process_describe",
		"process_wait",
		"process_resize",
		"process_signal",
		"process_restart",
		"process_stop",
	]);
	expect(setActiveToolsCalls).toContainEqual(activeTools);

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

	expect(activeTools).toEqual([
		"read",
		"exec_command",
		"write_stdin",
		"process_logs",
		"process_list",
		"process_describe",
		"process_wait",
		"process_resize",
		"process_signal",
		"process_restart",
		"process_stop",
	]);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("exec_command keeps managed process tools active across non-interactive and tty runs", async () => {
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
		getAllTools: () => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "exec_command" },
			{ name: "write_stdin" },
			{ name: "process_logs" },
			{ name: "process_list" },
			{ name: "process_describe" },
			{ name: "process_wait" },
			{ name: "process_resize" },
			{ name: "process_signal" },
			{ name: "process_restart" },
			{ name: "process_stop" },
		],
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
		expect(activeTools).toContain("process_wait");
		const nonTty = await execTool.execute(
			"call-non-tty",
			{ cmd: "sleep 0.5; printf done", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(nonTty.details.process_id).toBeNumber();
		expect(nonTty.terminate).toBeUndefined();
		expect(activeTools).toContain("process_logs");

		const tty = await execTool.execute(
			"call-tty",
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(tty.details.process_id).toBeNumber();
		expect(tty.terminate).toBeUndefined();
		expect(activeTools).toContain("process_stop");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler();
	}
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
		expect(result.process_id).toBeUndefined();
	} finally {
		sessions.shutdown();
	}
});
test("exec session manager applies environment overrides", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: 'printf "$EXEC_COMMAND_TEST_VALUE"', env: { EXEC_COMMAND_TEST_VALUE: "configured" } },
			process.cwd(),
		);
		expect(result.output).toBe("configured");
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager stops commands at their runtime timeout", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec({ cmd: "sleep 60", timeout_ms: 50, wait_for_exit: true }, process.cwd());
		expect(result.terminal_state).toBe("timed_out");
		expect(result.timed_out).toBe(true);
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

test("exec session manager keeps searchable middle output beyond inline truncation", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: "node -e \"for (let i = 0; i < 12000; i++) console.log('line ' + i)\"", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output).not.toContain("line 6000\n");
		expect(result.capture_output).toContain("line 6000\n");
		expect(result.capture_output_truncated).toBe(false);
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
		const ttyResult = await sessions.exec(
			{
				cmd: "printf '\\033[1mb\\033[0m\\033[1mu\\033[0m\\033[1mn\\033[0m\\033[1m \\033[0m\\033[1mt\\033[0m\\033[1me\\033[0m\\033[1ms\\033[0m\\033[1mt\\033[0m\\n'",
				tty: true,
				yield_time_ms: 5000,
			},
			process.cwd(),
		);
		expect(ttyResult.output).toBe("\u001b[1mbun test\u001b[0m\n");
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

test("exec session manager keeps color-capable environment for tty commands", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{
				cmd: '[ -z "$NO_COLOR" ] && nc=unset || nc="$NO_COLOR"; printf "%s|%s|%s" "$nc" "$TERM" "$COLORTERM"',
				tty: true,
				yield_time_ms: 5000,
			},
			process.cwd(),
		);
		expect(result.output).toBe("unset|xterm-256color|truecolor");
		expect(result.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager maps fish to the codex-compatible fallback shell", async () => {
	expect(resolveRuntimeShell("/opt/homebrew/bin/fish")).toBe(DEFAULT_EXEC_SHELL);

	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: 'printf "%s" "$SHELL"', shell: "/opt/homebrew/bin/fish", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output).toBe(DEFAULT_EXEC_SHELL);
		expect(result.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager lists running and exited-unread sessions with stdin capability", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const first = await sessions.exec(
			{ cmd: "sleep 0.5; printf done", yield_time_ms: 250, ownerSessionId: "session-a" },
			process.cwd(),
		);
		expect(first.process_id).toBeNumber();

		expect(sessions.listSessions()).toEqual([
			expect.objectContaining({
				id: first.process_id!,
				name: `pi-exec-${first.process_id}`,
				command: "sleep 0.5; printf done",
				cwd: process.cwd(),
				ownerSessionId: "session-a",
				output: "",
				running: true,
				state: "running",
				exitCode: undefined,
				stdinOpen: false,
				startedAtMs: expect.any(Number),
			}),
		]);

		await waitForCondition(() => sessions.listSessions()[0]?.running === false);

		expect(sessions.listSessions()).toEqual([
			expect.objectContaining({
				id: first.process_id!,
				name: `pi-exec-${first.process_id}`,
				command: "sleep 0.5; printf done",
				cwd: process.cwd(),
				output: "done",
				running: false,
				state: "exited",
				exitCode: 0,
				stdinOpen: false,
				startedAtMs: expect.any(Number),
				finishedAtMs: expect.any(Number),
			}),
		]);

		const final = await sessions.write({ process_id: first.process_id!, chars: "", yield_time_ms: 250 });
		expect(final.output).toBe("done");
		expect(final.exit_code).toBe(0);
		expect(sessions.listSessions()).toEqual([]);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager addresses stable names and restarts processes", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const expectedCwd = join(process.cwd(), "pi");
		const first = await sessions.exec(
			{ cmd: "pwd; sleep 60", name: "web", workdir: "pi", yield_time_ms: 250 },
			process.cwd(),
		);
		expect(first.process_name).toBe("web");
		expect(sessions.describe("web")?.id).toBe(first.process_id);
		expect(sessions.logs("web")?.process_name).toBe("web");
		expect((await sessions.wait("web", expectedCwd, 1_000))?.matched).toBe(true);
		await expect(sessions.exec({ cmd: "sleep 60", name: "web", yield_time_ms: 250 }, process.cwd())).rejects.toThrow(
			"Process name already exists: web",
		);

		const restarted = await sessions.restart("web");
		expect(restarted?.process_name).toBe("web");
		expect(restarted?.process_id).not.toBe(first.process_id);
		expect(sessions.describe("web")?.id).toBe(restarted?.process_id);
		expect((await sessions.wait("web", expectedCwd, 1_000))?.matched).toBe(true);
		const reservedDefault = `pi-exec-${restarted!.process_id! + 2}`;
		const reserved = await sessions.exec(
			{ cmd: "sleep 60", name: reservedDefault, yield_time_ms: 250 },
			process.cwd(),
		);
		const unnamed = await sessions.exec({ cmd: "sleep 60", yield_time_ms: 250 }, process.cwd());
		expect(unnamed.process_name).not.toBe(reserved.process_name);
		expect(sessions.stopSession("web")).toBe(true);
		expect(sessions.stopSession(reservedDefault)).toBe(true);
		expect(sessions.stopSession(unnamed.process_id!)).toBe(true);
	} finally {
		sessions.shutdown();
	}
});

test("process wait returns when a process exits before its pattern appears", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
	});
	try {
		const started = await sessions.exec({ cmd: "sleep 0.5", yield_time_ms: 250 }, process.cwd());
		const waitStartedAt = Date.now();
		const result = await sessions.wait(started.process_id!, "never emitted", 2_000);
		expect(result?.matched).toBe(false);
		expect(result?.timed_out).toBe(false);
		expect(result?.process.state).toBe("exited");
		expect(Date.now() - waitStartedAt).toBeLessThan(1_000);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager reserves names while a PTY is starting", async () => {
	let releaseSpawn = () => {};
	let exitListener = (_event: { exitCode: number }) => {};
	const spawnGate = new Promise<void>((resolve) => {
		releaseSpawn = resolve;
	});
	const processHandle: PtyProcess = {
		name: "web",
		write() {},
		resize() {},
		kill: () => exitListener({ exitCode: 0 }),
		onData() {},
		onExit: (listener) => {
			exitListener = listener;
		},
	};
	const sessions = createExecSessionManager({
		ptyBackend: {
			spawn: async () => {
				await spawnGate;
				return processHandle;
			},
		},
		defaultExecYieldTimeMs: 250,
	});
	try {
		const firstPromise = sessions.exec({ cmd: "sleep 60", name: "web", tty: true }, process.cwd());
		await Promise.resolve();
		await expect(sessions.exec({ cmd: "sleep 60", name: "web", tty: true }, process.cwd())).rejects.toThrow(
			"Process name already exists: web",
		);
		releaseSpawn();
		const first = await firstPromise;
		expect(first.process_name).toBe("web");
		expect(sessions.stopSession("web")).toBe(true);
	} finally {
		releaseSpawn();
		sessions.shutdown();
	}
});

test("exec session manager lazily removes exited sessions when a new session starts", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const exited = await sessions.exec({ cmd: "sleep 0.4; printf done", yield_time_ms: 250 }, process.cwd());
		expect(exited.process_id).toBeNumber();

		await waitForCondition(() => sessions.listSessions()[0]?.running === false);

		expect(sessions.listSessions()).toMatchObject([
			{
				id: exited.process_id!,
				running: false,
				output: "done",
			},
		]);

		const running = await sessions.exec({ cmd: "sleep 1", yield_time_ms: 250 }, process.cwd());
		expect(running.process_id).toBeNumber();
		expect(sessions.listSessions().map((session) => session.id)).toEqual([running.process_id!]);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager provides a real tty when requested", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: "[ -t 0 ] && [ -t 1 ] && printf tty", tty: true, yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output).toContain("tty");
		expect(result.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager can use an injected PTY backend", async () => {
	let spawnOptions: PtySpawnOptions | undefined;
	let written = "";
	let resizedTo: { cols: number; rows: number } | undefined;
	const dataListeners = new Set<(data: string) => void>();
	const exitListeners = new Set<(event: { exitCode: number }) => void>();
	const processHandle: PtyProcess = {
		name: "fake-pty",
		write: (data) => {
			written += data;
			for (const listener of dataListeners) listener(`got:${data}`);
			for (const listener of exitListeners) listener({ exitCode: 0 });
		},
		resize: (cols, rows) => {
			resizedTo = { cols, rows };
		},
		kill: () => {
			for (const listener of exitListeners) listener({ exitCode: 0 });
		},
		onData: (listener) => dataListeners.add(listener),
		onExit: (listener) => exitListeners.add(listener),
	};
	const backend: PtyBackend = {
		spawn: (_file, _args, options) => {
			spawnOptions = options;
			return processHandle;
		},
	};
	const sessions = createExecSessionManager({
		ptyBackend: backend,
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
	});
	try {
		const first = await sessions.exec(
			{ cmd: "fake command", tty: true, env: { RMUX_TEST_VALUE: "set" }, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(first.process_id).toBeNumber();
		expect(first.process_name).toBe("fake-pty");
		expect(spawnOptions?.cwd).toBe(process.cwd());
		expect(spawnOptions?.env.RMUX_TEST_VALUE).toBe("set");
		expect(await sessions.resize(first.process_id!, 120, 40)).toBe(true);
		expect(resizedTo).toEqual({ cols: 120, rows: 40 });

		const completed = await sessions.write({ process_id: first.process_id!, chars: "hello" });
		expect(written).toBe("hello");
		expect(completed.output).toContain("got:hello");
		expect(completed.exit_code).toBe(0);

		const named = await sessions.exec(
			{ cmd: "named command", name: "web", tty: true, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(named.process_name).toBe("web");
		expect(spawnOptions?.sessionName).toBe("web");
		expect(await sessions.resize("web", 100, 30)).toBe(true);
		expect(await sessions.signal("web", "INT")).toBe(true);
		expect(written).toBe("hello\u0003");
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager reads append-only logs with cursors", async () => {
	let emitData: (data: string) => void = () => {};
	const processHandle: PtyProcess = {
		write() {},
		resize() {},
		kill() {},
		onData: (listener) => {
			emitData = listener;
		},
		onExit() {},
	};
	const sessions = createExecSessionManager({
		ptyBackend: { spawn: () => processHandle },
		defaultExecYieldTimeMs: 250,
	});
	try {
		const started = await sessions.exec({ cmd: "log producer", tty: true, yield_time_ms: 250 }, process.cwd());
		emitData("alpha");
		const first = sessions.logs(started.process_id!, 0, 3);
		expect(first?.output).toBe("alp");
		expect(first?.next_cursor).toBe(3);

		const waiting = sessions.wait(started.process_id!, "beta", 1000);
		emitData("beta");
		const waited = await waiting;
		expect(waited?.matched).toBe(true);
		expect(waited?.timed_out).toBe(false);
		const second = sessions.logs(started.process_id!, first?.next_cursor);
		expect(second?.output).toBe("habeta");
		expect(second?.next_cursor).toBe(9);
	} finally {
		sessions.shutdown();
	}
});

test("RMUX PTY backend runs a command against RMUX 0.10", async () => {
	const rmuxBinary = resolveRmuxBinary();
	if (!rmuxBinary) return;
	const rmuxDir = mkdtempSync(join(tmpdir(), "exec-command-rmux-"));
	const rmuxSocket = join(rmuxDir, "rmux.sock");
	const rmuxConfig = join(rmuxDir, "rmux.conf");
	writeFileSync(rmuxConfig, "set-option -g base-index 7\nset-window-option -g pane-base-index 7\n");
	const sessions = createExecSessionManager({
		ptyBackend: createRmuxPtyBackend({
			binary: rmuxBinary,
			socketPath: rmuxSocket,
			configFile: rmuxConfig,
		}),
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 1000,
	});
	try {
		const first = await sessions.exec(
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(first.process_id).toBeNumber();
		expect(first.process_name).toMatch(/^pi-exec-\d+-[0-9a-f]{8}$/);
		const record = sessions.listSessions().find((session) => session.id === first.process_id);
		expect(record?.attachCommand).toContain("attach-session");
		expect(record?.attachCommand).toContain(first.process_name!);
		expect(record?.attachment?.args).toContain("attach-session");
		execFileSync(rmuxBinary, ["-f", rmuxConfig, "-S", rmuxSocket, "has-session", "-t", first.process_name!]);
		expect(
			execFileSync(rmuxBinary, ["-f", rmuxConfig, "-S", rmuxSocket, "show-options", "-gv", "base-index"], {
				encoding: "utf8",
			}).trim(),
		).toBe("0");
		expect(
			execFileSync(rmuxBinary, ["-f", rmuxConfig, "-S", rmuxSocket, "show-options", "-gv", "status"], {
				encoding: "utf8",
			}).trim(),
		).toBe("off");
		expect(
			execFileSync(rmuxBinary, ["-f", rmuxConfig, "-S", rmuxSocket, "show-options", "-gv", "prefix"], {
				encoding: "utf8",
			}).trim(),
		).toBe("None");
		const rootKeys = execFileSync(rmuxBinary, ["-f", rmuxConfig, "-S", rmuxSocket, "list-keys", "-T", "root"], {
			encoding: "utf8",
		});
		expect(rootKeys).toMatch(/C-\]\s+detach-client/);
		expect(rootKeys).not.toMatch(/new-window|split-window|select-pane/);

		const completed = await sessions.write({ process_id: first.process_id!, chars: "rmux-backend\n" });
		expect(completed.output).toContain("got:rmux-backend");
		expect(completed.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
		execFileSync(rmuxBinary, ["-f", rmuxConfig, "-S", rmuxSocket, "kill-server"]);
		rmSync(rmuxDir, { recursive: true, force: true });
	}
});

test("RMUX isolates identical public process names across managers", async () => {
	const rmuxBinary = resolveRmuxBinary();
	if (!rmuxBinary) return;
	const rmuxDir = mkdtempSync(join(tmpdir(), "exec-command-rmux-isolation-"));
	const rmuxSocket = join(rmuxDir, "rmux.sock");
	const rmuxConfig = join(rmuxDir, "rmux.conf");
	const backend = () =>
		createRmuxPtyBackend({
			binary: rmuxBinary,
			socketPath: rmuxSocket,
			configFile: rmuxConfig,
		});
	const firstManager = createExecSessionManager({ ptyBackend: backend(), defaultExecYieldTimeMs: 250 });
	const secondManager = createExecSessionManager({ ptyBackend: backend(), defaultExecYieldTimeMs: 250 });
	try {
		const first = await firstManager.exec(
			{ cmd: 'read line; printf "first:$line"', name: "shared", tty: true, yield_time_ms: 250 },
			process.cwd(),
		);
		const second = await secondManager.exec(
			{ cmd: 'read line; printf "second:$line"', name: "shared", tty: true, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(first.process_name).toBe("shared");
		expect(second.process_name).toBe("shared");
		expect(firstManager.describe("shared")?.attachCommand).not.toBe(secondManager.describe("shared")?.attachCommand);
		expect((await firstManager.write({ process_id: "shared", chars: "one\n" })).output).toContain("first:one");
		expect((await secondManager.write({ process_id: "shared", chars: "two\n" })).output).toContain("second:two");
	} finally {
		firstManager.shutdown();
		secondManager.shutdown();
		try {
			execFileSync(rmuxBinary, ["-f", rmuxConfig, "-S", rmuxSocket, "kill-server"]);
		} catch {}
		rmSync(rmuxDir, { recursive: true, force: true });
	}
});

test("exec session manager includes stdin capability in running results and snapshots", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const nonInteractive = await sessions.exec({ cmd: "sleep 1", yield_time_ms: 250 }, process.cwd());
		expect(nonInteractive.process_id).toBeNumber();
		expect(nonInteractive.stdin_open).toBe(false);
		expect(sessions.getSessionSnapshot(nonInteractive.process_id!)?.stdinOpen).toBe(false);
		expect(sessions.getSessionStdinOpen(nonInteractive.process_id!)).toBe(false);

		const interactive = await sessions.exec(
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(interactive.process_id).toBeNumber();
		expect(interactive.stdin_open).toBe(true);
		expect(sessions.getSessionSnapshot(interactive.process_id!)?.stdinOpen).toBe(true);
		expect(sessions.getSessionStdinOpen(interactive.process_id!)).toBe(true);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager marks tty-requested sessions as stdin open", async () => {
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
		expect(first.process_id).toBeNumber();

		expect(sessions.listSessions()[0]).toMatchObject({
			id: first.process_id!,
			command: 'read line; printf "got:$line"',
			running: true,
			stdinOpen: true,
		});
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager stops one session without clearing other sessions or history", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
	});
	try {
		const first = await sessions.exec({ cmd: "sleep 60", yield_time_ms: 250 }, process.cwd());
		const second = await sessions.exec({ cmd: "sleep 60", yield_time_ms: 250 }, process.cwd());
		expect(first.process_id).toBeNumber();
		expect(second.process_id).toBeNumber();

		expect(sessions.stopSession(first.process_id!)).toBe(true);
		expect(sessions.stopSession(999_999)).toBe(false);
		expect(sessions.listSessions().map((session) => session.id)).toEqual([second.process_id!]);
		expect(sessions.getSessionCommand(first.process_id!)).toBe("sleep 60");
		expect(sessions.getSessionCommand(second.process_id!)).toBe("sleep 60");
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager stops all sessions and notifies subscribers", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
	});
	const updates: number[] = [];
	const unsubscribe = sessions.onSessionUpdate(() => updates.push(sessions.listSessions().length));
	try {
		const first = await sessions.exec({ cmd: "sleep 60", yield_time_ms: 250 }, process.cwd());
		const second = await sessions.exec({ cmd: "sleep 60", yield_time_ms: 250 }, process.cwd());
		expect(first.process_id).toBeNumber();
		expect(second.process_id).toBeNumber();
		expect(sessions.listSessions()).toHaveLength(2);

		expect(sessions.stopAllSessions()).toBe(2);
		expect(sessions.listSessions()).toEqual([]);
		expect(updates).toContain(1);
		expect(updates).toContain(2);
		expect(updates.at(-1)).toBe(0);
	} finally {
		unsubscribe();
		sessions.shutdown();
	}
});

test("exec session manager can poll running sessions", async () => {
	const sessions = createExecSessionManager();
	try {
		const first = await sessions.exec({ cmd: "sleep 1; printf done", yield_time_ms: 250 }, process.cwd());
		expect(first.process_id).toBeNumber();
		const next = await sessions.write({
			process_id: first.process_id!,
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
		expect(first.process_id).toBeNumber();
		expect(sessions.getSessionTty(first.process_id!)).toBe(true);
		const next = await sessions.write({
			process_id: first.process_id!,
			chars: "hi\n",
			yield_time_ms: 5000,
		});
		expect(next.output).toContain("got:hi");
		expect(next.exit_code).toBe(0);
		expect(sessions.getSessionTty(first.process_id!)).toBe(true);
	} finally {
		sessions.shutdown();
	}
});

test("exec cell component lays out once per width and refreshes when the cell changes", () => {
	let layouts = 0;
	const countingTheme: RenderTheme = {
		fg: (role, text) => {
			layouts++;
			return `<${role}>${text}</${role}>`;
		},
		bold: (text) => text,
	};
	const cell = rawCommandToExecCell({ command: "echo one", status: "done" });
	const env = { theme: countingTheme, width: 80 };
	const component = renderExecCellComponent(cell, env);

	const first = component.render(80);
	const layoutsAfterFirst = layouts;
	for (let frame = 0; frame < 10; frame++) component.render(80);

	// Repeat frames must not re-run renderExecCell: that is the shell tokenizing,
	// highlighting and output limiting that dominated every animation frame.
	expect(layouts).toBe(layoutsAfterFirst);
	expect(component.render(80)).toBe(first);

	// A different width has to be laid out again rather than reusing 80-column lines.
	const narrow = component.render(40);
	expect(narrow).not.toBe(first);
	expect(layouts).toBeGreaterThan(layoutsAfterFirst);

	// A new cell must not keep serving the old command.
	const updated = rawCommandToExecCell({ command: "echo two", status: "done" });
	const same = renderExecCellComponent(updated, { theme: countingTheme, width: 80 }, component);
	expect(same).toBe(component);
	const refreshed = stripAnsi(same.render(80).join("\n")).replace(/<\/?[a-zA-Z]+>/g, "");
	expect(refreshed).toContain("echo two");
	expect(refreshed).not.toContain("echo one");
});
