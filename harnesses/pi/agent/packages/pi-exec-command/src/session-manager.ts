import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type BridgeReadResponse, createExecBridgeClient, type ExecBridgeClient } from "./bridge-client.ts";
import {
	appendBounded,
	chunkId,
	OutputNormalizer,
	outputEnd,
	outputTail,
	peekOutput,
	takeOutput,
	truncateOutput,
} from "./output.ts";
import { resolveRuntimeShell } from "./runtime-shell.ts";

export interface UnifiedExecResult {
	chunk_id: string;
	wall_time_seconds: number;
	output: string;
	exit_code?: number;
	session_id?: number;
	original_token_count?: number;
	output_truncated: boolean;
}

export interface ExecCommandInput {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	yield_time_ms?: number;
	max_output_tokens?: number;
	login?: boolean;
}

export interface WriteStdinInput {
	session_id: number;
	chars?: string;
	yield_time_ms?: number;
	max_output_tokens?: number;
}

export interface ExecProcessSnapshot {
	readonly id: number;
	readonly command: string;
	readonly cwd: string;
	readonly shell: string;
	readonly tty: boolean;
	readonly stdinOpen: boolean;
	readonly state: "running" | "exited";
	readonly exitCode?: number;
	readonly startedAtMs: number;
	readonly finishedAtMs?: number;
	readonly output: string;
	readonly outputTruncated: boolean;
}

export interface PtyDataEvent {
	readonly processId: number;
	readonly data: string;
}

export interface ExecSessionManager {
	exec(
		input: ExecCommandInput,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (result: UnifiedExecResult) => void,
	): Promise<UnifiedExecResult>;
	write(
		input: WriteStdinInput,
		signal?: AbortSignal,
		onUpdate?: (result: UnifiedExecResult) => void,
	): Promise<UnifiedExecResult>;
	getSessionCommand(sessionId: number): string | undefined;
	getSessionTty?(sessionId: number): boolean | undefined;
	listProcesses?(): readonly ExecProcessSnapshot[];
	subscribeProcesses?(listener: (snapshots: readonly ExecProcessSnapshot[]) => void): () => void;
	onPtyData?(listener: (event: PtyDataEvent) => void): () => void;
	interrupt?(sessionId: number): Promise<boolean>;
	terminate?(sessionId: number): Promise<boolean>;
	resize?(sessionId: number, cols: number, rows: number): Promise<boolean>;
	sendInput?(sessionId: number, chars: string): Promise<boolean>;
	shutdown(): Promise<void>;
}

interface Session {
	id: number;
	processId: string;
	command: string;
	cwd: string;
	shell: string;
	tty: boolean;
	startedAtMs: number;
	finishedAtMs?: number;
	/** Random-access transport window for write_stdin baselines and replay; UI retention belongs to pi-libtui. */
	bufferChunks: string[];
	bufferFirstChunk: number;
	bufferLength: number;
	bufferStartOffset: number;
	emittedOffset: number;
	exitCode?: number;
	observedExitCode?: number;
	closed: boolean;
	lastSeq: number;
	version: number;
	waiters: Set<() => void>;
	decoders: Record<"stdout" | "stderr" | "pty", StringDecoder>;
	normalizers: Record<"stdout" | "stderr" | "pty", OutputNormalizer>;
	decodersFlushed: boolean;
	nextEmptyPollYieldMs?: number;
}

interface CompletedSession {
	command: string;
	tty: boolean;
	result: UnifiedExecResult;
	snapshot: ExecProcessSnapshot;
}

export interface ExecSessionManagerOptions {
	bridge?: ExecBridgeClient;
	binaryPath?: () => string;
	env?: NodeJS.ProcessEnv;
	maxSessionBufferChars?: number;
	maxExecYieldTimeMs?: number;
	minEmptyWriteYieldTimeMs?: number;
	maxEmptyWriteYieldTimeMs?: number;
	defaultExecYieldTimeMs?: number;
	defaultMaxOutputTokens?: number;
	defaultLoginShell?: boolean;
}

const DEFAULT_SESSION_BUFFER_CHARS = 8 * 1024 * 1024;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const DEFAULT_EMPTY_WRITE_YIELD_MS = 30_000;
const MIN_YIELD_MS = 250;
const MAX_EXEC_YIELD_MS = 30_000;
const MAX_EMPTY_WRITE_YIELD_MS = 300_000;
const MAX_COMPLETED_SESSIONS = 32;
const MAX_COMPLETED_OUTPUT_CHARS = 64 * 1024;
const MAX_ACTIVE_SESSIONS = 64;
const MAX_PROCESS_SNAPSHOT_OUTPUT_CHARS = 512 * 1024;
const MAX_PROCESS_COLS = 500;
const MAX_PROCESS_ROWS = 200;

function clamp(value: number | undefined, fallback: number, maximum: number): number {
	const minimum = Math.min(MIN_YIELD_MS, maximum);
	return Math.min(maximum, Math.max(minimum, value ?? fallback));
}

function shellArgs(command: string, login: boolean, shell: string): string[] {
	const shellName = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	if (shellName === "cmd" || shellName === "cmd.exe") return ["/d", "/s", "/c", command];
	if (
		shellName === "powershell" ||
		shellName === "powershell.exe" ||
		shellName === "pwsh" ||
		shellName === "pwsh.exe"
	) {
		return ["-NoLogo", "-NoProfile", "-Command", command];
	}
	return [login ? "-lc" : "-c", command];
}

function resultFor(session: Session, elapsedMs: number, maxOutputTokens?: number): UnifiedExecResult {
	const output = takeOutput(session, maxOutputTokens);
	return {
		chunk_id: chunkId(),
		wall_time_seconds: elapsedMs / 1000,
		...output,
		...(session.exitCode === undefined ? { session_id: session.id } : { exit_code: session.exitCode }),
	};
}

function abortError(tool: string): Error {
	return new Error(`${tool} aborted`);
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, tool: string): Promise<T> {
	if (!signal) return operation;
	return new Promise<T>((resolvePromise, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(abortError(tool));
		};
		operation.then(
			(value) => {
				cleanup();
				resolvePromise(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function publishUpdate(onUpdate: ((result: UnifiedExecResult) => void) | undefined, result: UnifiedExecResult): void {
	try {
		onUpdate?.(result);
	} catch {
		// Presentation callbacks are observers and cannot own process lifecycle.
	}
}

export function createExecSessionManager(options: ExecSessionManagerOptions = {}): ExecSessionManager {
	const bridge =
		options.bridge ??
		createExecBridgeClient(
			options.binaryPath ??
				(() => {
					throw new Error("exec_command bridge path was not configured");
				}),
		);
	const env = { ...(options.env ?? process.env) };
	const maxSessionBufferChars = Math.max(1024, options.maxSessionBufferChars ?? DEFAULT_SESSION_BUFFER_CHARS);
	const maxExecYieldTimeMs = Math.min(MAX_EXEC_YIELD_MS, Math.max(1, options.maxExecYieldTimeMs ?? MAX_EXEC_YIELD_MS));
	const pollWaitMs = Math.min(250, maxExecYieldTimeMs);
	const minEmptyWriteYieldTimeMs = Math.max(
		MIN_YIELD_MS,
		options.minEmptyWriteYieldTimeMs ?? DEFAULT_EMPTY_WRITE_YIELD_MS,
	);
	const maxEmptyWriteYieldTimeMs = Math.max(
		minEmptyWriteYieldTimeMs,
		options.maxEmptyWriteYieldTimeMs ?? MAX_EMPTY_WRITE_YIELD_MS,
	);
	const defaultExecYieldTimeMs = Math.min(
		maxExecYieldTimeMs,
		Math.max(MIN_YIELD_MS, options.defaultExecYieldTimeMs ?? DEFAULT_EXEC_YIELD_MS),
	);
	const defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 10_000;
	const defaultLoginShell = options.defaultLoginShell ?? true;
	const sessions = new Map<number, Session>();
	const commands = new Map<number, string>();
	const completed = new Map<number, CompletedSession>();
	const processListeners = new Set<(snapshots: readonly ExecProcessSnapshot[]) => void>();
	const ptyListeners = new Set<(event: PtyDataEvent) => void>();
	let nextSessionId = 1;
	let stopped = false;

	function activeSnapshot(session: Session): ExecProcessSnapshot {
		const output = outputTail(session, MAX_PROCESS_SNAPSHOT_OUTPUT_CHARS);
		return Object.freeze({
			id: session.id,
			command: session.command,
			cwd: session.cwd,
			shell: session.shell,
			tty: session.tty,
			stdinOpen: session.tty && session.exitCode === undefined,
			state: session.exitCode === undefined ? "running" : "exited",
			...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
			startedAtMs: session.startedAtMs,
			...(session.finishedAtMs === undefined ? {} : { finishedAtMs: session.finishedAtMs }),
			output,
			outputTruncated: outputEnd(session) > output.length,
		});
	}

	function listProcesses(): readonly ExecProcessSnapshot[] {
		return Object.freeze(
			[...[...completed.values()].map(({ snapshot }) => snapshot), ...[...sessions.values()].map(activeSnapshot)].sort(
				(left, right) => left.id - right.id,
			),
		);
	}

	function emitProcesses(): void {
		const snapshots = listProcesses();
		for (const listener of [...processListeners]) {
			try {
				listener(snapshots);
			} catch {
				// Presentation observers cannot own process lifecycle.
			}
		}
	}

	function emitPtyData(event: PtyDataEvent): void {
		for (const listener of [...ptyListeners]) {
			try {
				listener(event);
			} catch {
				// Presentation observers cannot own process lifecycle.
			}
		}
	}

	function rememberCommand(id: number, command: string): void {
		commands.set(id, command);
		if (commands.size <= 256) return;
		const oldest = commands.keys().next().value;
		if (oldest !== undefined) commands.delete(oldest);
	}

	function rememberCompleted(session: Session, elapsedMs: number): void {
		const originalChars = outputEnd(session);
		const output = outputTail(session, MAX_COMPLETED_OUTPUT_CHARS);
		const result: UnifiedExecResult = {
			chunk_id: chunkId(),
			wall_time_seconds: elapsedMs / 1000,
			...truncateOutput(output, MAX_COMPLETED_OUTPUT_CHARS / 4, originalChars),
			exit_code: session.exitCode ?? 1,
		};
		completed.set(session.id, {
			command: session.command,
			tty: session.tty,
			result,
			snapshot: Object.freeze({
				...activeSnapshot(session),
				state: "exited",
				stdinOpen: false,
				exitCode: result.exit_code ?? 1,
				output: result.output,
				outputTruncated: result.output_truncated,
			}),
		});
		if (completed.size <= MAX_COMPLETED_SESSIONS) return;
		const oldest = completed.keys().next().value;
		if (oldest !== undefined) completed.delete(oldest);
	}

	function replayCompleted(entry: CompletedSession, maxOutputTokens?: number): UnifiedExecResult {
		const originalChars = (entry.result.original_token_count ?? Math.ceil(entry.result.output.length / 4)) * 4;
		return {
			...entry.result,
			...truncateOutput(entry.result.output, maxOutputTokens, originalChars),
		};
	}

	function wake(session: Session): void {
		session.version += 1;
		for (const waiter of session.waiters) waiter();
	}

	async function pollLoop(session: Session): Promise<void> {
		while (!stopped && !session.closed) {
			let response: BridgeReadResponse;
			try {
				response = await bridge.request<BridgeReadResponse>({
					op: "read",
					process_id: session.processId,
					after_seq: session.lastSeq,
					wait_ms: pollWaitMs,
				});
			} catch (error) {
				appendBounded(session, `${error instanceof Error ? error.message : String(error)}\n`, maxSessionBufferChars);
				session.exitCode = 1;
				session.finishedAtMs ??= Date.now();
				session.closed = true;
				wake(session);
				emitProcesses();
				return;
			}
			for (const chunk of response.chunks) {
				const text = session.decoders[chunk.stream].write(Buffer.from(chunk.chunk, "base64"));
				appendBounded(
					session,
					session.tty ? text : session.normalizers[chunk.stream].write(text),
					maxSessionBufferChars,
				);
				if (session.tty && text) emitPtyData(Object.freeze({ processId: session.id, data: text }));
				session.lastSeq = Math.max(session.lastSeq, chunk.seq);
			}
			session.lastSeq = Math.max(session.lastSeq, response.nextSeq - 1);
			if (response.exited) {
				session.observedExitCode = response.exitCode ?? 1;
				session.finishedAtMs ??= Date.now();
			}
			if (response.closed) {
				session.closed = true;
				session.exitCode = response.exitCode ?? session.observedExitCode ?? 1;
				if (!session.decodersFlushed) {
					session.decodersFlushed = true;
					for (const stream of ["stdout", "stderr", "pty"] as const) {
						const text = session.decoders[stream].end();
						appendBounded(session, session.tty ? text : session.normalizers[stream].end(text), maxSessionBufferChars);
						if (session.tty && text) emitPtyData(Object.freeze({ processId: session.id, data: text }));
					}
				}
				try {
					const reaped = await bridge.request<{ removed: boolean }>({
						op: "reap",
						process_id: session.processId,
					});
					if (!reaped.removed) throw new Error("native process was not reaped");
				} catch (error) {
					appendBounded(
						session,
						`exec_command_bridge reap failed: ${error instanceof Error ? error.message : String(error)}\n`,
						maxSessionBufferChars,
					);
					session.exitCode = 1;
				}
			}
			if (response.chunks.length > 0 || response.exited || response.closed) {
				wake(session);
				emitProcesses();
			}
		}
	}

	function wait(
		session: Session,
		idleMs: number,
		hardLimitMs: number,
		signal: AbortSignal | undefined,
		baselineVersion: number,
		onProgress?: (elapsedMs: number) => void,
	): Promise<number> {
		if (stopped || session.exitCode !== undefined || signal?.aborted) return Promise.resolve(0);
		const started = Date.now();
		return new Promise((resolvePromise, reject) => {
			let idleTimer: ReturnType<typeof setTimeout>;
			let hardTimer: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(idleTimer);
				clearTimeout(hardTimer);
				session.waiters.delete(onWake);
				signal?.removeEventListener("abort", onAbort);
			};
			const finish = () => {
				cleanup();
				resolvePromise(Date.now() - started);
			};
			const resetIdle = () => {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(finish, idleMs);
			};
			const onWake = () => {
				if (session.version !== baselineVersion) onProgress?.(Date.now() - started);
				if (stopped || session.exitCode !== undefined) finish();
				else if (session.version !== baselineVersion) resetIdle();
			};
			const onAbort = () => {
				cleanup();
				reject(abortError("exec_command"));
			};
			idleTimer = setTimeout(finish, idleMs);
			hardTimer = setTimeout(finish, Math.max(idleMs, hardLimitMs));
			session.waiters.add(onWake);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	return {
		async exec(input, cwd, signal, onUpdate) {
			if (stopped) throw new Error("exec session manager is shut down");
			if (signal?.aborted) throw abortError("exec_command");
			if (sessions.size >= MAX_ACTIVE_SESSIONS) {
				throw new Error(`exec_command supports at most ${MAX_ACTIVE_SESSIONS} active sessions`);
			}
			const id = nextSessionId++;
			const shell = resolveRuntimeShell(input.shell ?? env["SHELL"]);
			const workingDirectory = resolve(cwd, input.workdir ?? ".");
			const session: Session = {
				id,
				processId: `pi-${process.pid}-${id}`,
				command: input.cmd,
				cwd: workingDirectory,
				shell,
				tty: input.tty ?? false,
				startedAtMs: Date.now(),
				bufferChunks: [],
				bufferFirstChunk: 0,
				bufferLength: 0,
				bufferStartOffset: 0,
				emittedOffset: 0,
				closed: false,
				lastSeq: 0,
				version: 0,
				waiters: new Set(),
				decoders: {
					stdout: new StringDecoder("utf8"),
					stderr: new StringDecoder("utf8"),
					pty: new StringDecoder("utf8"),
				},
				normalizers: {
					stdout: new OutputNormalizer(),
					stderr: new OutputNormalizer(),
					pty: new OutputNormalizer(),
				},
				decodersFlushed: false,
			};
			sessions.set(id, session);
			rememberCommand(id, input.cmd);
			try {
				await bridge.request({
					op: "exec",
					process_id: session.processId,
					argv: [shell, ...shellArgs(input.cmd, input.login ?? defaultLoginShell, shell)],
					cwd: workingDirectory,
					env,
					tty: session.tty,
					pipe_stdin: session.tty,
					arg0: null,
				});
				if (signal?.aborted) {
					await bridge.request({ op: "terminate", process_id: session.processId }).catch(() => undefined);
					sessions.delete(session.id);
					throw abortError("exec_command");
				}
			} catch (error) {
				sessions.delete(session.id);
				emitProcesses();
				throw error;
			}
			emitProcesses();
			void pollLoop(session);
			try {
				const idleMs = clamp(input.yield_time_ms, defaultExecYieldTimeMs, maxExecYieldTimeMs);
				const elapsed = await wait(session, idleMs, maxExecYieldTimeMs, signal, session.version, (progressMs) => {
					const output = peekOutput(session, session.emittedOffset, input.max_output_tokens ?? defaultMaxOutputTokens);
					publishUpdate(onUpdate, {
						chunk_id: chunkId(),
						wall_time_seconds: progressMs / 1_000,
						...output,
						...(session.exitCode === undefined ? { session_id: session.id } : { exit_code: session.exitCode }),
					});
				});
				if (stopped) throw new Error("exec session manager shut down during exec_command");
				const result = resultFor(session, elapsed, input.max_output_tokens ?? defaultMaxOutputTokens);
				if (session.exitCode !== undefined) {
					rememberCompleted(session, elapsed);
					sessions.delete(session.id);
					emitProcesses();
				}
				return result;
			} catch (error) {
				if (signal?.aborted) {
					await bridge.request({ op: "terminate", process_id: session.processId }).catch(() => undefined);
					sessions.delete(session.id);
					emitProcesses();
				}
				throw error;
			}
		},
		async write(input, signal, onUpdate) {
			if (stopped) throw new Error("exec session manager is shut down");
			if (signal?.aborted) throw abortError("write_stdin");
			const session = sessions.get(input.session_id);
			if (!session) {
				const completedSession = completed.get(input.session_id);
				if (!completedSession) throw new Error(`Unknown session id ${input.session_id}`);
				if ((input.chars ?? "").length > 0) {
					throw new Error(
						`Session ${input.session_id} already exited with code ${completedSession.result.exit_code}; cannot write stdin`,
					);
				}
				return replayCompleted(completedSession, input.max_output_tokens ?? defaultMaxOutputTokens);
			}
			const baseline = outputEnd(session);
			const chars = input.chars ?? "";
			if (chars) {
				if (!session.tty) throw new Error("stdin is closed for this session; rerun exec_command with tty=true");
				const response = await raceAbort(
					bridge.request<{ status: string }>({
						op: "write",
						process_id: session.processId,
						chunk: Array.from(Buffer.from(chars, "utf8")),
					}),
					signal,
					"write_stdin",
				);
				if (response.status !== "accepted") throw new Error(`stdin write was ${response.status}`);
				session.nextEmptyPollYieldMs = undefined;
			}
			const requestedYieldMs = chars
				? clamp(input.yield_time_ms, DEFAULT_WRITE_YIELD_MS, maxExecYieldTimeMs)
				: Math.min(
						maxEmptyWriteYieldTimeMs,
						Math.max(minEmptyWriteYieldTimeMs, input.yield_time_ms ?? minEmptyWriteYieldTimeMs),
					);
			const effectiveYieldMs = chars ? requestedYieldMs : Math.max(requestedYieldMs, session.nextEmptyPollYieldMs ?? 0);
			const elapsed = await wait(session, effectiveYieldMs, effectiveYieldMs, signal, session.version, (progressMs) => {
				const output = peekOutput(session, baseline, input.max_output_tokens ?? defaultMaxOutputTokens);
				publishUpdate(onUpdate, {
					chunk_id: chunkId(),
					wall_time_seconds: progressMs / 1_000,
					...output,
					...(session.exitCode === undefined ? { session_id: session.id } : { exit_code: session.exitCode }),
				});
			});
			if (!chars && session.exitCode === undefined) {
				session.nextEmptyPollYieldMs = Math.min(maxEmptyWriteYieldTimeMs, effectiveYieldMs * 2);
			}
			const output = peekOutput(session, baseline, input.max_output_tokens ?? defaultMaxOutputTokens);
			if (stopped) throw new Error("exec session manager shut down during write_stdin");
			session.emittedOffset = outputEnd(session);
			const result: UnifiedExecResult = {
				chunk_id: chunkId(),
				wall_time_seconds: elapsed / 1000,
				...output,
				...(session.exitCode === undefined ? { session_id: session.id } : { exit_code: session.exitCode }),
			};
			if (session.exitCode !== undefined) {
				rememberCompleted(session, elapsed);
				sessions.delete(session.id);
				emitProcesses();
			}
			return result;
		},
		getSessionCommand(sessionId) {
			return sessions.get(sessionId)?.command ?? completed.get(sessionId)?.command ?? commands.get(sessionId);
		},
		getSessionTty(sessionId) {
			return sessions.get(sessionId)?.tty ?? completed.get(sessionId)?.tty;
		},
		listProcesses,
		subscribeProcesses(listener) {
			processListeners.add(listener);
			try {
				listener(listProcesses());
			} catch {
				// Presentation observers cannot own process lifecycle.
			}
			return () => processListeners.delete(listener);
		},
		onPtyData(listener) {
			ptyListeners.add(listener);
			return () => ptyListeners.delete(listener);
		},
		async interrupt(sessionId) {
			const session = sessions.get(sessionId);
			if (!session || session.exitCode !== undefined) return false;
			const response = await bridge.request<{ running: boolean }>({
				op: "interrupt",
				process_id: session.processId,
			});
			return response.running;
		},
		async terminate(sessionId) {
			const session = sessions.get(sessionId);
			if (!session || session.exitCode !== undefined) return false;
			const response = await bridge.request<{ running: boolean }>({
				op: "terminate",
				process_id: session.processId,
			});
			return response.running;
		},
		async resize(sessionId, cols, rows) {
			const session = sessions.get(sessionId);
			if (!session?.tty || session.exitCode !== undefined) return false;
			const response = await bridge.request<{ resized: boolean }>({
				op: "resize",
				process_id: session.processId,
				cols: Math.min(MAX_PROCESS_COLS, Math.max(1, Math.floor(cols))),
				rows: Math.min(MAX_PROCESS_ROWS, Math.max(1, Math.floor(rows))),
			});
			return response.resized;
		},
		async sendInput(sessionId, chars) {
			const session = sessions.get(sessionId);
			if (!session || session.exitCode !== undefined) return false;
			if (!session.tty) throw new Error("stdin is closed for this session; rerun exec_command with tty=true");
			const response = await bridge.request<{ status: string }>({
				op: "write",
				process_id: session.processId,
				chunk: Array.from(Buffer.from(chars, "utf8")),
			});
			if (response.status === "accepted") return true;
			if (response.status === "unknown_process" || response.status === "stdin_closed") return false;
			throw new Error(`stdin write was ${response.status}`);
		},
		async shutdown() {
			if (stopped) return;
			stopped = true;
			for (const session of sessions.values()) wake(session);
			try {
				await bridge.shutdown();
			} finally {
				sessions.clear();
				commands.clear();
				completed.clear();
				emitProcesses();
				processListeners.clear();
				ptyListeners.clear();
			}
		},
	};
}
