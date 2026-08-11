import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import type { PtyBackend, PtyProcess, PtySpawnOptions } from "./adapter/pty-backend.ts";
import execCommandExtensionBase, { type ExecCommandExtensionOptions } from "./index.ts";
import { type RenderTheme, rawCommandToExecCell, renderExecCellComponent } from "./tools/exec-cell-presentation.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import {
	createExecSessionManager as createBaseExecSessionManager,
	type ExecSessionManager,
	type ExecSessionManagerOptions,
} from "./tools/exec-session-manager.ts";
import { BackgroundTerminalOverlay } from "./ui/background-terminal-overlay.ts";

const testTheme: RenderTheme = {
	fg: (role, text) => `<${role}>${text}</${role}>`,
	bold: (text) => `<bold>${text}</bold>`,
};
const FAST_TEST_YIELD_TIME_MS = 5;
const FAST_EXTENSION_OPTIONS: ExecCommandExtensionOptions = {
	sessionManagerOptions: {
		defaultExecYieldTimeMs: FAST_TEST_YIELD_TIME_MS,
		defaultWriteYieldTimeMs: FAST_TEST_YIELD_TIME_MS,
		minYieldTimeMs: 1,
		minNonInteractiveExecYieldTimeMs: FAST_TEST_YIELD_TIME_MS,
		minEmptyWriteYieldTimeMs: FAST_TEST_YIELD_TIME_MS,
	},
	backgroundTerminalCompletionHoldMs: 0,
};

function execCommandExtension(pi: any): void {
	execCommandExtensionBase(pi, FAST_EXTENSION_OPTIONS);
}

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
interface PipeGate {
	path: string;
	release(): void;
	cleanup(): void;
}

function createPipeGate(prefix = "exec-command-gate-"): PipeGate {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	const path = join(directory, "gate");
	execFileSync("mkfifo", [path]);
	let released = false;
	return {
		path,
		release() {
			if (released) return;
			released = true;
			writeFileSync(path, "release\n");
		},
		cleanup() {
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function gatedCommand(gate: PipeGate, command: string): string {
	return `cat ${shellQuote(gate.path)} >/dev/null; ${command}`;
}

function createExecSessionManager(options: ExecSessionManagerOptions = {}): ExecSessionManager {
	const manager = createBaseExecSessionManager({ ...options, minYieldTimeMs: 1 });
	return {
		...manager,
		exec: (input, cwd, signal, onUpdate) => {
			const fastInput = {
				...input,
				shell: input.shell ?? "/bin/sh",
				login: input.login ?? false,
			};
			return manager.exec(
				input.wait_for_exit || (input.yield_time_ms ?? 0) >= 1000
					? fastInput
					: { ...fastInput, yield_time_ms: FAST_TEST_YIELD_TIME_MS },
				cwd,
				signal,
				onUpdate,
			);
		},
		write: (input) =>
			manager.write(
				options.ptyBackend || (input.yield_time_ms ?? 0) >= 1000
					? input
					: { ...input, yield_time_ms: FAST_TEST_YIELD_TIME_MS },
			),
	};
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
			command: "tail -f /dev/null",
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
			command: "tail -f /dev/null",
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
		tracker.recordStart("call", "tail -f /dev/null");

		const state: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "tail -f /dev/null" }, testTheme, {
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

test("completed non-session exec calls leave rendering to result renderer", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "printf hello");

		const runningCall = tool.renderCall({ cmd: "printf hello" }, testTheme, {
			toolCallId: "call",
			isPartial: true,
			invalidate() {},
		});
		expect(runningCall).not.toBeInstanceOf(Container);

		tracker.recordEnd("call");
		const completedCall = tool.renderCall({ cmd: "printf hello" }, testTheme, {
			toolCallId: "call",
			isPartial: false,
			invalidate() {},
		});
		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "hello" }],
				details: { output: "hello", exit_code: 0 },
			},
			{ expanded: false, isPartial: false },
			testTheme,
			{ toolCallId: "call", args: { cmd: "printf hello" }, isPartial: false },
		);

		expect(completedCall).toBeInstanceOf(Container);
		expect(result).not.toBeInstanceOf(Container);
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
		tracker.recordStart("call", "tail -f /dev/null");

		const firstState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		const secondState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "tail -f /dev/null" }, testTheme, {
			toolCallId: "call",
			state: firstState,
			isPartial: true,
			invalidate() {},
		});
		tool.renderCall({ cmd: "tail -f /dev/null" }, testTheme, {
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
		tracker.recordStart("call", "tail -f /dev/null");

		const firstState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		const secondState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "tail -f /dev/null" }, testTheme, {
			state: firstState,
			isPartial: true,
			invalidate() {},
		});
		tool.renderCall({ cmd: "tail -f /dev/null" }, testTheme, {
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

test("extension bounds exec tool results tightly and other tool results loosely", () => {
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
	const boundedText = (toolName: string, text: string): string | undefined =>
		toolResultHandlers
			.map((handler) => handler({ toolName, content: [{ type: "text", text }], details: undefined, isError: false }))
			.find((result) => result?.content)?.content[0].text;

	// ~20k tokens: over the exec cap, under the fallback ceiling.
	const output = `${"x".repeat(200)}\n`.repeat(400);
	const execText = boundedText("exec_command", output);
	expect(execText).toStartWith("Total output lines: 400\n\n");
	expect(execText).toContain("truncated");
	expect(execText!.length).toBeLessThan(41_000);

	// The same payload from an unowned tool stays whole: the fallback is looser.
	expect(boundedText("read", output)).toBeUndefined();

	// ~200k tokens: even an unaudited tool hits the fallback floor.
	const hugeOutput = `${"x".repeat(200)}\n`.repeat(4_000);
	const readText = boundedText("read", hugeOutput);
	expect(readText).toContain("[output bounded");
	expect(readText!.length).toBeGreaterThan(41_000);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("shell card header reports the completed result token cost", () => {
	const lines = renderExecCellComponent(
		{
			kind: "command",
			status: "done",
			command: "printf hello",
			shell: "/bin/zsh",
			elapsedMs: 486,
			// A big terminal buffer paired with a small result: a backgrounded
			// command shows its whole transcript but only hands the model an
			// acknowledgement, and the card must report what the model received.
			outputBlock: { output: "x".repeat(4_000) },
			contextTokens: 1_000,
		},
		{ theme: testTheme },
	).render(200);

	expect(lines.join("\n")).toContain("<dim>completed · 486ms</dim><dim> · </dim><warning>1.0k tok</warning>");
});

test("shell card omits the token cost when the buffer never became a result", () => {
	const lines = renderExecCellComponent(
		{ kind: "command", status: "done", command: "printf hello", shell: "/bin/zsh", elapsedMs: 486 },
		{ theme: testTheme },
	).render(200);

	expect(lines.join("\n")).toContain("<dim>completed · 486ms</dim>");
	expect(lines.join("\n")).not.toContain("tok");
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
		const firstPromise = sessions.exec({ cmd: "true", name: "web", tty: true }, process.cwd());
		await Promise.resolve();
		await expect(sessions.exec({ cmd: "true", name: "web", tty: true }, process.cwd())).rejects.toThrow(
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

test("exec session manager can poll running sessions", async () => {
	const sessions = createExecSessionManager();
	const gate = createPipeGate();
	try {
		const first = await sessions.exec({ cmd: gatedCommand(gate, "printf done"), yield_time_ms: 250 }, process.cwd());
		expect(first.process_id).toBeNumber();
		gate.release();
		const next = await sessions.write({
			process_id: first.process_id!,
			chars: "",
			yield_time_ms: 5000,
		});
		expect(next.output).toContain("done");
		expect(next.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
		gate.cleanup();
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
