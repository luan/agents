import { expect, test } from "bun:test";
import type { TerminalBridgeClient } from "@luan.sh/pi-libtui";
import {
	createExecSessionManager,
	type ExecProcessSnapshot,
	type ExecSessionManager,
	type ExecSessionManagerOptions,
	type ExecSessionRuntime,
} from "../src/session-manager.ts";

function systemRuntime(): ExecSessionRuntime {
	return {
		now: Date.now,
		processId: (sessionId) => `test-${sessionId}`,
		resolveShell: (shell) => (!shell || shell.endsWith("fish") ? "/bin/sh" : shell),
		schedule: (delayMs, callback) => {
			const timer = setTimeout(callback, delayMs);
			return { dispose: () => clearTimeout(timer) };
		},
	};
}

function createManager(options: ExecSessionManagerOptions, runtime = systemRuntime()) {
	return createExecSessionManager(options, runtime);
}

class ManualRuntime implements ExecSessionRuntime {
	private time = 0;
	private readonly timers = new Set<{ at: number; callback: () => void }>();

	now = (): number => this.time;
	processId = (sessionId: number): string => `test-${sessionId}`;
	resolveShell = (shell?: string): string => (!shell || shell.endsWith("fish") ? "/bin/sh" : shell);
	schedule = (delayMs: number, callback: () => void): { dispose(): void } => {
		const timer = { at: this.time + delayMs, callback };
		this.timers.add(timer);
		return { dispose: () => this.timers.delete(timer) };
	};
	advance(durationMs: number): void {
		const target = this.time + durationMs;
		for (;;) {
			const next = [...this.timers].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			this.timers.delete(next);
			this.time = next.at;
			next.callback();
		}
		this.time = target;
	}
}

class ControlledBridge implements TerminalBridgeClient {
	readonly operations: string[] = [];
	readonly reaping = Promise.withResolvers<void>();
	readonly reap = Promise.withResolvers<{ removed: boolean }>();
	private sequence = 0;
	private read = Promise.withResolvers<{
		chunks: { seq: number; stream: "stdout"; chunk: string }[];
		nextSeq: number;
		exited: boolean;
		closed: boolean;
		exitCode?: number;
	}>();
	private reading = Promise.withResolvers<void>();

	async request<T>(request: Parameters<TerminalBridgeClient["request"]>[0]): Promise<T> {
		const op = String(request["op"]);
		this.operations.push(op);
		if (op === "read") {
			this.reading.resolve();
			return this.read.promise as Promise<T>;
		}
		if (op === "write") return { status: "accepted" } as T;
		if (op === "reap") {
			this.reaping.resolve();
			return this.reap.promise as Promise<T>;
		}
		return { running: true } as T;
	}

	async output(text: string): Promise<void> {
		await this.reading.promise;
		const pending = this.read;
		this.read = Promise.withResolvers();
		this.reading = Promise.withResolvers();
		this.sequence += 1;
		pending.resolve({
			chunks: [{ seq: this.sequence, stream: "stdout", chunk: Buffer.from(text).toString("base64") }],
			nextSeq: this.sequence + 1,
			exited: false,
			closed: false,
		});
		await this.reading.promise;
	}

	async finish(): Promise<void> {
		await this.reading.promise;
		this.read.resolve({ chunks: [], nextSeq: this.sequence + 1, exited: true, closed: true, exitCode: 0 });
		await this.reaping.promise;
	}

	async shutdown(): Promise<void> {}
}

async function exited(manager: ExecSessionManager, id: number): Promise<void> {
	const finished = Promise.withResolvers<void>();
	const unsubscribe = manager.subscribeProcesses?.((snapshots) => {
		if (snapshots.some((snapshot) => snapshot.id === id && snapshot.state === "exited")) finished.resolve();
	});
	await finished.promise;
	unsubscribe?.();
}

test("a session remains running until native reaping succeeds or fails", async () => {
	const runtime = new ManualRuntime();
	const bridge = new ControlledBridge();
	const manager = createManager({ bridge, maxExecYieldTimeMs: 1, minEmptyWriteYieldTimeMs: 250 }, runtime);
	const starting = manager.exec({ cmd: "short" }, "/tmp");
	await bridge.output("done");
	runtime.advance(1);
	await starting;
	await bridge.finish();
	const polling = manager.write({ session_id: 1, yield_time_ms: 250 });
	runtime.advance(250);
	expect((await polling).session_id).toBe(1);
	bridge.reap.resolve({ removed: false });
	await exited(manager, 1);
	const failed = await manager.write({ session_id: 1 });
	expect(failed.exit_code).toBe(1);
	expect(failed.output).toContain("native process was not reaped");
	await manager.shutdown();
});

test("completed unpolled processes obey replay retention and release active slots", async () => {
	const runtime = new ManualRuntime();
	let current = new ControlledBridge();
	const bridge: TerminalBridgeClient = {
		request: (request) => current.request(request),
		shutdown: async () => {},
	};
	const manager = createManager({ bridge, maxExecYieldTimeMs: 1 }, runtime);
	for (let id = 1; id <= 65; id += 1) {
		current = new ControlledBridge();
		const starting = manager.exec({ cmd: `short-${id}` }, "/tmp");
		await current.output(`output-${id}`);
		runtime.advance(1);
		expect((await starting).session_id).toBe(id);
		await current.finish();
		current.reap.resolve({ removed: true });
		await exited(manager, id);
	}
	expect(manager.listProcesses?.()).toHaveLength(32);
	await expect(manager.write({ session_id: 33 })).rejects.toThrow("Unknown session id 33");
	expect((await manager.write({ session_id: 34 })).output).toBe("output-34");
	await manager.shutdown();
});

test("polling includes output produced between calls without repeating delivered output", async () => {
	const runtime = new ManualRuntime();
	const bridge = new ControlledBridge();
	const manager = createManager({ bridge, maxExecYieldTimeMs: 1, minEmptyWriteYieldTimeMs: 250 }, runtime);
	const starting = manager.exec({ cmd: "stream" }, "/tmp");
	await bridge.output("first");
	runtime.advance(1);
	expect((await starting).output).toBe("first");

	await bridge.output("between");
	const polling = manager.write({ session_id: 1, yield_time_ms: 250 });
	await bridge.output("during");
	runtime.advance(250);
	expect((await polling).output).toBe("betweenduring");

	const emptyPoll = manager.write({ session_id: 1, yield_time_ms: 250 });
	runtime.advance(500);
	expect((await emptyPoll).output).toBe("");
	await manager.shutdown();
});

test.each(["", "input"])("aborting write_stdin with chars %j terminates its process", async (chars) => {
	const runtime = new ManualRuntime();
	const bridge = new ControlledBridge();
	const manager = createManager({ bridge, maxExecYieldTimeMs: 1 }, runtime);
	const starting = manager.exec({ cmd: "interactive", tty: true }, "/tmp");
	await bridge.output("ready");
	runtime.advance(1);
	await starting;
	const controller = new AbortController();
	const writing = manager.write({ session_id: 1, chars }, controller.signal);
	await Promise.resolve();
	controller.abort();
	await expect(writing).rejects.toThrow("write_stdin aborted");
	expect(bridge.operations).toContain("discard");
	await expect(manager.write({ session_id: 1 })).rejects.toThrow("Unknown session id 1");
	await manager.shutdown();
});

test("session output preserves UTF-8 characters split across bridge chunks", async () => {
	let reads = 0;
	const operations: unknown[] = [];
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			operations.push(request["op"]);
			if (request["op"] === "exec") return { processId: "test" } as T;
			if (request["op"] === "reap") return { removed: true } as T;
			reads += 1;
			if (reads === 1) {
				return {
					chunks: [{ seq: 1, stream: "stdout", chunk: Buffer.from([0xe2, 0x82]).toString("base64") }],
					nextSeq: 2,
					exited: false,
					closed: false,
				} as T;
			}
			return {
				chunks: [{ seq: 2, stream: "stdout", chunk: Buffer.from([0xac]).toString("base64") }],
				nextSeq: 3,
				exited: true,
				exitCode: 0,
				closed: true,
			} as T;
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge });
	const updates: string[] = [];
	const result = await manager.exec({ cmd: "unicode", shell: "/bin/sh", login: false }, "/tmp", undefined, (update) =>
		updates.push(update.output),
	);
	expect(result.output).toBe("€");
	expect(updates).toContain("€");
	expect(result.exit_code).toBe(0);
	expect(operations).toEqual(["exec", "read", "read", "reap"]);
	await manager.shutdown();
});

test("drains a closed native backlog before completing the session", async () => {
	let reads = 0;
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: "test" } as T;
			if (request["op"] === "reap") return { removed: true } as T;
			reads += 1;
			return {
				chunks: [
					{
						seq: reads,
						stream: "stdout",
						chunk: Buffer.from(reads === 1 ? "before-" : "tail").toString("base64"),
					},
				],
				nextSeq: reads + 1,
				more: reads === 1,
				exited: true,
				exitCode: 0,
				closed: true,
			} as T;
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge });

	const result = await manager.exec({ cmd: "backlog", shell: "/bin/sh", login: false }, "/tmp");

	expect(result.output).toBe("before-tail");
	expect(reads).toBe(2);
	await manager.shutdown();
});

test("publishes output when a process finishes before the waiter subscribes", async () => {
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: "test" } as T;
			if (request["op"] === "reap") return { removed: true } as T;
			return {
				chunks: [{ seq: 1, stream: "stdout", chunk: Buffer.from("done").toString("base64") }],
				nextSeq: 2,
				exited: true,
				exitCode: 0,
				closed: true,
			} as T;
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge });
	const updates: string[] = [];

	const result = await manager.exec({ cmd: "fast", shell: "/bin/sh", login: false }, "/tmp", undefined, (update) =>
		updates.push(update.output),
	);

	expect(updates).toEqual(["done"]);
	expect(result.output).toBe("done");
	await manager.shutdown();
});

test.each(["sequence gap", "read failure"])("discards native ownership after %s", async (failure) => {
	const operations: string[] = [];
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Parameters<TerminalBridgeClient["request"]>[0]): Promise<T> {
			operations.push(String(request["op"]));
			if (request["op"] === "exec") return { processId: "test" } as T;
			if (request["op"] === "discard") {
				if (failure === "read failure") throw new Error("bridge unavailable");
				return { removed: true } as T;
			}
			if (failure === "read failure") throw new Error("read failed");
			return {
				chunks: [{ seq: 2, stream: "stdout", chunk: Buffer.from("missing-prefix").toString("base64") }],
				nextSeq: 3,
				exited: false,
				closed: false,
			} as T;
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge });

	const result = await manager.exec({ cmd: "gap", shell: "/bin/sh", login: false }, "/tmp");

	expect(result.exit_code).toBe(1);
	expect(result.output).toContain(failure === "sequence gap" ? "invalid read result" : "read failed");
	expect(result.output).not.toContain("missing-prefix");
	expect(operations).toEqual(["exec", "read", "discard"]);
	await manager.shutdown();
});

test("a throwing progress observer cannot own session cleanup", async () => {
	let shutdown = false;
	let reads = 0;
	let updates = 0;
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: "test" } as T;
			if (request["op"] === "reap") return { removed: true } as T;
			reads += 1;
			await Promise.resolve();
			return {
				chunks: [{ seq: reads, stream: "stdout", chunk: Buffer.from("done").toString("base64") }],
				nextSeq: reads + 1,
				exited: true,
				exitCode: 0,
				closed: true,
			} as T;
		},
		async shutdown() {
			shutdown = true;
		},
	};
	const manager = createManager({ bridge });

	const result = await manager.exec({ cmd: "observer", shell: "/bin/sh", login: false }, "/tmp", undefined, () => {
		updates += 1;
		throw new Error("renderer failed");
	});
	expect(result.exit_code).toBe(0);
	expect(updates).toBe(1);
	await manager.shutdown();
	expect(shutdown).toBe(true);
});

test("a completed session can be polled again", async () => {
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: "test" } as T;
			if (request["op"] === "reap") return { removed: true } as T;
			return {
				chunks: [{ seq: 1, stream: "stdout", chunk: Buffer.from("done").toString("base64") }],
				nextSeq: 2,
				exited: true,
				exitCode: 0,
				closed: true,
			} as T;
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge });
	const first = await manager.exec({ cmd: "done", shell: "/bin/sh", login: false }, "/tmp");
	const replay = await manager.write({ session_id: 1 });
	expect(first.output).toBe("done");
	expect(replay.output).toBe("done");
	expect(replay.exit_code).toBe(0);
	await expect(manager.write({ session_id: 1, chars: "x" })).rejects.toThrow("already exited");
	await manager.shutdown();
});

test("configured defaults control shell mode and returned output", async () => {
	let execRequest: Record<string, unknown> | undefined;
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") {
				execRequest = request;
				return { processId: "test" } as T;
			}
			if (request["op"] === "reap") return { removed: true } as T;
			return {
				chunks: [{ seq: 1, stream: "stdout", chunk: Buffer.from("x".repeat(8_000)).toString("base64") }],
				nextSeq: 2,
				exited: true,
				exitCode: 0,
				closed: true,
			} as T;
		},
		async shutdown() {},
	};
	const manager = createManager({
		bridge,
		defaultLoginShell: false,
		defaultMaxOutputTokens: 1_000,
	});

	const result = await manager.exec({ cmd: "long-output", shell: "/bin/sh" }, "/tmp");

	expect(execRequest?.["argv"]).toEqual(["/bin/sh", "-c", "long-output"]);
	expect(result.output).toHaveLength(4_000);
	expect(result.original_token_count).toBe(2_000);
	expect(result.output_truncated).toBe(true);
	await manager.shutdown();
});

test("manager replaces a fish environment shell before spawning", async () => {
	let execRequest: Record<string, unknown> | undefined;
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") {
				execRequest = request;
				return { processId: "test" } as T;
			}
			if (request["op"] === "reap") return { removed: true } as T;
			return { chunks: [], nextSeq: 1, exited: true, exitCode: 0, closed: true } as T;
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge, env: { SHELL: "/opt/homebrew/bin/fish" } });

	await manager.exec({ cmd: "printf ok", login: false }, "/tmp");

	const argv = execRequest?.["argv"] as string[];
	expect(argv[0]).not.toEndWith("fish");
	expect(argv.slice(1)).toEqual(["-c", "printf ok"]);
	await manager.shutdown();
});

test("continuous output cannot extend execution past the hard wait limit", async () => {
	const runtime = new ManualRuntime();
	let sequence = 0;
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: "test" } as T;
			runtime.advance(25);
			sequence += 1;
			return {
				chunks: [{ seq: sequence, stream: "stdout", chunk: Buffer.from(".").toString("base64") }],
				nextSeq: sequence + 1,
				exited: false,
				closed: false,
			} as T;
		},
		async shutdown() {},
	};
	const sessionManager = createManager({ bridge, maxExecYieldTimeMs: 250 }, runtime);
	const result = await sessionManager.exec(
		{ cmd: "stream", shell: "/bin/sh", login: false, yield_time_ms: 250 },
		"/tmp",
	);
	expect(result.session_id).toBe(1);
	expect(result.wall_time_seconds).toBe(0.25);
	await sessionManager.shutdown();
});

test("completed replay evicts the oldest session after its fixed bound", async () => {
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: request["process_id"] } as T;
			if (request["op"] === "reap") return { removed: true } as T;
			return {
				chunks: [],
				nextSeq: 1,
				exited: true,
				exitCode: 0,
				closed: true,
			} as T;
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge });
	for (let index = 0; index < 33; index += 1) {
		await manager.exec({ cmd: `command-${index}`, shell: "/bin/sh", login: false }, "/tmp");
	}
	await expect(manager.write({ session_id: 1 })).rejects.toThrow("Unknown session id 1");
	expect((await manager.write({ session_id: 2 })).exit_code).toBe(0);
	await manager.shutdown();
});

test("failed process starts do not consume active session slots", async () => {
	const bridge: TerminalBridgeClient = {
		async request(): Promise<never> {
			throw new Error("spawn failed");
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge });
	for (let index = 0; index < 65; index += 1) {
		await expect(manager.exec({ cmd: `fail-${index}`, shell: "/bin/sh", login: false }, "/tmp")).rejects.toThrow(
			"spawn failed",
		);
	}
	await manager.shutdown();
});

test("an abort racing process creation terminates the spawned command", async () => {
	let releaseSpawn: (() => void) | undefined;
	let terminated = 0;
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") {
				await new Promise<void>((resolve) => {
					releaseSpawn = resolve;
				});
				return { processId: request["process_id"] } as T;
			}
			if (request["op"] === "discard") {
				terminated += 1;
				return { terminated: true } as T;
			}
			if (request["op"] === "reap") return { removed: true } as T;
			return { chunks: [], nextSeq: 1, exited: terminated > 0, closed: terminated > 0, exitCode: 143 } as T;
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge });
	const controller = new AbortController();
	const execution = manager.exec({ cmd: "sleep", shell: "/bin/sh", login: false }, "/tmp", controller.signal);
	await Promise.resolve();
	controller.abort();
	releaseSpawn?.();

	await expect(execution).rejects.toThrow();
	expect(terminated).toBe(1);
	await expect(manager.write({ session_id: 1 })).rejects.toThrow("Unknown session id 1");
	await manager.shutdown();
});

test("rejects a process after the active session limit", async () => {
	let stopped = false;
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: request["process_id"] } as T;
			if (request["op"] === "terminate") return { terminated: true } as T;
			return await new Promise<T>(() => undefined);
		},
		async shutdown() {
			stopped = true;
		},
	};
	const manager = createManager({ bridge, maxExecYieldTimeMs: 250 });
	const active = Array.from({ length: 64 }, (_, index) =>
		manager.exec({ cmd: `sleep-${index}`, shell: "/bin/sh", login: false, yield_time_ms: 250 }, "/tmp"),
	);

	await expect(manager.exec({ cmd: "one-too-many", shell: "/bin/sh", login: false }, "/tmp")).rejects.toThrow(
		"at most 64 active sessions",
	);
	await manager.shutdown();
	const settled = await Promise.allSettled(active);
	expect(settled.every((result) => result.status === "rejected")).toBe(true);
	expect(stopped).toBe(true);
});

test("shutdown rejects a pending execution instead of returning a phantom session", async () => {
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: request["process_id"] } as T;
			return await new Promise<T>(() => {});
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge, maxExecYieldTimeMs: 30_000 });
	const execution = manager.exec({ cmd: "sleep", shell: "/bin/sh", login: false }, "/tmp");
	await Promise.resolve();
	await manager.shutdown();
	await expect(execution).rejects.toThrow("shut down");
});

test("write aborts without waiting for a blocked native stdin request", async () => {
	const runtime = new ManualRuntime();
	const writeGate = Promise.withResolvers<{ status: string }>();
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: "test" } as T;
			if (request["op"] === "write") return writeGate.promise as Promise<T>;
			if (request["op"] === "discard") return { running: true } as T;
			return new Promise<T>(() => undefined);
		},
		async shutdown() {},
	};
	const sessionManager = createManager({ bridge, defaultExecYieldTimeMs: 1 }, runtime);
	const starting = sessionManager.exec({ cmd: "interactive", shell: "/bin/sh", login: false, tty: true }, "/tmp");
	await Promise.resolve();
	runtime.advance(250);
	const started = await starting;
	const controller = new AbortController();
	const writing = sessionManager.write({ session_id: started.session_id!, chars: "x" }, controller.signal);

	controller.abort();
	await expect(writing).rejects.toThrow("write_stdin aborted");
	writeGate.resolve({ status: "accepted" });
	await sessionManager.shutdown();
});

test("publishes bounded process snapshots and raw PTY data", async () => {
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: request["process_id"] } as T;
			if (request["op"] === "reap") return { removed: true } as T;
			return {
				chunks: [{ seq: 1, stream: "pty", chunk: Buffer.from("hello").toString("base64") }],
				nextSeq: 2,
				exited: true,
				exitCode: 0,
				closed: true,
			} as T;
		},
		async shutdown() {},
	};
	const manager = createManager({ bridge });
	const revisions: ReadonlyArray<ExecProcessSnapshot>[] = [];
	const ptyData: string[] = [];
	const unsubscribeProcesses = manager.subscribeProcesses?.((snapshots) => revisions.push(snapshots));
	const unsubscribePty = manager.onPtyData?.((event) => ptyData.push(event.data));

	await manager.exec({ cmd: "hello", shell: "/bin/sh", login: false, tty: true }, "/tmp");

	expect(ptyData).toEqual(["hello"]);
	expect(revisions.at(-1)).toEqual([
		expect.objectContaining({
			id: 1,
			command: "hello",
			cwd: "/tmp",
			tty: true,
			stdinOpen: false,
			state: "exited",
			exitCode: 0,
			output: "hello",
		}),
	]);
	unsubscribePty?.();
	unsubscribeProcesses?.();
	await manager.shutdown();
});

test("routes process controls through the native process identity", async () => {
	const runtime = new ManualRuntime();
	const requests: Record<string, unknown>[] = [];
	const bridge: TerminalBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			requests.push(request);
			if (request["op"] === "exec") return { processId: request["process_id"] } as T;
			if (request["op"] === "read") {
				return await new Promise<T>(() => undefined);
			}
			if (request["op"] === "write") return { status: "accepted" } as T;
			if (request["op"] === "resize") return { resized: true } as T;
			return { running: true } as T;
		},
		async shutdown() {},
	};
	const sessionManager = createManager({ bridge, maxExecYieldTimeMs: 1 }, runtime);
	const execution = sessionManager.exec(
		{ cmd: "interactive", shell: "/bin/sh", login: false, tty: true, yield_time_ms: 1 },
		"/tmp",
	);
	await Promise.resolve();
	runtime.advance(1);
	const result = await execution;
	expect(result.session_id).toBe(1);

	expect(await sessionManager.interrupt?.(1)).toBe(true);
	expect(await sessionManager.resize?.(1, 800, 400)).toBe(true);
	expect(await sessionManager.sendInput?.(1, "x")).toBe(true);
	expect(await sessionManager.terminate?.(1)).toBe(true);
	const nativeId = requests.find(({ op }) => op === "exec")?.["process_id"];
	expect(requests.filter(({ op }) => op !== "read").map(({ op, process_id }) => [op, process_id])).toEqual([
		["exec", nativeId],
		["interrupt", nativeId],
		["resize", nativeId],
		["write", nativeId],
		["terminate", nativeId],
	]);
	expect(requests.find(({ op }) => op === "resize")).toEqual(expect.objectContaining({ cols: 500, rows: 200 }));
	await sessionManager.shutdown();
});
