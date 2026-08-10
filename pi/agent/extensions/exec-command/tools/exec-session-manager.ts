import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createNodePtyBackend, type PtyBackend, type PtyProcess } from "../adapter/pty-backend.ts";
import { DEFAULT_EXEC_SHELL, isFishShell, resolveRuntimeShell } from "../adapter/runtime-shell.ts";
import {
	appendCaptureOutput,
	approxTokenCount,
	capHeadTail,
	formattedTruncateText,
	UNIFIED_EXEC_OUTPUT_MAX_BYTES,
} from "./output-truncation.ts";

type ExecTerminalState = "exited" | "timed_out" | "cancelled" | "session_error";
type ExecInterventionState = "timed_out" | "cancelled";

export interface UnifiedExecResult {
	chunk_id: string;
	wall_time_seconds: number;
	output: string;
	exit_code?: number;
	terminal_state?: ExecTerminalState;
	timed_out?: boolean;
	cancelled?: boolean;
	session_error?: string;
	process_id?: number;
	process_name?: string;
	stdin_open?: boolean;
	original_token_count?: number;
	output_truncated?: boolean;
	context_guard_capture?: {
		artifact_id: string;
		byte_count: number;
		line_count: number;
	};
	context_guard_capture_failure?: string;
	context_guard_capture_truncated?: boolean;
	capture_output?: string;
	capture_output_truncated?: boolean;
}
export interface ProcessLogChunk {
	process_id: number;
	process_name?: string;
	cursor: number;
	next_cursor: number;
	output: string;
	truncated: boolean;
	running: boolean;
}
export interface ProcessWaitResult {
	process: ExecSessionRecord;
	matched: boolean;
	timed_out: boolean;
}

export type ProcessSelector = number | string;

interface ExecSessionSnapshot {
	command: string;
	name?: string;
	output: string;
	running: boolean;
	exitCode?: number;
	terminalState?: ExecTerminalState;
	timedOut?: boolean;
	cancelled?: boolean;
	sessionError?: string;
	stdinOpen?: boolean;
	tty: boolean;
	elapsedMs: number;
	originalTokenCount?: number;
	outputTruncated: boolean;
	captureOutput: string;
	captureOutputTruncated: boolean;
}

export interface ExecSessionRecord {
	id: number;
	name: string;
	attachCommand?: string;
	attachment?: { command: string; args: string[] };
	command: string;
	cwd: string;
	output: string;
	ownerSessionId?: string;
	running: boolean;
	exitCode?: number;
	stdinOpen: boolean;
	startedAtMs: number;
	finishedAtMs?: number;
	state: "running" | ExecTerminalState;
}

export interface ExecCommandInput {
	cmd: string;
	name?: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	env?: Record<string, string>;
	timeout_ms?: number;
	yield_time_ms?: number;
	login?: boolean;
	wait_for_exit?: boolean;
	ownerSessionId?: string;
}

interface WriteStdinInput {
	process_id: ProcessSelector;
	chars?: string;
	yield_time_ms?: number;
}

type ExecSessionUpdateCallback = (result: UnifiedExecResult) => void;

interface BaseExecSession {
	id: number;
	name: string;
	attachCommand?: string;
	attachment?: { command: string; args: string[] };
	command: string;
	cwd: string;
	input: ExecCommandInput;
	buffer: string;
	pendingBuffer: string;
	emittedBuffer: string;
	captureBuffer: string;
	captureBufferTruncated: boolean;
	logBuffer: string;
	logStartCursor: number;
	logEndCursor: number;
	exitCode: number | null | undefined;
	terminalState: ExecTerminalState | undefined;
	pendingTerminalState: ExecInterventionState | undefined;
	sessionError: string | undefined;
	finalized: boolean;
	listeners: Set<() => void>;
	interactive: boolean;
	startedAtMs: number;
	finishedAtMs?: number;
	hidden: boolean;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	abortCleanup?: () => void;
}

interface PipeExecSession extends BaseExecSession {
	kind: "pipe";
	child: ChildProcessByStdio<null, Readable, Readable>;
}

interface PtyExecSession extends BaseExecSession {
	kind: "pty";
	child: PtyProcess;
	terminalCommitted: string;
	terminalLine: string[];
	terminalCursor: number;
	terminalStyle: string;
	terminalPendingEscape: string;
}

type ExecSession = PipeExecSession | PtyExecSession;

export interface ExecSessionManager {
	exec(
		input: ExecCommandInput,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: ExecSessionUpdateCallback,
	): Promise<UnifiedExecResult>;
	write(input: WriteStdinInput): Promise<UnifiedExecResult>;
	resize(selector: ProcessSelector, cols: number, rows: number): Promise<boolean>;
	logs(selector: ProcessSelector, cursor?: number, maxChars?: number): ProcessLogChunk | undefined;
	wait(selector: ProcessSelector, pattern?: string, timeoutMs?: number): Promise<ProcessWaitResult | undefined>;
	describe(selector: ProcessSelector): ExecSessionRecord | undefined;
	restart(selector: ProcessSelector): Promise<UnifiedExecResult | undefined>;
	signal(selector: ProcessSelector, signal: "INT" | "TERM" | "KILL"): Promise<boolean>;
	hasSession(sessionId: number): boolean;
	getSessionCommand(selector: ProcessSelector): string | undefined;
	getSessionStdinOpen(selector: ProcessSelector): boolean | undefined;
	getSessionTty(selector: ProcessSelector): boolean | undefined;
	getSessionSnapshot(sessionId: number): ExecSessionSnapshot | undefined;
	listSessions(): ExecSessionRecord[];
	stopSession(selector: ProcessSelector): boolean;
	stopAllSessions(): number;
	onSessionExit(listener: (sessionId: number, command: string) => void): () => void;
	onSessionUpdate(listener: () => void): () => void;
	shutdown(): void;
}

export interface ExecSessionManagerOptions {
	defaultExecYieldTimeMs?: number;
	defaultWriteYieldTimeMs?: number;
	minNonInteractiveExecYieldTimeMs?: number;
	minYieldTimeMs?: number;
	minEmptyWriteYieldTimeMs?: number;
	maxSessionBufferChars?: number;
	ptyBackend?: PtyBackend;
}

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_YIELD_TIME_MS = 250;
const MIN_YIELD_TIME_MS = 250;
const MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS = 10_000;
const MIN_EMPTY_WRITE_YIELD_TIME_MS = 30_000;
const MAX_YIELD_TIME_MS = 120_000;
const MAX_COMMAND_HISTORY = 256;
const DEFAULT_MAX_SESSION_BUFFER_CHARS = UNIFIED_EXEC_OUTPUT_MAX_BYTES;
const IS_BUN_RUNTIME = typeof process !== "undefined" && typeof process.versions?.bun === "string";
const NODE_PTY_HOST = fileURLToPath(new URL("./node-pty-host.mjs", import.meta.url));

function resolveWorkdir(baseCwd: string, workdir?: string): string {
	if (!workdir) return baseCwd;
	return resolve(baseCwd, workdir);
}

function resolveShell(shell?: string): string {
	return resolveRuntimeShell(shell || process.env.SHELL);
}

const BASH_SYNC_ENV_KEYS = [
	"PATH",
	"SHELL",
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"BUN_INSTALL",
	"PNPM_HOME",
	"MISE_DATA_DIR",
	"MISE_CONFIG_DIR",
	"MISE_SHIMS_DIR",
	"CARGO_HOME",
	"GOPATH",
	"ANDROID_HOME",
	"ANDROID_NDK_HOME",
	"JAVA_HOME",
];

function shellEscape(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shouldSyncFallbackShellEnv(requestedShell: string | undefined, effectiveShell: string): boolean {
	return effectiveShell === DEFAULT_EXEC_SHELL && isFishShell(requestedShell || process.env.SHELL);
}

function buildSyncedFallbackShellCommand(command: string, env: NodeJS.ProcessEnv): string {
	const assignments: string[] = [];
	for (const key of BASH_SYNC_ENV_KEYS) {
		const value = key === "SHELL" ? DEFAULT_EXEC_SHELL : env[key];
		if (typeof value !== "string") continue;
		assignments.push(`export ${key}=${shellEscape(value)}`);
	}
	if (assignments.length === 0) return command;
	return `${assignments.join("; ")}; ${command}`;
}

function resolveExecution(
	requestedShell: string | undefined,
	command: string,
	overrides?: Record<string, string>,
	tty = false,
): { shell: string; command: string; env: NodeJS.ProcessEnv } {
	const shell = resolveShell(requestedShell);
	const env = withUnifiedExecEnvironment({ ...process.env, ...overrides }, tty);
	if (!shouldSyncFallbackShellEnv(requestedShell, shell)) {
		return { shell, command, env };
	}
	env.SHELL = DEFAULT_EXEC_SHELL;
	return {
		shell,
		command: buildSyncedFallbackShellCommand(command, env),
		env,
	};
}

function withUnifiedExecEnvironment(env: NodeJS.ProcessEnv, tty: boolean): NodeJS.ProcessEnv {
	Object.assign(env, {
		LANG: "C.UTF-8",
		LC_CTYPE: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		PAGER: "cat",
		GIT_PAGER: "cat",
		GH_PAGER: "cat",
	});
	if (tty) {
		delete env.NO_COLOR;
		delete env.CODEX_CI;
		env.TERM = "xterm-256color";
		env.COLORTERM = "truecolor";
		return env;
	}
	Object.assign(env, {
		NO_COLOR: "1",
		TERM: "dumb",
		COLORTERM: "",
		CODEX_CI: "1",
	});
	delete env.FORCE_COLOR;
	delete env.CLICOLOR;
	return env;
}
function clampYieldTime(value: number | undefined, fallback: number, minYieldTimeMs: number): number {
	const resolved = value ?? fallback;
	return Math.min(MAX_YIELD_TIME_MS, Math.max(minYieldTimeMs, resolved));
}

function clampExecYieldTime(
	yieldTimeMs: number | undefined,
	fallback: number,
	isInteractive: boolean,
	minNonInteractiveExecYieldTimeMs: number,
	minYieldTimeMs: number,
): number {
	const value = clampYieldTime(yieldTimeMs, fallback, minYieldTimeMs);
	if (isInteractive || yieldTimeMs !== undefined) {
		return value;
	}
	return Math.min(MAX_YIELD_TIME_MS, Math.max(minNonInteractiveExecYieldTimeMs, value));
}

function clampWriteYieldTime(
	yieldTimeMs: number | undefined,
	fallback: number,
	isEmptyPoll: boolean,
	minEmptyWriteYieldTimeMs: number,
	minYieldTimeMs: number,
): number {
	const value = clampYieldTime(yieldTimeMs, fallback, minYieldTimeMs);
	if (!isEmptyPoll || yieldTimeMs !== undefined) {
		return value;
	}
	return Math.min(MAX_YIELD_TIME_MS, Math.max(minEmptyWriteYieldTimeMs, value));
}

function stripTerminalControlSequences(text: string, preserveCsi = false, preserveSgr = false): string {
	const withoutOscAndDcs = text
		.replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
		.replace(/\u001B[P_X^][\s\S]*?\u001B\\/g, "");
	if (preserveCsi) {
		return withoutOscAndDcs;
	}
	return withoutOscAndDcs
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, (sequence) => (preserveSgr && sequence.endsWith("m") ? sequence : ""))
		.replace(preserveSgr ? /\u001B(?!\[)[@-_]/g : /\u001B[@-_]/g, "");
}

function sanitizeBinaryOutput(text: string, preserveBackspace = false, preserveSgr = false): string {
	let output = "";
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (preserveSgr && char === "\u001b" && text[index + 1] === "[") {
			let sequenceEnd = index + 2;
			while (sequenceEnd < text.length) {
				const code = text.charCodeAt(sequenceEnd);
				if (code >= 0x40 && code <= 0x7e) break;
				sequenceEnd += 1;
			}
			if (sequenceEnd < text.length && text[sequenceEnd] === "m") {
				output += text.slice(index, sequenceEnd + 1);
				index = sequenceEnd;
			}
			continue;
		}

		const code = char.codePointAt(0);
		if (code === undefined) continue;
		if (code === 0x09 || code === 0x0a || code === 0x0d) {
			output += char;
			continue;
		}
		if (preserveBackspace && code === 0x08) {
			output += char;
			continue;
		}
		if (code <= 0x1f) continue;
		if (code >= 0xfff9 && code <= 0xfffb) continue;
		output += char;
	}
	return output;
}

function compactSgrRuns(text: string): string {
	const sgr = /\u001b\[([0-9;]*)m/g;
	let output = "";
	let cursor = 0;
	let activeStyle = "";
	let pendingReset = false;
	for (const match of text.matchAll(sgr)) {
		const index = match.index;
		const plain = text.slice(cursor, index);
		if (plain) {
			if (pendingReset) {
				output += "\u001b[0m";
				activeStyle = "";
				pendingReset = false;
			}
			output += plain;
		}
		const sequence = match[0];
		const params = match[1] ?? "";
		const reset = params === "" || params.split(";").includes("0");
		if (reset) {
			pendingReset = true;
		} else if (pendingReset && sequence === activeStyle) {
			pendingReset = false;
		} else {
			if (pendingReset) output += "\u001b[0m";
			output += sequence;
			activeStyle = sequence;
			pendingReset = false;
		}
		cursor = index + sequence.length;
	}
	const tail = text.slice(cursor);
	if (tail) {
		if (pendingReset) output += "\u001b[0m";
		output += tail;
		pendingReset = false;
	}
	if (pendingReset) output += "\u001b[0m";
	return output;
}

function normalizePipeOutput(text: string): string {
	return compactSgrRuns(sanitizeBinaryOutput(stripTerminalControlSequences(text, false, true), false, true))
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

function writeTerminalChar(session: PtyExecSession, char: string): void {
	if (session.terminalCursor > session.terminalLine.length) {
		session.terminalLine.push(
			...Array.from({ length: session.terminalCursor - session.terminalLine.length }, () => " "),
		);
	}
	session.terminalLine[session.terminalCursor] = session.terminalStyle
		? `${session.terminalStyle}${char}\u001b[0m`
		: char;
	session.terminalCursor += 1;
}

function compactTerminalLine(cells: string[]): string {
	let output = "";
	let activeStyle = "";
	for (const cell of cells) {
		const styled = cell.match(/^(\u001b\[[0-9;]*m)([\s\S]*)\u001b\[0m$/);
		if (styled) {
			const style = styled[1]!;
			if (style !== activeStyle) {
				if (activeStyle) output += "\u001b[0m";
				output += style;
				activeStyle = style;
			}
			output += styled[2]!;
			continue;
		}
		if (activeStyle) {
			output += "\u001b[0m";
			activeStyle = "";
		}
		output += cell;
	}
	if (activeStyle) output += "\u001b[0m";
	return output;
}

function applyTerminalOutput(session: PtyExecSession, text: string): string {
	const sanitized = session.terminalPendingEscape + stripTerminalControlSequences(text, true);
	session.terminalPendingEscape = "";
	if (sanitized.length === 0) {
		return session.terminalCommitted + compactTerminalLine(session.terminalLine);
	}

	for (let index = 0; index < sanitized.length; index += 1) {
		const char = sanitized[index]!;
		if (char === "\u001b") {
			if (sanitized[index + 1] === "[") {
				let sequenceEnd = index + 2;
				while (sequenceEnd < sanitized.length) {
					const code = sanitized.charCodeAt(sequenceEnd);
					if (code >= 0x40 && code <= 0x7e) {
						break;
					}
					sequenceEnd += 1;
				}
				if (sequenceEnd >= sanitized.length) {
					session.terminalPendingEscape = sanitized.slice(index);
					break;
				}
				const params = sanitized.slice(index + 2, sequenceEnd);
				const finalByte = sanitized[sequenceEnd];
				if (finalByte === "m") {
					session.terminalStyle = params === "" || params.split(";").includes("0") ? "" : `\u001b[${params}m`;
				} else if (finalByte === "K") {
					const mode = Number(params || "0");
					if (mode === 0) {
						session.terminalLine = session.terminalLine.slice(0, session.terminalCursor);
					} else if (mode === 1) {
						session.terminalLine = [
							...Array.from(
								{
									length: Math.min(session.terminalCursor, session.terminalLine.length),
								},
								() => " ",
							),
							...session.terminalLine.slice(session.terminalCursor),
						];
					} else if (mode === 2) {
						session.terminalLine = [];
					}
				}
				index = sequenceEnd;
				continue;
			}

			const next = sanitized[index + 1];
			if (next && /[()*+,\-./]/.test(next) && index + 2 < sanitized.length) {
				index += 2;
				continue;
			}
			if (!next) {
				session.terminalPendingEscape = sanitized.slice(index);
				break;
			}
			if (next) {
				index += 1;
			}
			continue;
		}

		const code = char.codePointAt(0);
		if (code !== undefined && code <= 0x1f && char !== "\t" && char !== "\n" && char !== "\r" && char !== "\b") {
			continue;
		}

		switch (char) {
			case "\r":
				session.terminalCursor = 0;
				break;
			case "\n":
				session.terminalCommitted += `${compactTerminalLine(session.terminalLine)}\n`;
				session.terminalLine = [];
				session.terminalCursor = 0;
				break;
			case "\b":
				session.terminalCursor = Math.max(0, session.terminalCursor - 1);
				break;
			default:
				writeTerminalChar(session, char);
				break;
		}
	}

	return session.terminalCommitted + compactTerminalLine(session.terminalLine);
}

function computePtyDelta(previous: string, current: string): string {
	if (current.startsWith(previous)) {
		return current.slice(previous.length);
	}

	const lineStart = previous.lastIndexOf("\n") + 1;
	const stablePrefix = previous.slice(0, lineStart);
	if (current.startsWith(stablePrefix)) {
		return `\r${current.slice(lineStart)}`;
	}

	return current;
}

function generateChunkId(): string {
	return randomBytes(3).toString("hex");
}

function consumeOutput(session: ExecSession): {
	output: string;
	original_token_count?: number;
	output_truncated?: boolean;
} {
	const text = session.pendingBuffer;
	session.pendingBuffer = "";
	session.emittedBuffer = session.buffer;
	if (text.length === 0) {
		return { output: "" };
	}

	return {
		...formattedTruncateText(text),
		original_token_count: approxTokenCount(text),
	};
}

function registerAbortHandler(signal: AbortSignal | undefined, onAbort: () => void): () => void {
	if (!signal) {
		return () => {};
	}

	if (signal.aborted) {
		onAbort();
		return () => {};
	}

	const abortListener = () => onAbort();
	signal.addEventListener("abort", abortListener, { once: true });
	return () => signal.removeEventListener("abort", abortListener);
}

interface ProcessInfo {
	pid: number;
	ppid: number;
	pgid: number;
}

function listProcesses(): ProcessInfo[] {
	try {
		return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
			encoding: "utf8",
		})
			.split("\n")
			.map((line): ProcessInfo | undefined => {
				const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+/);
				if (!match) return undefined;
				return {
					pid: Number(match[1]),
					ppid: Number(match[2]),
					pgid: Number(match[3]),
				};
			})
			.filter((process): process is ProcessInfo => process !== undefined);
	} catch {
		return [];
	}
}

function collectDescendantPids(rootPid: number): number[] {
	const childrenByParent = new Map<number, number[]>();
	for (const process of listProcesses()) {
		const children = childrenByParent.get(process.ppid) ?? [];
		children.push(process.pid);
		childrenByParent.set(process.ppid, children);
	}

	const descendants: number[] = [];
	const pending = [...(childrenByParent.get(rootPid) ?? [])];
	while (pending.length > 0) {
		const pid = pending.pop();
		if (pid === undefined) continue;
		descendants.push(pid);
		pending.push(...(childrenByParent.get(pid) ?? []));
	}
	return descendants;
}

function killPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Process already exited or is not signalable by this user.
	}
}

function signalProcessTree(
	rootPid: number | undefined,
	includeRootProcessGroup: boolean,
	signal: NodeJS.Signals,
): void {
	if (rootPid === undefined || rootPid <= 0) return;
	const descendants = collectDescendantPids(rootPid);
	for (const pid of [...descendants.reverse(), rootPid]) killPid(pid, signal);
	if (includeRootProcessGroup) killPid(-rootPid, signal);
}

function terminateProcessTree(rootPid: number | undefined, includeRootProcessGroup: boolean, force = false): void {
	if (rootPid === undefined || rootPid <= 0) return;
	const descendants = collectDescendantPids(rootPid);
	const targets = [...descendants.reverse(), rootPid];
	for (const pid of targets) {
		killPid(pid, "SIGTERM");
	}
	if (includeRootProcessGroup) {
		killPid(-rootPid, "SIGTERM");
	}

	if (force) {
		for (const pid of targets) {
			killPid(pid, "SIGKILL");
		}
		if (includeRootProcessGroup) {
			killPid(-rootPid, "SIGKILL");
		}
		return;
	}

	const killTimer = setTimeout(() => {
		for (const pid of targets) {
			killPid(pid, "SIGKILL");
		}
		if (includeRootProcessGroup) {
			killPid(-rootPid, "SIGKILL");
		}
	}, 500);
	killTimer.unref?.();
}

export function createExecSessionManager(options: ExecSessionManagerOptions = {}): ExecSessionManager {
	let nextSessionId = 1;
	const sessions = new Map<number, ExecSession>();
	const reservedNames = new Set<string>();
	const commandHistory = new Map<number, string>();
	const ttyHistory = new Map<number, boolean>();
	const exitListeners = new Set<(sessionId: number, command: string) => void>();
	const updateListeners = new Set<() => void>();
	const defaultExecYieldTimeMs = options.defaultExecYieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS;
	const defaultWriteYieldTimeMs = options.defaultWriteYieldTimeMs ?? DEFAULT_WRITE_YIELD_TIME_MS;
	const minYieldTimeMs = Math.min(MAX_YIELD_TIME_MS, Math.max(1, options.minYieldTimeMs ?? MIN_YIELD_TIME_MS));
	const minNonInteractiveExecYieldTimeMs = Math.min(
		MAX_YIELD_TIME_MS,
		Math.max(minYieldTimeMs, options.minNonInteractiveExecYieldTimeMs ?? MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS),
	);
	const minEmptyWriteYieldTimeMs = Math.min(
		MAX_YIELD_TIME_MS,
		Math.max(minYieldTimeMs, options.minEmptyWriteYieldTimeMs ?? MIN_EMPTY_WRITE_YIELD_TIME_MS),
	);
	const maxSessionBufferChars = Math.max(1024, options.maxSessionBufferChars ?? DEFAULT_MAX_SESSION_BUFFER_CHARS);

	function rememberCommand(sessionId: number, command: string, tty: boolean): void {
		commandHistory.set(sessionId, command);
		ttyHistory.set(sessionId, tty);
		if (commandHistory.size <= MAX_COMMAND_HISTORY) {
			return;
		}
		const oldest = commandHistory.keys().next().value;
		if (oldest !== undefined) {
			commandHistory.delete(oldest);
			ttyHistory.delete(oldest);
		}
	}

	function notify(session: ExecSession): void {
		for (const listener of session.listeners) {
			listener();
		}
		notifySessionUpdate();
	}

	function notifySessionUpdate(): void {
		for (const listener of updateListeners) {
			listener();
		}
	}

	function isRunning(session: ExecSession): boolean {
		return session.terminalState === undefined;
	}

	function processName(requested: string | undefined, id: number): string {
		const normalized = requested
			?.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		return normalized || `pi-exec-${id}`;
	}

	function nameInUse(name: string): boolean {
		return reservedNames.has(name) || [...sessions.values()].some((session) => session.name === name);
	}

	function uniqueProcessName(base: string): string {
		if (!nameInUse(base)) return base;
		let suffix = 2;
		while (nameInUse(`${base}-${suffix}`)) suffix++;
		return `${base}-${suffix}`;
	}

	function resolveSession(selector: ProcessSelector): ExecSession | undefined {
		if (typeof selector === "number") {
			const session = sessions.get(selector);
			return session && !session.hidden ? session : undefined;
		}
		return [...sessions.values()].find((session) => !session.hidden && session.name === selector);
	}

	function toRecord(session: ExecSession): ExecSessionRecord {
		const running = isRunning(session);
		return {
			id: session.id,
			name: session.name,
			attachCommand: session.attachCommand,
			attachment: session.attachment,
			command: session.command,
			cwd: session.cwd,
			ownerSessionId: session.input.ownerSessionId,
			output: session.buffer,
			running,
			exitCode: session.terminalState === "exited" ? (session.exitCode ?? 0) : undefined,
			stdinOpen: session.interactive,
			startedAtMs: session.startedAtMs,
			finishedAtMs: session.finishedAtMs,
			state: running ? "running" : (session.terminalState ?? "exited"),
		};
	}

	function deleteSession(sessionId: number): boolean {
		const deleted = sessions.delete(sessionId);
		if (deleted) {
			notifySessionUpdate();
		}
		return deleted;
	}

	function deleteExitedSessions(): void {
		for (const [sessionId, session] of sessions) {
			if (!isRunning(session)) sessions.delete(sessionId);
		}
	}

	function terminateSession(session: ExecSession, reason: ExecInterventionState = "cancelled"): void {
		if (!isRunning(session)) return;
		session.abortCleanup?.();
		session.abortCleanup = undefined;
		if (session.timeoutTimer) {
			clearTimeout(session.timeoutTimer);
			session.timeoutTimer = undefined;
		}
		session.pendingTerminalState = reason;
		if (session.kind === "pty") {
			if (session.child.pid === undefined) session.child.kill();
			else terminateProcessTree(session.child.pid, false, true);
		} else {
			terminateProcessTree(session.child.pid, true, true);
		}
	}

	function scheduleSessionTimeout(session: ExecSession, timeoutMs: number | undefined): void {
		if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
		session.timeoutTimer = setTimeout(() => terminateSession(session, "timed_out"), timeoutMs);
		session.timeoutTimer.unref?.();
	}

	function finalizeSession(session: ExecSession): void {
		if (session.finalized) return;
		session.finalized = true;
		session.finishedAtMs = Date.now();
		for (const listener of exitListeners) {
			listener(session.id, session.command);
		}
		if (session.hidden) sessions.delete(session.id);
		notify(session);
	}

	function completeSession(
		session: ExecSession,
		terminalState: ExecTerminalState,
		exitCode?: number,
		sessionError?: string,
	): void {
		if (session.terminalState !== undefined) return;
		session.abortCleanup?.();
		session.abortCleanup = undefined;
		if (session.timeoutTimer) {
			clearTimeout(session.timeoutTimer);
			session.timeoutTimer = undefined;
		}
		session.terminalState = terminalState;
		session.exitCode = terminalState === "exited" ? (exitCode ?? 0) : undefined;
		session.sessionError = sessionError;
		finalizeSession(session);
	}

	function addTerminalState(result: UnifiedExecResult, session: ExecSession): void {
		if (session.terminalState === undefined) return;
		result.terminal_state = session.terminalState;
		if (session.terminalState === "exited") result.exit_code = session.exitCode ?? 0;
		if (session.terminalState === "timed_out") result.timed_out = true;
		if (session.terminalState === "cancelled") result.cancelled = true;
		if (session.terminalState === "session_error" && session.sessionError) {
			result.session_error = session.sessionError;
		}
	}

	function appendLog(session: ExecSession, text: string): void {
		session.logBuffer += text;
		session.logEndCursor += text.length;
		if (session.logBuffer.length <= maxSessionBufferChars) return;
		const dropped = session.logBuffer.length - maxSessionBufferChars;
		session.logBuffer = session.logBuffer.slice(dropped);
		session.logStartCursor += dropped;
	}

	function appendOutput(session: ExecSession, text: string): void {
		if (text.length === 0) return;
		appendLog(session, text);
		const previous = session.buffer;
		if (session.kind === "pty") {
			session.buffer = applyTerminalOutput(session, text);
			const captured = appendCaptureOutput(session.captureBuffer, session.buffer.slice(previous.length));
			session.captureBuffer = captured.output;
			session.captureBufferTruncated ||= captured.truncated;
			session.pendingBuffer = capHeadTail(
				`${session.pendingBuffer}${computePtyDelta(previous, session.buffer)}`,
				UNIFIED_EXEC_OUTPUT_MAX_BYTES,
			);
		} else {
			const normalized = normalizePipeOutput(text);
			const captured = appendCaptureOutput(session.captureBuffer, normalized);
			session.captureBuffer = captured.output;
			session.captureBufferTruncated ||= captured.truncated;
			session.buffer = `${session.buffer}${normalized}`;
			session.pendingBuffer = capHeadTail(`${session.pendingBuffer}${normalized}`, UNIFIED_EXEC_OUTPUT_MAX_BYTES);
		}
		if (session.buffer.length > maxSessionBufferChars) {
			session.buffer = capHeadTail(session.buffer, maxSessionBufferChars);
			session.emittedBuffer = "";
		}
		notify(session);
	}

	function waitForExitOrTimeout(session: ExecSession, yieldTimeMs: number): Promise<number> {
		if (!isRunning(session)) {
			return Promise.resolve(0);
		}

		const startedAt = Date.now();
		return new Promise((resolvePromise) => {
			const onWake = () => {
				if (isRunning(session)) {
					return;
				}
				cleanup();
				resolvePromise(Date.now() - startedAt);
			};
			const timeout = setTimeout(() => {
				cleanup();
				resolvePromise(Date.now() - startedAt);
			}, yieldTimeMs);
			const cleanup = () => {
				clearTimeout(timeout);
				session.listeners.delete(onWake);
			};
			session.listeners.add(onWake);
		});
	}

	function makeResult(session: ExecSession, waitMs: number): UnifiedExecResult {
		const consumed = consumeOutput(session);
		const result: UnifiedExecResult = {
			chunk_id: generateChunkId(),
			wall_time_seconds: waitMs / 1000,
			output: consumed.output,
		};
		if (consumed.original_token_count !== undefined) {
			result.original_token_count = consumed.original_token_count;
		}
		if (consumed.output_truncated) {
			result.output_truncated = true;
		}
		if (isRunning(session)) {
			result.process_id = session.id;
			result.process_name = session.name;
			result.stdin_open = session.interactive;
			if (session.hidden) {
				session.hidden = false;
				notifySessionUpdate();
			}
		} else {
			addTerminalState(result, session);
			if (session.emittedBuffer === session.buffer) {
				deleteSession(session.id);
			}
		}
		Object.defineProperty(result, "capture_output", { value: session.captureBuffer, enumerable: false });
		Object.defineProperty(result, "capture_output_truncated", {
			value: session.captureBufferTruncated,
			enumerable: false,
		});
		return result;
	}

	function makeSnapshot(session: ExecSession, startedAtMs: number): UnifiedExecResult {
		const truncated = formattedTruncateText(session.buffer);
		const result: UnifiedExecResult = {
			chunk_id: generateChunkId(),
			wall_time_seconds: (Date.now() - startedAtMs) / 1000,
			output: truncated.output,
		};
		if (truncated.output_truncated) {
			result.output_truncated = true;
			result.original_token_count = approxTokenCount(session.buffer);
		}
		if (isRunning(session)) {
			result.process_id = session.id;
			result.process_name = session.name;
			result.stdin_open = session.interactive;
		} else {
			addTerminalState(result, session);
		}
		Object.defineProperty(result, "capture_output", { value: session.captureBuffer, enumerable: false });
		Object.defineProperty(result, "capture_output_truncated", {
			value: session.captureBufferTruncated,
			enumerable: false,
		});
		return result;
	}
	function streamSessionUpdates(
		session: ExecSession,
		onUpdate: ExecSessionUpdateCallback | undefined,
	): (() => void) | undefined {
		if (!onUpdate) return undefined;
		const startedAtMs = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let disposed = false;
		let lastOutput: string | undefined;
		let lastTerminalState: string | undefined;
		const emit = () => {
			timer = undefined;
			if (disposed) return;
			const snapshot = makeSnapshot(session, startedAtMs);
			if (snapshot.output === lastOutput && snapshot.terminal_state === lastTerminalState) return;
			lastOutput = snapshot.output;
			lastTerminalState = snapshot.terminal_state;
			onUpdate(snapshot);
		};
		const schedule = () => {
			if (timer || disposed) return;
			timer = setTimeout(emit, 80);
		};
		session.listeners.add(schedule);
		return () => {
			disposed = true;
			if (timer) clearTimeout(timer);
			session.listeners.delete(schedule);
		};
	}

	function createPipeSession(
		input: ExecCommandInput,
		workdir: string,
		shell: string,
		signal?: AbortSignal,
	): PipeExecSession {
		const id = nextSessionId++;
		const name = input.name ?? uniqueProcessName(processName(undefined, id));
		const login = input.login ?? true;
		const execution = resolveExecution(input.shell, input.cmd, input.env, input.tty === true);
		const shellArgs = login ? ["-lc", execution.command] : ["-c", execution.command];
		const child =
			input.tty && IS_BUN_RUNTIME
				? spawn("node", [NODE_PTY_HOST, shell, ...shellArgs], {
						cwd: workdir,
						stdio: ["pipe", "pipe", "pipe"],
						env: execution.env,
						detached: true,
					})
				: spawn(shell, shellArgs, {
						cwd: workdir,
						stdio: [input.tty ? "pipe" : "ignore", "pipe", "pipe"],
						env: execution.env,
						detached: true,
					});

		const session: PipeExecSession = {
			kind: "pipe",
			id,
			name,
			command: input.cmd,
			cwd: workdir,
			input: { ...input, name },
			child,
			buffer: "",
			pendingBuffer: "",
			emittedBuffer: "",
			captureBuffer: "",
			captureBufferTruncated: false,
			logBuffer: "",
			logStartCursor: 0,
			logEndCursor: 0,
			exitCode: undefined,
			terminalState: undefined,
			pendingTerminalState: undefined,
			sessionError: undefined,
			finalized: false,
			listeners: new Set(),
			interactive: Boolean(input.tty),
			startedAtMs: Date.now(),
			hidden: true,
		};

		child.stdout.on("data", (data: Buffer) => {
			appendOutput(session, data.toString("utf8"));
		});
		child.stderr.on("data", (data: Buffer) => {
			appendOutput(session, data.toString("utf8"));
		});
		child.on("close", (code) => {
			completeSession(session, session.pendingTerminalState ?? "exited", code ?? 0);
		});
		child.on("error", (error) => {
			appendOutput(session, `${error.message}\n`);
			completeSession(session, "session_error", undefined, error.message);
		});

		session.abortCleanup = registerAbortHandler(signal, () => {
			terminateSession(session, "cancelled");
		});

		scheduleSessionTimeout(session, input.timeout_ms);

		return session;
	}

	async function createPtySession(
		input: ExecCommandInput,
		workdir: string,
		shell: string,
		signal?: AbortSignal,
	): Promise<PtyExecSession> {
		const id = nextSessionId++;
		const requestedName = input.name;
		const login = input.login ?? true;
		const execution = resolveExecution(input.shell, input.cmd, input.env, true);
		const shellArgs = login ? ["-lc", execution.command] : ["-c", execution.command];
		const child = await (options.ptyBackend ?? createNodePtyBackend()).spawn(shell, shellArgs, {
			cwd: workdir,
			env: execution.env,
			name: process.env.TERM || "xterm-256color",
			sessionName: requestedName,
			cols: 80,
			rows: 24,
		});
		const name = requestedName ?? uniqueProcessName(child.name ?? processName(undefined, id));

		const session: PtyExecSession = {
			kind: "pty",
			id,
			command: input.cmd,
			name,
			cwd: workdir,
			input: { ...input, name },
			attachCommand: child.attachCommand,
			attachment: child.attachment,
			child,
			buffer: "",
			pendingBuffer: "",
			emittedBuffer: "",
			captureBuffer: "",
			captureBufferTruncated: false,
			logBuffer: "",
			logStartCursor: 0,
			logEndCursor: 0,
			exitCode: undefined,
			terminalState: undefined,
			pendingTerminalState: undefined,
			sessionError: undefined,
			finalized: false,
			listeners: new Set(),
			interactive: true,
			startedAtMs: Date.now(),
			hidden: true,
			terminalCommitted: "",
			terminalLine: [],
			terminalCursor: 0,
			terminalStyle: "",
			terminalPendingEscape: "",
		};

		child.onData((data) => {
			appendOutput(session, data);
		});
		child.onExit(({ exitCode }) => {
			completeSession(session, session.pendingTerminalState ?? "exited", exitCode ?? 0);
		});

		session.abortCleanup = registerAbortHandler(signal, () => {
			terminateSession(session, "cancelled");
		});
		scheduleSessionTimeout(session, input.timeout_ms);

		return session;
	}

	async function waitForTerminal(session: ExecSession): Promise<number> {
		const startedAt = Date.now();
		while (isRunning(session)) {
			await waitForExitOrTimeout(session, 1_000);
		}
		return Date.now() - startedAt;
	}

	const manager: ExecSessionManager = {
		exec: async (input, cwd, signal, onUpdate) => {
			deleteExitedSessions();
			let reservedName: string | undefined;
			if (input.name) {
				input = { ...input, name: processName(input.name, nextSessionId) };
				if (nameInUse(input.name)) throw new Error(`Process name already exists: ${input.name}`);
				reservedName = input.name;
				reservedNames.add(reservedName);
			}
			const shell = resolveShell(input.shell);
			const workdir = resolveWorkdir(cwd, input.workdir);
			let session: ExecSession;
			try {
				session = input.tty
					? await (async () => {
							if (options.ptyBackend !== undefined) {
								return createPtySession(input, workdir, shell, signal);
							}
							if (IS_BUN_RUNTIME) {
								return createPipeSession(input, workdir, shell, signal);
							}
							try {
								return await createPtySession(input, workdir, shell, signal);
							} catch {
								return createPipeSession(input, workdir, shell, signal);
							}
						})()
					: createPipeSession(input, workdir, shell, signal);
			} finally {
				if (reservedName) reservedNames.delete(reservedName);
			}
			sessions.set(session.id, session);
			rememberCommand(session.id, session.command, session.interactive);
			notifySessionUpdate();
			const stopStreaming = streamSessionUpdates(session, onUpdate);

			try {
				const waitedMs = input.wait_for_exit
					? await waitForTerminal(session)
					: await waitForExitOrTimeout(
							session,
							clampExecYieldTime(
								input.yield_time_ms,
								defaultExecYieldTimeMs,
								session.interactive,
								minNonInteractiveExecYieldTimeMs,
								minYieldTimeMs,
							),
						);
				return makeResult(session, waitedMs);
			} finally {
				stopStreaming?.();
			}
		},
		write: async (input) => {
			const session = resolveSession(input.process_id);
			if (!session) {
				throw new Error(
					typeof input.process_id === "number"
						? `Unknown process id ${input.process_id}`
						: `Unknown process ${input.process_id}`,
				);
			}
			if (input.chars && input.chars.length > 0) {
				if (!session.interactive) {
					throw new Error("stdin is closed for this session; rerun exec_command with tty=true to keep stdin open");
				}
				if (session.kind === "pty") {
					await session.child.write(input.chars);
				} else {
					session.child.stdin.write(input.chars);
				}
			}
			const waitedMs = isRunning(session)
				? await waitForExitOrTimeout(
						session,
						clampWriteYieldTime(
							input.yield_time_ms,
							defaultWriteYieldTimeMs,
							!input.chars || input.chars.length === 0,
							minEmptyWriteYieldTimeMs,
							minYieldTimeMs,
						),
					)
				: 0;
			return makeResult(session, waitedMs);
		},
		resize: async (selector, cols, rows) => {
			const session = resolveSession(selector);
			if (!session || !isRunning(session) || session.kind !== "pty") return false;
			await session.child.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
			return true;
		},
		logs: (selector, cursor = 0, maxChars = UNIFIED_EXEC_OUTPUT_MAX_BYTES) => {
			const session = resolveSession(selector);
			if (!session) return undefined;
			const start = Math.max(session.logStartCursor, Math.min(cursor, session.logEndCursor));
			const offset = start - session.logStartCursor;
			const output = session.logBuffer.slice(offset, offset + Math.max(1, Math.floor(maxChars)));
			return {
				process_id: session.id,
				process_name: session.name,
				cursor: start,
				next_cursor: start + output.length,
				output,
				truncated: cursor < session.logStartCursor,
				running: isRunning(session),
			};
		},
		wait: async (selector, pattern, timeoutMs = 10_000) => {
			const session = resolveSession(selector);
			if (!session) return undefined;
			const patternMatched = () => (pattern ? session.logBuffer.includes(pattern) : !isRunning(session));
			const completed = () => patternMatched() || !isRunning(session);
			if (completed()) {
				return { process: toRecord(session), matched: patternMatched(), timed_out: false };
			}
			await new Promise<void>((resolvePromise) => {
				const onWake = () => {
					if (!completed()) return;
					cleanup();
					resolvePromise();
				};
				const timeout = setTimeout(
					() => {
						cleanup();
						resolvePromise();
					},
					Math.max(1, timeoutMs),
				);
				const cleanup = () => {
					clearTimeout(timeout);
					session.listeners.delete(onWake);
				};
				session.listeners.add(onWake);
			});
			return { process: toRecord(session), matched: patternMatched(), timed_out: !completed() };
		},
		describe: (selector) => {
			const session = resolveSession(selector);
			return session ? toRecord(session) : undefined;
		},
		restart: async (selector) => {
			const session = resolveSession(selector);
			if (!session) return undefined;
			const input = { ...session.input, name: session.name, workdir: undefined, wait_for_exit: false };
			const cwd = session.cwd;
			if (isRunning(session)) {
				session.hidden = true;
				terminateSession(session);
				await waitForTerminal(session);
			}
			sessions.delete(session.id);
			notifySessionUpdate();
			return manager.exec(input, cwd);
		},
		signal: async (selector, signal) => {
			const session = resolveSession(selector);
			if (!session || !isRunning(session)) return false;
			if (signal === "INT" && session.interactive) {
				if (session.kind === "pty") await session.child.write("\u0003");
				else session.child.stdin.write("\u0003");
				return true;
			}
			if (signal !== "INT") session.pendingTerminalState = "cancelled";
			if (session.kind === "pty" && session.child.pid === undefined) {
				session.child.kill();
			} else {
				signalProcessTree(session.child.pid, session.kind === "pipe", `SIG${signal}` as NodeJS.Signals);
			}
			return true;
		},
		hasSession: (sessionId) => {
			const session = sessions.get(sessionId);
			return session !== undefined && !session.hidden;
		},
		getSessionCommand: (selector) =>
			resolveSession(selector)?.command ?? (typeof selector === "number" ? commandHistory.get(selector) : undefined),
		getSessionStdinOpen: (selector) => {
			const session = resolveSession(selector);
			return session && isRunning(session) ? session.interactive : undefined;
		},
		getSessionTty: (selector) =>
			resolveSession(selector)?.interactive ?? (typeof selector === "number" ? ttyHistory.get(selector) : undefined),
		getSessionSnapshot: (sessionId) => {
			const session = sessions.get(sessionId);
			if (!session) return undefined;
			const running = isRunning(session);
			const truncated = formattedTruncateText(session.buffer);
			return {
				command: session.command,
				name: session.name,
				output: truncated.output,
				running,
				exitCode: session.terminalState === "exited" ? (session.exitCode ?? 0) : undefined,
				terminalState: session.terminalState,
				timedOut: session.terminalState === "timed_out" ? true : undefined,
				cancelled: session.terminalState === "cancelled" ? true : undefined,
				sessionError: session.sessionError,
				stdinOpen: running ? session.interactive : undefined,
				tty: session.interactive,
				elapsedMs: Date.now() - session.startedAtMs,
				originalTokenCount: truncated.output_truncated ? approxTokenCount(session.buffer) : undefined,
				outputTruncated: truncated.output_truncated === true,
				captureOutput: session.captureBuffer,
				captureOutputTruncated: session.captureBufferTruncated,
			};
		},
		listSessions: () =>
			Array.from(sessions.values())
				.filter((session) => !session.hidden)
				.map(toRecord),
		stopSession: (selector) => {
			const session = resolveSession(selector);
			if (!session) return false;
			session.hidden = true;
			terminateSession(session);
			notifySessionUpdate();
			return true;
		},
		stopAllSessions: () => {
			let stopped = 0;
			for (const session of sessions.values()) {
				if (session.hidden) continue;
				session.hidden = true;
				terminateSession(session);
				stopped++;
			}
			if (stopped > 0) {
				notifySessionUpdate();
			}
			return stopped;
		},
		onSessionExit: (listener) => {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		onSessionUpdate: (listener) => {
			updateListeners.add(listener);
			return () => updateListeners.delete(listener);
		},
		shutdown: () => {
			for (const session of sessions.values()) {
				terminateSession(session);
			}
			const hadSessions = sessions.size > 0;
			sessions.clear();
			commandHistory.clear();
			ttyHistory.clear();
			if (hadSessions) {
				notifySessionUpdate();
			}
		},
	};
	return manager;
}
