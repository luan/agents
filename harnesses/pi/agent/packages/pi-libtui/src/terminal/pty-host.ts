import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import {
	createTerminalBridgeClient,
	parseTerminalBridgeReadResponse,
	type TerminalBridgeClient,
	type TerminalBridgeReadResponse,
} from "./bridge-client.ts";
import { resolveTerminalBridgeBinary } from "./bridge-binary.ts";
import { normalizeTerminalDimensions, TerminalProjection } from "./projection.ts";

const PTY_HOST_KEY = Symbol.for("pi-libtui/pty-host/v2");
const PTY_HOST_PROTOCOL = "pi-libtui/pty-host/v2" as const;
const PTY_READ_IDLE_TIMEOUT_MS = 30_000;

export interface PtyHost {
	readonly protocol: typeof PTY_HOST_PROTOCOL;
	readonly version: 2;
	spawn(request: {
		readonly command: string;
		readonly cwd: string;
		readonly columns?: number;
		readonly rows?: number;
	}): Promise<string>;
	render(processId: string, rows: number, cursor: boolean): readonly string[];
	resize(processId: string, columns: number, rows: number): Promise<boolean>;
	sendInput(processId: string, data: string): Promise<boolean>;
	terminate(processId: string): Promise<boolean>;
	isRunning(processId: string): boolean;
	acceptsFocusEvents(processId: string): boolean;
	subscribe(processId: string, listener: () => void): () => void;
	shutdown(): Promise<void>;
}

export interface PtyHostDependencies {
	readonly bridge: TerminalBridgeClient;
	readonly createProcessId: () => string;
	readonly environment: Readonly<Record<string, string>>;
}

interface HostedProcess {
	readonly terminal: TerminalProjection;
	readonly listeners: Set<() => void>;
	nextSeq: number;
	running: boolean;
	polling?: Promise<void>;
	termination?: Promise<boolean>;
}

/** A process may exit before its PTY reader closes and drains the final bytes. */
function closesProcess(response: TerminalBridgeReadResponse): boolean {
	const failed = response.failure != null;
	return (response.closed || failed) && response.more !== true;
}

// type-boundary: Symbol.for capabilities can be populated by another installed pi-libtui copy; this validator narrows it once.
type UntrustedPtyHost = unknown;

function isPtyHost(value: UntrustedPtyHost): value is PtyHost {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PtyHost>;
	return (
		candidate.protocol === PTY_HOST_PROTOCOL &&
		candidate.version === 2 &&
		typeof candidate.spawn === "function" &&
		typeof candidate.render === "function" &&
		typeof candidate.resize === "function" &&
		typeof candidate.sendInput === "function" &&
		typeof candidate.terminate === "function" &&
		typeof candidate.isRunning === "function" &&
		typeof candidate.acceptsFocusEvents === "function" &&
		typeof candidate.subscribe === "function" &&
		typeof candidate.shutdown === "function"
	);
}

/** Lazily claim the process host shared by every installed pi-libtui copy. */
export function ensurePtyHost(scope: typeof globalThis = globalThis): PtyHost {
	const slots = scope as Record<PropertyKey, UntrustedPtyHost>;
	const existing = slots[PTY_HOST_KEY];
	if (isPtyHost(existing)) return existing;
	const host = createPtyHost({
		bridge: createTerminalBridgeClient({
			binaryPath: () =>
				resolveTerminalBridgeBinary({
					root: resolve(import.meta.dirname, "../../../../../../.."),
					binaryName: process.platform === "win32" ? "exec_command_bridge.exe" : "exec_command_bridge",
					override: process.env["PI_TERMINAL_BRIDGE_BINARY"] ?? process.env["PI_EXEC_COMMAND_BINARY"],
					isExecutable: (path) => {
						try {
							accessSync(path, constants.X_OK);
							return true;
						} catch {
							return false;
						}
					},
				}),
			spawnBridge: (binaryPath) => spawn(binaryPath, [], { stdio: "pipe", env: process.env }),
		}),
		createProcessId: () => `pi-libtui-${process.pid}-${randomUUID()}`,
		environment: stringEnvironment(process.env),
	});
	slots[PTY_HOST_KEY] = host;
	return host;
}

export async function shutdownPtyHost(scope: typeof globalThis = globalThis): Promise<void> {
	const slots = scope as Record<PropertyKey, UntrustedPtyHost>;
	const host = slots[PTY_HOST_KEY];
	if (!isPtyHost(host)) return;
	Reflect.deleteProperty(slots, PTY_HOST_KEY);
	await host.shutdown();
}

export function createPtyHost({ bridge, createProcessId, environment }: PtyHostDependencies): PtyHost {
	const processes = new Map<string, HostedProcess>();
	let stopped = false;
	let shutdownPromise: Promise<void> | undefined;

	const emit = (process: HostedProcess): void => {
		for (const listener of process.listeners) listener();
	};

	const poll = async (processId: string, process: HostedProcess): Promise<void> => {
		while (!stopped && process.running && processes.get(processId) === process) {
			let response: TerminalBridgeReadResponse;
			try {
				const result = await bridge.request<unknown>({
					op: "read",
					process_id: processId,
					after_seq: Math.max(0, process.nextSeq - 1),
					max_bytes: 1_048_576,
					// Native output and lifecycle changes wake this read. The timeout only
					// recovers a lost wake without generating steady idle bridge traffic.
					wait_ms: PTY_READ_IDLE_TIMEOUT_MS,
				});
				const parsed = parseTerminalBridgeReadResponse(result, process.nextSeq);
				if (!parsed) throw new Error("terminal bridge emitted an invalid read result");
				response = parsed;
			} catch {
				// A later bridge failure must not discard bytes accepted by an earlier read.
				await process.terminal.drain();
				process.running = false;
				if (!stopped) emit(process);
				return;
			}
			process.nextSeq = response.nextSeq;
			for (const chunk of response.chunks) {
				process.terminal.write(chunk.bytes);
			}
			if (process.running && closesProcess(response)) {
				// Do not expose terminal completion until every accepted byte is visible
				// to consumers; otherwise onExit can dispose a pane with a queued tail.
				await process.terminal.drain();
				process.running = false;
				if (!stopped && processes.get(processId) === process) emit(process);
			}
		}
	};

	return {
		protocol: PTY_HOST_PROTOCOL,
		version: 2,
		async spawn(request) {
			if (stopped) throw new Error("PTY host is shut down");
			const processId = createProcessId();
			const [columns, rows] = normalizeTerminalDimensions(request.columns ?? 80, request.rows ?? 24);
			const listeners = new Set<() => void>();
			const hosted: HostedProcess = {
				terminal: new TerminalProjection({
					requestRender: () => emit(hosted),
					cols: columns,
					rows,
					repaintIntervalMs: 0,
					scrollback: 0,
				}),
				listeners,
				nextSeq: 1,
				running: true,
			};
			processes.set(processId, hosted);
			try {
				await bridge.request({
					op: "exec",
					process_id: processId,
					argv: ["/bin/sh", "-c", request.command],
					cwd: request.cwd,
					env: { ...environment, TERM: "xterm-256color", COLORTERM: "truecolor" },
					tty: true,
					pipe_stdin: true,
					arg0: null,
					rows,
					cols: columns,
				});
			} catch (error) {
				processes.delete(processId);
				hosted.terminal.dispose();
				throw error;
			}
			hosted.polling = poll(processId, hosted);
			return processId;
		},
		render(processId, rows, cursor) {
			return processes.get(processId)?.terminal.renderLines({ maxRows: rows, cursor }) ?? [];
		},
		async resize(processId, columns, rows) {
			const process = processes.get(processId);
			if (!process?.running) return false;
			[columns, rows] = normalizeTerminalDimensions(columns, rows);
			if (process.terminal.cols === columns && process.terminal.rows === rows) return true;
			await bridge.request({ op: "resize", process_id: processId, rows, cols: columns });
			process.terminal.resize(columns, rows);
			return true;
		},
		async sendInput(processId, data) {
			const process = processes.get(processId);
			if (!process?.running) return false;
			const response = await bridge.request<{ status: string }>({
				op: "write",
				process_id: processId,
				chunk: data,
			});
			return response.status === "accepted";
		},
		terminate(processId) {
			const process = processes.get(processId);
			if (!process) return Promise.resolve(false);
			if (process.termination) return process.termination;
			process.termination = (async () => {
				const terminated = await bridge
					.request({ op: "terminate", process_id: processId })
					.then(() => true)
					.catch(() => false);
				// Keep the poll alive through termination so it can drain the PTY tail and
				// observe closure before the native process entry is reaped.
				if (terminated) await process.polling;
				process.running = false;
				await bridge.request({ op: "reap", process_id: processId }).catch(() => undefined);
				if (processes.get(processId) === process) {
					processes.delete(processId);
					process.terminal.dispose();
					emit(process);
					process.listeners.clear();
				}
				return terminated;
			})();
			return process.termination;
		},
		isRunning: (processId) => processes.get(processId)?.running ?? false,
		acceptsFocusEvents: (processId) => processes.get(processId)?.terminal.acceptsFocusEvents ?? false,
		subscribe(processId, listener) {
			const listeners = processes.get(processId)?.listeners;
			if (!listeners) return () => {};
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		shutdown() {
			if (shutdownPromise) return shutdownPromise;
			stopped = true;
			for (const process of processes.values()) {
				process.running = false;
				process.terminal.dispose();
				process.listeners.clear();
			}
			processes.clear();
			shutdownPromise = bridge.shutdown();
			return shutdownPromise;
		},
	};
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}
