import { expect, test } from "bun:test";
import type { ExecBridgeClient } from "../src/bridge-client.ts";
import { createExecSessionManager, type ExecProcessSnapshot } from "../src/session-manager.ts";

test("session output preserves UTF-8 characters split across bridge chunks", async () => {
	let reads = 0;
	const operations: unknown[] = [];
	const bridge: ExecBridgeClient = {
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
	const manager = createExecSessionManager({ bridge });
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

test("a throwing progress observer cannot own session cleanup", async () => {
	let shutdown = false;
	let reads = 0;
	let updates = 0;
	const bridge: ExecBridgeClient = {
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
	const manager = createExecSessionManager({ bridge });

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
	const bridge: ExecBridgeClient = {
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
	const manager = createExecSessionManager({ bridge });
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
	const bridge: ExecBridgeClient = {
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
	const manager = createExecSessionManager({
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
	const bridge: ExecBridgeClient = {
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
	const manager = createExecSessionManager({ bridge, env: { SHELL: "/opt/homebrew/bin/fish" } });

	await manager.exec({ cmd: "printf ok", login: false }, "/tmp");

	const argv = execRequest?.["argv"] as string[];
	expect(argv[0]).not.toEndWith("fish");
	expect(argv.slice(1)).toEqual(["-c", "printf ok"]);
	await manager.shutdown();
});

test("continuous output cannot extend execution past the hard wait limit", async () => {
	let sequence = 0;
	const bridge: ExecBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: "test" } as T;
			await Bun.sleep(25);
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
	const manager = createExecSessionManager({ bridge, maxExecYieldTimeMs: 250 });
	const started = performance.now();
	const result = await manager.exec({ cmd: "stream", shell: "/bin/sh", login: false, yield_time_ms: 250 }, "/tmp");
	const elapsed = performance.now() - started;
	expect(result.session_id).toBe(1);
	expect(elapsed).toBeGreaterThanOrEqual(225);
	expect(elapsed).toBeLessThan(450);
	await manager.shutdown();
});

test("completed replay evicts the oldest session after its fixed bound", async () => {
	const bridge: ExecBridgeClient = {
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
	const manager = createExecSessionManager({ bridge });
	for (let index = 0; index < 33; index += 1) {
		await manager.exec({ cmd: `command-${index}`, shell: "/bin/sh", login: false }, "/tmp");
	}
	await expect(manager.write({ session_id: 1 })).rejects.toThrow("Unknown session id 1");
	expect((await manager.write({ session_id: 2 })).exit_code).toBe(0);
	await manager.shutdown();
});

test("failed process starts do not consume active session slots", async () => {
	const bridge: ExecBridgeClient = {
		async request(): Promise<never> {
			throw new Error("spawn failed");
		},
		async shutdown() {},
	};
	const manager = createExecSessionManager({ bridge });
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
	const bridge: ExecBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") {
				await new Promise<void>((resolve) => {
					releaseSpawn = resolve;
				});
				return { processId: request["process_id"] } as T;
			}
			if (request["op"] === "terminate") {
				terminated += 1;
				return { terminated: true } as T;
			}
			return { chunks: [], nextSeq: 1, exited: false, closed: false } as T;
		},
		async shutdown() {},
	};
	const manager = createExecSessionManager({ bridge });
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
	const bridge: ExecBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: request["process_id"] } as T;
			if (request["op"] === "terminate") return { terminated: true } as T;
			await Bun.sleep(1);
			return { chunks: [], nextSeq: 1, exited: false, closed: false } as T;
		},
		async shutdown() {
			stopped = true;
		},
	};
	const manager = createExecSessionManager({ bridge, maxExecYieldTimeMs: 250 });
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
	const bridge: ExecBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: request["process_id"] } as T;
			return await new Promise<T>(() => {});
		},
		async shutdown() {},
	};
	const manager = createExecSessionManager({ bridge, maxExecYieldTimeMs: 30_000 });
	const execution = manager.exec({ cmd: "sleep", shell: "/bin/sh", login: false }, "/tmp");
	await Promise.resolve();
	await manager.shutdown();
	await expect(execution).rejects.toThrow("shut down");
});

test("write aborts without waiting for a blocked native stdin request", async () => {
	const writeGate = Promise.withResolvers<{ status: string }>();
	const bridge: ExecBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			if (request["op"] === "exec") return { processId: "test" } as T;
			if (request["op"] === "write") return writeGate.promise as Promise<T>;
			return new Promise<T>(() => undefined);
		},
		async shutdown() {},
	};
	const manager = createExecSessionManager({ bridge, defaultExecYieldTimeMs: 1 });
	const started = await manager.exec({ cmd: "interactive", shell: "/bin/sh", login: false, tty: true }, "/tmp");
	const controller = new AbortController();
	const writing = manager.write({ session_id: started.session_id!, chars: "x" }, controller.signal);

	controller.abort();
	await expect(writing).rejects.toThrow("write_stdin aborted");
	writeGate.resolve({ status: "accepted" });
	await manager.shutdown();
});

test("publishes bounded process snapshots and raw PTY data", async () => {
	const bridge: ExecBridgeClient = {
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
	const manager = createExecSessionManager({ bridge });
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
	const requests: Record<string, unknown>[] = [];
	const bridge: ExecBridgeClient = {
		async request<T>(request: Record<string, unknown>): Promise<T> {
			requests.push(request);
			if (request["op"] === "exec") return { processId: request["process_id"] } as T;
			if (request["op"] === "read") {
				await Bun.sleep(5);
				return { chunks: [], nextSeq: 1, exited: false, closed: false } as T;
			}
			if (request["op"] === "write") return { status: "accepted" } as T;
			if (request["op"] === "resize") return { resized: true } as T;
			return { running: true } as T;
		},
		async shutdown() {},
	};
	const manager = createExecSessionManager({ bridge, maxExecYieldTimeMs: 1 });
	const result = await manager.exec(
		{ cmd: "interactive", shell: "/bin/sh", login: false, tty: true, yield_time_ms: 1 },
		"/tmp",
	);
	expect(result.session_id).toBe(1);

	expect(await manager.interrupt?.(1)).toBe(true);
	expect(await manager.resize?.(1, 800, 400)).toBe(true);
	expect(await manager.sendInput?.(1, "x")).toBe(true);
	expect(await manager.terminate?.(1)).toBe(true);
	const nativeId = requests.find(({ op }) => op === "exec")?.["process_id"];
	expect(requests.filter(({ op }) => op !== "read").map(({ op, process_id }) => [op, process_id])).toEqual([
		["exec", nativeId],
		["interrupt", nativeId],
		["resize", nativeId],
		["write", nativeId],
		["terminate", nativeId],
	]);
	expect(requests.find(({ op }) => op === "resize")).toEqual(expect.objectContaining({ cols: 500, rows: 200 }));
	await manager.shutdown();
});
