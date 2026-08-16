import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PtyBackend, PtyProcess } from "../adapter/pty-backend.ts";
import { createExecSessionManager, type ExecSessionManager } from "./exec-session-manager.ts";

interface FakePty {
	backend: PtyBackend;
	emitData(data: string): void;
	emitExit(exitCode?: number, sessionError?: string): void;
	writes: string[];
	killCount: number;
}

function createFakePty(): FakePty {
	const dataListeners = new Set<(data: string) => void>();
	const exitListeners = new Set<(event: { exitCode: number; sessionError?: string }) => void>();
	const writes: string[] = [];
	const fake = {
		backend: undefined as unknown as PtyBackend,
		emitData: (data: string) => {
			for (const listener of dataListeners) listener(data);
		},
		emitExit: (exitCode = 0, sessionError?: string) => {
			for (const listener of exitListeners) listener({ exitCode, sessionError });
		},
		writes,
		killCount: 0,
	};
	const processHandle: PtyProcess = {
		name: "fake-pty",
		write: (data) => {
			writes.push(data);
		},
		resize() {},
		kill: () => {
			fake.killCount++;
			fake.emitExit();
		},
		onData: (listener) => dataListeners.add(listener),
		onExit: (listener) => exitListeners.add(listener),
	};
	fake.backend = { spawn: () => processHandle };
	return fake;
}

function createAutoExitPtyBackend(): PtyBackend {
	return {
		spawn: () => {
			let exited = false;
			let exit: ((event: { exitCode: number }) => void) | undefined;
			queueMicrotask(() => {
				exited = true;
				exit?.({ exitCode: 0 });
			});
			return {
				write() {},
				resize() {},
				kill() {},
				onData() {},
				onExit: (listener) => {
					exit = listener;
					if (exited) queueMicrotask(() => exit?.({ exitCode: 0 }));
				},
			};
		},
	};
}

const managers: ExecSessionManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.shutdown();
});

describe("ExecSessionManager process runtime", () => {
	test("publishes immediate process snapshots and raw PTY data", async () => {
		const pty = createFakePty();
		const manager = createExecSessionManager({
			ptyBackend: pty.backend,
			defaultExecYieldTimeMs: 5,
			minYieldTimeMs: 1,
		});
		managers.push(manager);

		const processUpdates: unknown[][] = [];
		const rawEvents: Array<{ processId: number; data: string }> = [];
		manager.subscribeProcesses((snapshots) => processUpdates.push(snapshots));
		manager.onPtyData((event) => rawEvents.push(event));

		const started = await manager.exec(
			{ cmd: "interactive", tty: true, ownerSessionId: "session-1", yield_time_ms: 5 },
			process.cwd(),
		);
		const raw = "\u001b[31mred\u001b[0m\rblue\n";
		pty.emitData(raw);

		expect(processUpdates[0]).toEqual([]);
		const snapshot = processUpdates.at(-1)?.[0] as Record<string, unknown>;
		expect(snapshot).toMatchObject({
			id: started.process_id,
			name: "fake-pty",
			command: "interactive",
			cwd: process.cwd(),
			ownerSessionId: "session-1",
			tty: true,
			stdinOpen: true,
			state: "running",
		});
		expect(String(snapshot.output)).toContain("blue");
		expect(rawEvents).toEqual([{ processId: started.process_id!, data: raw }]);
	});

	test("retains a bounded process snapshot after the final drain", async () => {
		const pty = createFakePty();
		const manager = createExecSessionManager({
			ptyBackend: pty.backend,
			defaultExecYieldTimeMs: 5,
			minYieldTimeMs: 1,
		});
		managers.push(manager);
		const updates: Array<Array<Record<string, unknown>>> = [];
		manager.subscribeProcesses((snapshots) => updates.push(snapshots as Array<Record<string, unknown>>));
		const started = await manager.exec({ cmd: "finished", tty: true, yield_time_ms: 5 }, process.cwd());
		pty.emitData("final output\n");
		pty.emitExit(7);

		await manager.write({ process_id: started.process_id!, yield_time_ms: 5 });

		expect(updates.at(-1)?.[0]).toMatchObject({
			id: started.process_id,
			state: "exited",
			exitCode: 7,
			output: "final output\n",
		});
	});

	test("keeps undrained terminal output when another process starts", async () => {
		const pty = createFakePty();
		const manager = createExecSessionManager({
			ptyBackend: pty.backend,
			defaultExecYieldTimeMs: 5,
			minYieldTimeMs: 1,
		});
		managers.push(manager);
		const first = await manager.exec({ cmd: "first", tty: true, yield_time_ms: 5 }, process.cwd());
		pty.emitData("pending output\n");
		pty.emitExit();

		await manager.exec({ cmd: "second", tty: true, yield_time_ms: 0 }, process.cwd());
		const drained = await manager.write({ process_id: first.process_id!, yield_time_ms: 0 });

		expect(drained.output).toContain("pending output");
		expect(drained.terminal_state).toBe("exited");
	});

	test("bounds completed process snapshots and clears them on shutdown", async () => {
		const manager = createExecSessionManager({
			ptyBackend: createAutoExitPtyBackend(),
			defaultExecYieldTimeMs: 1,
			minYieldTimeMs: 1,
		});
		managers.push(manager);
		let snapshots: Array<{ id: number }> = [];
		manager.subscribeProcesses((next) => {
			snapshots = next;
		});

		for (let id = 1; id <= 257; id++) {
			await manager.exec({ cmd: String(id), tty: true, yield_time_ms: 1 }, process.cwd());
		}

		expect(snapshots).toHaveLength(256);
		expect(snapshots[0]?.id).toBe(2);
		expect(snapshots.at(-1)?.id).toBe(257);
		manager.shutdown();
		expect(snapshots).toEqual([]);
	});
	test("interrupt writes Ctrl+C to a TTY and termination stays adapter-owned", async () => {
		const pty = createFakePty();
		const manager = createExecSessionManager({
			ptyBackend: pty.backend,
			defaultExecYieldTimeMs: 5,
			minYieldTimeMs: 1,
		});
		managers.push(manager);
		const started = await manager.exec({ cmd: "interactive", tty: true, yield_time_ms: 5 }, process.cwd());

		expect(await manager.interrupt(started.process_id!)).toBe(true);
		expect(pty.writes).toEqual(["\u0003"]);
		expect(manager.stopSession(started.process_id!)).toBe(true);
		expect(pty.killCount).toBe(1);
	});

	test("interrupt sends SIGINT to a non-TTY process", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-exec-interrupt-"));
		const marker = join(directory, "interrupted");
		const manager = createExecSessionManager({ defaultExecYieldTimeMs: 200, minYieldTimeMs: 1 });
		managers.push(manager);
		try {
			const started = await manager.exec(
				{
					cmd: `node -e 'const fs=require("node:fs"); process.on("SIGINT",()=>{fs.writeFileSync("${marker}","interrupted"); process.exit(0)}); setInterval(()=>{},1000)'`,
					yield_time_ms: 200,
				},
				process.cwd(),
			);

			expect(await manager.interrupt(started.process_id!)).toBe(true);
			await manager.write({ process_id: started.process_id!, yield_time_ms: 2_000 });
			expect(await readFile(marker, "utf8")).toBe("interrupted");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("maps an isolated host failure to a session error", async () => {
		const pty = createFakePty();
		const manager = createExecSessionManager({
			ptyBackend: pty.backend,
			defaultExecYieldTimeMs: 5,
			minYieldTimeMs: 1,
		});
		managers.push(manager);
		const started = await manager.exec({ cmd: "interactive", tty: true, yield_time_ms: 5 }, process.cwd());

		pty.emitExit(9, "the isolated PTY host exited unexpectedly");
		const result = await manager.write({ process_id: started.process_id!, yield_time_ms: 5 });

		expect(result.terminal_state).toBe("session_error");
		expect(result.session_error).toBe("the isolated PTY host exited unexpectedly");
		expect(result.exit_code).toBeUndefined();
	});
});
