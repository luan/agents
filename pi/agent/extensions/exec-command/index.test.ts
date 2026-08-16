import { expect, test } from "bun:test";
import { Container } from "@earendil-works/pi-tui";
import type { PtyBackend, PtyProcess, PtySpawnOptions } from "./adapter/pty-backend.ts";
import execCommandExtensionBase, { createRtkCommandRewriter, type ExecCommandExtensionOptions } from "./index.ts";
import { type RenderTheme, rawCommandToExecCell, renderExecCellComponent } from "./tools/exec-cell-presentation.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import {
	createExecSessionManager as createBaseExecSessionManager,
	type ExecSessionManager,
	type ExecSessionManagerOptions,
} from "./tools/exec-session-manager.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";

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

test("rtk rewrites a command when rtk is installed", async () => {
	const execCalls: string[][] = [];
	const rewrite = createRtkCommandRewriter({
		exec: async (_command: string, args: string[]) => {
			execCalls.push(args);
			if (args[0] === "--version") return { code: 0, stdout: "rtk 0.23.0", stderr: "" };
			return { code: 0, stdout: "rtk git status", stderr: "" };
		},
	} as any);

	expect(await rewrite("git status")).toBe("rtk git status");
	expect(await rewrite("rtk git status")).toBeUndefined();
	expect(execCalls).toEqual([["--version"], ["rewrite", "git status"]]);
});

test("rtk leaves a command unchanged when rtk is unavailable", async () => {
	const execCalls: string[][] = [];
	const rewrite = createRtkCommandRewriter({
		exec: async (_command: string, args: string[]) => {
			execCalls.push(args);
			return { code: 1, stdout: "", stderr: "" };
		},
	} as any);

	expect(await rewrite("git status")).toBeUndefined();
	expect(execCalls).toEqual([["--version"]]);
});

/**
 * The rewrite used to run from `tool_call`, which a cell's `tools.exec_command(...)` never fires: the
 * cell ran the raw command and the capture recorded the executed command as the original.
 */
test("a cell's exec_command runs the rewrite and captures the model's own command", async () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const executed: string[] = [];
	const owners: string[] = [];
	let captured: any;
	const sessions = {
		exec: async (input: any) => {
			executed.push(input.cmd);
			owners.push(input.ownerSessionId);
			return { output: "", process_id: 9, terminal_state: "running", wall_time_seconds: 0.01 };
		},
		getSessionSnapshot: () => undefined,
		getSessionCommand: () => "rtk git status",
	} as any;
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions, {
			artifactCaptureEnabled: () => true,
			rewriteCommand: async (command) => (command === "git status" ? "rtk git status" : undefined),
			onResult: (_input, _result, _ctx, captureContext) => {
				captured = captureContext;
				return undefined;
			},
		});
		await tool.execute("cell-exec_command-3", { cmd: "git status" }, undefined, undefined, {
			cwd: "/tmp",
			sessionManager: { getSessionId: () => "capture-owner" },
		});

		expect(executed).toEqual(["rtk git status"]);
		expect(owners).toEqual(["capture-owner"]);
		expect(captured?.originalCommand).toBe("git status");
		expect(captured?.executedCommand).toBe("rtk git status");
		expect(captured?.ownerSessionId).toBe("capture-owner");
	} finally {
		tracker.clear();
	}
});

test("exec capture owner falls back to cwd without a session manager", async () => {
	let tool: any;
	let input: any;
	let captured: any;
	const tracker = createExecCommandTracker();
	const sessions = {
		exec: async (value: any) => {
			input = value;
			return { output: "", process_id: 9, terminal_state: "running", wall_time_seconds: 0.01 };
		},
		getSessionSnapshot: () => undefined,
		getSessionCommand: () => "printf hi",
	} as any;
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions, {
			artifactCaptureEnabled: () => true,
			onResult: (_input, _result, _ctx, captureContext) => {
				captured = captureContext;
				return undefined;
			},
		});
		await tool.execute("exec_command-owner-fallback", { cmd: "printf hi" }, undefined, undefined, { cwd: "/tmp" });
		expect(input.ownerSessionId).toBe("/tmp");
		expect(captured?.ownerSessionId).toBe("/tmp");
	} finally {
		tracker.clear();
	}
});

test("exec_command refuses timeout aliases before schema validation", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, {} as any);
		expect(() => tool.prepareArguments({ cmd: "sleep 1", timeout_ms: 1000 })).toThrow();
		expect(() => tool.prepareArguments({ cmd: "sleep 1", timeout: 1000 })).toThrow();
	} finally {
		tracker.clear();
	}
});

test("write_stdin schema accepts process names", () => {
	let tool: any;
	registerWriteStdinTool({ registerTool: (definition: any) => (tool = definition) } as any, {} as any);
	const processId = tool.parameters.properties.process_id;

	expect(processId.anyOf.map((schema: any) => schema.type)).toEqual(["number", "string"]);
});

/**
 * Escape used to read a set filled from `tool_execution_start`, so a long command a cell started could
 * not be interrupted at all.
 */
test("escape interrupts an exec_command a cell started", async () => {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	let tool: any;
	let terminalInput: ((data: string) => unknown) | undefined;
	let aborts = 0;
	let kills = 0;
	let exitListener = (_event: { exitCode: number }) => {};
	const notices: string[] = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: (event: any, ctx: any) => any) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtensionBase(pi, {
		...FAST_EXTENSION_OPTIONS,
		sessionManagerOptions: {
			...FAST_EXTENSION_OPTIONS.sessionManagerOptions,
			ptyBackend: {
				spawn: () => ({
					name: "test-pty",
					write() {},
					resize() {},
					kill() {
						kills++;
						exitListener({ exitCode: 0 });
					},
					onData() {},
					onExit(listener: (event: { exitCode: number }) => void) {
						exitListener = listener;
					},
				}),
			},
		},
	});
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		abort: () => aborts++,
		ui: {
			onTerminalInput: (handler: (data: string) => unknown) => {
				terminalInput = handler;
				return () => {
					terminalInput = undefined;
				};
			},
			notify: (message: string) => notices.push(message),
			setStatus() {},
		},
		sessionManager: { getSessionId: () => "session" },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({ reason: "new" }, ctx);

	try {
		const running = tool.execute(
			"cell-exec_command-4",
			{ cmd: "interactive", tty: true, yield_time_ms: 30_000 },
			undefined,
			undefined,
			ctx,
		);
		await Bun.sleep(10);
		expect(terminalInput?.("\u001b")).toEqual({ consume: true });
		expect(aborts).toBe(1);
		expect(notices).toEqual(["Interrupting foreground exec_command (1 killed)..."]);
		expect(kills).toBe(1);

		const result = await running;
		expect(result.details.terminal_state).toBe("cancelled");
		expect(terminalInput?.("\u001b")).toBeUndefined();
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
	}
});

function createExecSessionManager(options: ExecSessionManagerOptions = {}): ExecSessionManager {
	const manager = createBaseExecSessionManager({
		minEmptyWriteYieldTimeMs: FAST_TEST_YIELD_TIME_MS,
		...options,
		minYieldTimeMs: 1,
	});
	return {
		...manager,
		exec: (input, cwd, signal, onUpdate) => {
			const fastInput = {
				...input,
				shell: input.shell ?? "/bin/sh",
				login: input.login ?? false,
			};
			return manager.exec(
				(input.yield_time_ms ?? 0) >= 1000 ? fastInput : { ...fastInput, yield_time_ms: FAST_TEST_YIELD_TIME_MS },
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

test("exec_command tracks a call the agent loop never dispatched", async () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	// A cell's `tools.exec_command(...)` fires no `tool_execution_start`, so the entry
	// has to come from execute. Without it the live terminal card rendered empty.
	const sessions = {
		exec: async (_input: any, _cwd: string, _signal: any, onPartial: (partial: { output: string }) => void) => {
			onPartial({ output: "streaming" });
			return { output: "streaming", process_id: 7, terminal_state: "running", wall_time_seconds: 0.01 };
		},
		getSessionSnapshot: () => ({ running: true, output: "streaming", command: "tail -f log" }),
		getSessionCommand: () => "tail -f log",
	} as any;
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		await tool.execute("cell-exec_command-1", { cmd: "tail -f log" }, undefined, undefined, { cwd: "/tmp" });

		const info = tracker.getRenderInfo("cell-exec_command-1", "tail -f log");
		expect(info.sessionId).toBe(7);
		expect(info.output).toBe("streaming");

		const call = tool.renderCall({ cmd: "tail -f log" }, testTheme, {
			toolCallId: "cell-exec_command-1",
			isPartial: false,
			invalidate() {},
		});
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "streaming" }], details: { output: "streaming", process_id: 7 } },
			{ expanded: false, isPartial: false },
			testTheme,
			{ toolCallId: "cell-exec_command-1", args: { cmd: "tail -f log" }, isPartial: false },
		);

		expect(call).not.toBeInstanceOf(Container);
		expect(result).toBeInstanceOf(Container);
	} finally {
		tracker.clear();
	}
});

test("write_stdin output renders without repeating its own header row", () => {
	let tool: any;
	const sessions = {
		describe: () => ({ command: "python3", running: true, stdinOpen: true }),
		getSessionTty: () => false,
	} as any;
	registerWriteStdinTool({ registerTool: (definition: any) => (tool = definition) } as any, sessions);

	const lines = tool
		.renderResult(
			{ content: [{ type: "text", text: "42" }], details: { output: "42\n", stdin_open: false } },
			{ expanded: false, isPartial: false },
			testTheme,
			{ args: { process_id: 3, chars: "print(6*7)\n" }, isPartial: false },
		)
		.render(80)
		.join("\n");

	expect(stripAnsi(lines)).toContain("42");
	expect(stripAnsi(lines)).not.toContain("Waited for background terminal");
	expect(stripAnsi(lines)).not.toContain("#?");
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
		const first = await sessions.exec({ cmd: "fake command", tty: true, yield_time_ms: 250 }, process.cwd());
		expect(first.process_id).toBeNumber();
		expect(first.process_name).toBe("fake-pty");
		expect(spawnOptions?.cwd).toBe(process.cwd());
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
	} finally {
		sessions.shutdown();
	}
});

/**
 * The regression behind the write_stdin p99: a PTY delta is computed against the
 * last render, and trimming scrollback used to move the string it was compared
 * with. Every poll after the first overflow then returned the whole transcript,
 * clipped to the token ceiling, forever. Silent — the output looked plausible —
 * and expensive, which is what earns a test.
 */
test("write_stdin returns only new output after the pty transcript is trimmed", async () => {
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
		maxSessionBufferChars: 4_000,
	});
	try {
		const started = await sessions.exec({ cmd: "chatty", tty: true, yield_time_ms: 250 }, process.cwd());
		const poll = () => sessions.write({ process_id: started.process_id!, yield_time_ms: 1 });

		for (let line = 0; line < 300; line++) emitData(`overflow ${line} ${"b".repeat(50)}\n`);
		await poll();

		emitData("only this line\n");
		const afterTrim = await poll();
		expect(afterTrim.output).toBe("only this line\n");

		// A repainted line supersedes the repaint before it, so a spinner between
		// two polls costs one line rather than one line per frame.
		for (let frame = 0; frame < 200; frame++) emitData(`\rframe ${frame}`);
		const afterRepaints = await poll();
		expect(afterRepaints.output).toBe("\rframe 199");
	} finally {
		sessions.shutdown();
	}
});

test("write_stdin until matches only output produced after the call", async () => {
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
		emitData("ready\n");
		await sessions.write({ process_id: started.process_id!, chars: "", yield_time_ms: 1 });

		// "ready" is already in the transcript. A whole-history match would return
		// instantly and tell the model a prompt appeared that never did.
		const stale = await sessions.write({ process_id: started.process_id!, until: "ready", yield_time_ms: 20 });
		expect(stale.until_matched).toBe(false);

		const pending = sessions.write({ process_id: started.process_id!, until: "ready", yield_time_ms: 1_000 });
		emitData("ready\n");
		expect((await pending).until_matched).toBe(true);
	} finally {
		sessions.shutdown();
	}
});

test("exec_command holds through output gaps until the requested yield", async () => {
	let emitData: (data: string) => void = () => {};
	let emitExit: (event: { exitCode: number }) => void = () => {};
	const processHandle: PtyProcess = {
		write() {},
		resize() {},
		kill() {},
		onData: (listener) => {
			emitData = listener;
		},
		onExit: (listener) => {
			emitExit = listener;
		},
	};
	const sessions = createExecSessionManager({
		ptyBackend: { spawn: () => processHandle },
		defaultExecYieldTimeMs: 1_000,
		minYieldTimeMs: 5,
	});
	try {
		const pending = sessions.exec({ cmd: "producer", tty: true, yield_time_ms: 1_000 }, process.cwd());
		setTimeout(() => emitData("phase one\n"), 20);
		setTimeout(() => emitExit({ exitCode: 0 }), 350);
		const result = await pending;

		expect(result.output).toBe("phase one\n");
		expect(result.exit_code).toBe(0);
		expect(result.process_id).toBeUndefined();
	} finally {
		sessions.shutdown();
	}
});

test("write_stdin keeps a pure read attached until the process exits", async () => {
	let emitData: (data: string) => void = () => {};
	let emitExit: (event: { exitCode: number }) => void = () => {};
	const processHandle: PtyProcess = {
		write() {},
		resize() {},
		kill() {},
		onData: (listener) => {
			emitData = listener;
		},
		onExit: (listener) => {
			emitExit = listener;
		},
	};
	const sessions = createExecSessionManager({
		ptyBackend: { spawn: () => processHandle },
		defaultExecYieldTimeMs: 50,
		minEmptyWriteYieldTimeMs: 2_000,
		minYieldTimeMs: 5,
	});
	try {
		const started = await sessions.exec({ cmd: "producer", tty: true, yield_time_ms: 50 }, process.cwd());
		const pending = sessions.write({ process_id: started.process_id!, yield_time_ms: 10 });
		setTimeout(() => emitData("phase done\n"), 20);
		setTimeout(() => emitExit({ exitCode: 0 }), 350);
		const result = await pending;

		expect(result.output).toBe("phase done\n");
		expect(result.exit_code).toBe(0);
		expect(result.notice).toContain("clamped from 10ms to 2000ms");
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
