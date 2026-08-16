import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { PtyBackend, PtyProcess, PtySpawnOptions } from "./pty-backend.ts";

const DEFAULT_HOST_PATH = fileURLToPath(new URL("../tools/node-pty-host.mjs", import.meta.url));
const FORCE_KILL_DELAY_MS = 500;

type HostEvent =
	| { type: "ready"; pid: number }
	| { type: "output"; data: string }
	| { type: "exit"; exitCode: number }
	| { type: "error"; message: string };

class IsolatedNodePtyProcess implements PtyProcess {
	readonly pid: number;
	readonly #host: ChildProcessWithoutNullStreams;
	readonly #forceKillDelayMs: number;
	readonly #dataListeners = new Set<(data: string) => void>();
	readonly #exitListeners = new Set<(event: { exitCode: number; sessionError?: string }) => void>();
	readonly #pendingData: string[] = [];
	#exitEvent: { exitCode: number; sessionError?: string } | undefined;
	#killTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(host: ChildProcessWithoutNullStreams, pid: number, forceKillDelayMs: number) {
		this.#host = host;
		this.pid = pid;
		this.#forceKillDelayMs = forceKillDelayMs;
	}

	write(data: string): void {
		this.#send({ type: "input", data });
	}

	resize(cols: number, rows: number): void {
		this.#send({ type: "resize", cols, rows });
	}

	kill(): void {
		if (this.#exitEvent) return;
		this.#send({ type: "terminate", signal: "SIGTERM" });
		this.#killTimer = setTimeout(() => {
			this.#send({ type: "terminate", signal: "SIGKILL" });
			setTimeout(() => {
				if (!this.#exitEvent) this.#forceKillHostTree();
			}, 50);
		}, this.#forceKillDelayMs);
	}

	onData(listener: (data: string) => void): void {
		this.#dataListeners.add(listener);
		for (const data of this.#pendingData.splice(0)) listener(data);
	}

	onExit(listener: (event: { exitCode: number; sessionError?: string }) => void): void {
		this.#exitListeners.add(listener);
		if (this.#exitEvent) queueMicrotask(() => listener(this.#exitEvent ?? { exitCode: 1 }));
	}

	receive(event: HostEvent): void {
		if (event.type === "output") this.#emitData(event.data);
		else if (event.type === "exit") this.#finish({ exitCode: event.exitCode });
		else if (event.type === "error") this.#finish({ exitCode: 1, sessionError: event.message });
	}

	hostExited(exitCode: number, stderr: string): void {
		if (this.#exitEvent) return;
		this.#finish({
			exitCode: exitCode === 0 ? 1 : exitCode,
			sessionError: stderr.trim() || "the isolated PTY host exited unexpectedly",
		});
	}

	protocolError(message: string): void {
		this.#finish({ exitCode: 1, sessionError: message });
		this.#host.kill("SIGKILL");
	}

	#send(message: unknown): void {
		if (this.#exitEvent || !this.#host.stdin.writable) return;
		this.#host.stdin.write(`${JSON.stringify(message)}\n`);
	}

	#emitData(data: string): void {
		if (this.#dataListeners.size === 0) this.#pendingData.push(data);
		else for (const listener of this.#dataListeners) listener(data);
	}

	#forceKillHostTree(): void {
		const hostPid = this.#host.pid;
		if (process.platform !== "win32" && hostPid !== undefined) {
			try {
				process.kill(-hostPid, "SIGKILL");
				return;
			} catch {}
		}
		this.#host.kill("SIGKILL");
	}

	#finish(event: { exitCode: number; sessionError?: string }): void {
		if (this.#exitEvent) return;
		this.#exitEvent = event;
		if (this.#killTimer) clearTimeout(this.#killTimer);
		for (const listener of this.#exitListeners) listener(event);
	}
}

export interface IsolatedNodePtyBackendOptions {
	hostPath?: string;
	forceKillDelayMs?: number;
	spawnHost?: (options: PtySpawnOptions) => ChildProcessWithoutNullStreams;
}

export function createIsolatedNodePtyBackend(options: IsolatedNodePtyBackendOptions = {}): PtyBackend {
	return {
		spawn(file, args, spawnOptions) {
			return new Promise<PtyProcess>((resolve, reject) => {
				const host = options.spawnHost
					? options.spawnHost(spawnOptions)
					: spawn("node", [options.hostPath ?? DEFAULT_HOST_PATH], {
							cwd: spawnOptions.cwd,
							env: spawnOptions.env,
							detached: true,
							stdio: ["pipe", "pipe", "pipe"],
						});
				let processHandle: IsolatedNodePtyProcess | undefined;
				let stderr = "";
				let settled = false;

				const failStartup = (message: string) => {
					if (settled) return;
					settled = true;
					reject(new Error(`cannot start this process: ${message}`));
				};

				createInterface({ input: host.stdout }).on("line", (line) => {
					if (line.length === 0) return;
					let event: HostEvent;
					try {
						event = JSON.parse(line) as HostEvent;
					} catch {
						const message = "the isolated PTY host sent malformed output";
						if (processHandle) processHandle.protocolError(message);
						else {
							failStartup(message);
							host.kill("SIGKILL");
						}
						return;
					}
					if (event.type === "ready") {
						processHandle = new IsolatedNodePtyProcess(
							host,
							event.pid,
							options.forceKillDelayMs ?? FORCE_KILL_DELAY_MS,
						);
						settled = true;
						resolve(processHandle);
					} else if (processHandle) {
						processHandle.receive(event);
					} else if (event.type === "error") {
						failStartup(event.message);
					}
				});
				host.stderr.setEncoding("utf8");
				host.stderr.on("data", (data: string) => (stderr += data));
				host.once("error", (error) => failStartup(error.message));
				host.once("close", (code) => {
					if (processHandle) processHandle.hostExited(code ?? 1, stderr);
					else failStartup(stderr.trim() || "the isolated PTY host exited before it was ready");
				});
				host.stdin.write(
					`${JSON.stringify({ type: "spawn", file, args, cwd: spawnOptions.cwd, env: spawnOptions.env, name: spawnOptions.name, cols: spawnOptions.cols, rows: spawnOptions.rows })}\n`,
				);
			});
		},
	};
}
