import { expect, test } from "bun:test";
import type { TerminalBridgeClient } from "../src/terminal/bridge-client.ts";
import { createPtyHost } from "../src/terminal/pty-host.ts";

test("owns PTY execution without a feature-extension provider", async () => {
	const requests: Record<string, unknown>[] = [];
	let finishRead: ((response: unknown) => void) | undefined;
	const bridge: TerminalBridgeClient = {
		request<T>(request: Record<string, unknown>): Promise<T> {
			requests.push(request);
			if (request.op === "read")
				return new Promise<T>((resolve) => {
					finishRead = resolve as (response: unknown) => void;
				});
			if (request.op === "write") return Promise.resolve({ status: "accepted" } as T);
			return Promise.resolve({} as T);
		},
		shutdown: async () => {},
	};
	const host = createPtyHost({
		bridge,
		createProcessId: () => "process-1",
		environment: { PATH: "/test/bin" },
	});
	const processId = await host.spawn({ command: "pi --tui-mode fullscreen", cwd: "/tmp/project" });

	expect(requests[0]).toMatchObject({
		op: "exec",
		process_id: processId,
		argv: ["/bin/sh", "-c", "pi --tui-mode fullscreen"],
		cwd: "/tmp/project",
		tty: true,
		pipe_stdin: true,
		env: { PATH: "/test/bin", TERM: "xterm-256color", COLORTERM: "truecolor" },
	});
	expect(requests.find((request) => request.op === "read")?.wait_ms).toBe(30_000);
	expect(await host.resize(processId, 120, 40)).toBe(true);
	expect(await host.resize(processId, 120, 40)).toBe(true);
	expect(await host.sendInput(processId, "hello")).toBe(true);
	expect(requests).toContainEqual({ op: "resize", process_id: processId, rows: 40, cols: 120 });
	expect(requests.filter((request) => request.op === "resize")).toHaveLength(1);
	expect(requests).toContainEqual({
		op: "write",
		process_id: processId,
		chunk: "hello",
	});

	const exited = new Promise<void>((resolve) => {
		const unsubscribe = host.subscribe(processId, () => {
			if (host.isRunning(processId)) return;
			unsubscribe();
			resolve();
		});
	});
	finishRead?.({ chunks: [], nextSeq: 1, exited: true, closed: true });
	await exited;
	expect(host.isRunning(processId)).toBe(false);
	await host.shutdown();
});

test("does not publish process completion before the projected tail is parsed", async () => {
	const reads: Array<(response: unknown) => void> = [];
	const bridge: TerminalBridgeClient = {
		request<T>(request: Record<string, unknown>): Promise<T> {
			if (request.op !== "read") return Promise.resolve({} as T);
			return new Promise<T>((resolve) => reads.push(resolve as (response: unknown) => void));
		},
		shutdown: async () => {},
	};
	const host = createPtyHost({ bridge, createProcessId: () => "process-1", environment: {} });
	const processId = await host.spawn({ command: "output", cwd: "/tmp" });
	reads.shift()?.({
		chunks: [{ seq: 1, stream: "pty", chunk: Buffer.from("prefix").toString("base64") }],
		nextSeq: 2,
		exited: false,
		closed: false,
	});
	await Bun.sleep(0);
	let completedTail: string | undefined;
	const completed = new Promise<void>((resolve) => {
		host.subscribe(processId, () => {
			if (host.isRunning(processId)) return;
			completedTail = host.render(processId, 24, false).join("\n");
			resolve();
		});
	});
	reads.shift()?.({
		chunks: [{ seq: 2, stream: "pty", chunk: Buffer.from("-FINAL-MARKER").toString("base64") }],
		nextSeq: 3,
		exited: true,
		closed: true,
	});
	await completed;

	expect(completedTail).toContain("FINAL-MARKER");
	await host.shutdown();
});

test("drains process closure before reaping an explicitly terminated PTY", async () => {
	let finishRead: ((response: unknown) => void) | undefined;
	const requests: Record<string, unknown>[] = [];
	const host = createPtyHost({
		bridge: {
			request<T>(request: Record<string, unknown>): Promise<T> {
				requests.push(request);
				if (request.op === "read")
					return new Promise<T>((resolve) => {
						finishRead = resolve as (response: unknown) => void;
					});
				return Promise.resolve({} as T);
			},
			shutdown: async () => {},
		},
		createProcessId: () => "process-1",
		environment: {},
	});
	const processId = await host.spawn({ command: "interactive", cwd: "/tmp" });
	const terminating = host.terminate(processId);
	await Promise.resolve();
	expect(requests.some((request) => request.op === "reap")).toBe(false);

	finishRead?.({ chunks: [], nextSeq: 1, exited: true, closed: true });
	expect(await terminating).toBe(true);
	expect(requests.map((request) => request.op)).toEqual(["exec", "read", "terminate", "reap"]);
	await host.shutdown();
});

test.each(["closed", "invalid", "failed"] as const)(
	"releases native ownership after a %s read and retains rendered output",
	async (outcome) => {
		const reads: Array<ReturnType<typeof Promise.withResolvers<object>>> = [];
		const requested = Promise.withResolvers<void>();
		const released = Promise.withResolvers<string>();
		const host = createPtyHost({
			bridge: {
				request<T>(request: Parameters<TerminalBridgeClient["request"]>[0]): Promise<T> {
					if (request.op === "read") {
						const read = Promise.withResolvers<object>();
						reads.push(read);
						if (reads.length === 2) requested.resolve();
						return read.promise as Promise<T>;
					}
					if (request.op === "discard" || request.op === "reap") released.resolve(request.op);
					return Promise.resolve({} as T);
				},
				shutdown: async () => {},
			},
			createProcessId: () => "process-1",
			environment: {},
		});
		try {
			const id = await host.spawn({ command: "output", cwd: "/tmp" });
			reads[0]!.resolve({
				chunks: [{ seq: 1, stream: "pty", chunk: Buffer.from("retained tail").toString("base64") }],
				nextSeq: 2,
				exited: false,
				closed: false,
			});
			await requested.promise;
			const completed = Promise.withResolvers<void>();
			host.subscribe(id, () => {
				if (!host.isRunning(id)) completed.resolve();
			});
			if (outcome === "failed") reads[1]!.reject(new Error("read failed"));
			else reads[1]!.resolve(outcome === "invalid" ? {} : { chunks: [], nextSeq: 2, exited: true, closed: true });
			await completed.promise;
			expect(host.render(id, 24, false).join("\n")).toContain("retained tail");
			// Completion must include release; do not wait indefinitely for a missing cleanup request.
			let release: string | undefined;
			void released.promise.then((op) => {
				release = op;
			});
			await Promise.resolve();
			expect(release).toBe(outcome === "closed" ? "reap" : "discard");
		} finally {
			await host.shutdown();
		}
	},
);

test("shutdown rejects a spawn whose native acknowledgement arrives late", async () => {
	const executed = Promise.withResolvers<object>();
	const host = createPtyHost({
		bridge: { request: <T>() => executed.promise as Promise<T>, shutdown: async () => {} },
		createProcessId: () => "late",
		environment: {},
	});
	const spawning = host.spawn({ command: "interactive", cwd: "/tmp" });
	await host.shutdown();
	executed.resolve({});
	await expect(spawning).rejects.toThrow("shut down");
	expect(host.isRunning("late")).toBe(false);
});
