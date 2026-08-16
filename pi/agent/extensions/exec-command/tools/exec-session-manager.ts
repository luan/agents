import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { approxTokenCount, capMiddleByBytes } from "../../shared/output-budget.ts";
import { mintQuietly } from "../../shared/tool-bounding.ts";
import { createIsolatedNodePtyBackend } from "../adapter/isolated-node-pty-backend.ts";
import type { PtyBackend, PtyProcess } from "../adapter/pty-backend.ts";
import { DEFAULT_EXEC_SHELL, isFishShell, resolveRuntimeShell } from "../adapter/runtime-shell.ts";
import {
	appendCaptureOutput,
	formattedTruncateText,
	resolveMaxOutputTokens,
	UNIFIED_EXEC_OUTPUT_MAX_BYTES,
	willElideMiddle,
} from "./output-truncation.ts";

type ExecTerminalState = "exited" | "cancelled" | "session_error";

export interface UnifiedExecResult {
	chunk_id: string;
	wall_time_seconds: number;
	output: string;
	exit_code?: number;
	terminal_state?: ExecTerminalState;
	cancelled?: boolean;
	session_error?: string;
	process_id?: number;
	process_name?: string;
	stdin_open?: boolean;
	/** Set by `write_stdin` when `until` was requested: whether the text arrived. */
	until_matched?: boolean;
	/** Set when a requested yield window was clamped. */
	notice?: string;
	original_token_count?: number;
	output_truncated?: boolean;
	/** Artifact holding every byte this process has produced. Present whenever a drain elided part of what it returned. */
	full_output_ref?: string;
	/** Bytes this drain cut out of `output`. They are in `full_output_ref`, not lost. */
	output_elided_bytes?: number;
	artifact_capture?: {
		artifact_id: string;
		byte_count: number;
		line_count: number;
		returned_bytes: number;
		omitted_bytes: number;
	};
	artifact_capture_failure?: string;
	artifact_capture_truncated?: boolean;
	capture_output?: string;
	capture_output_truncated?: boolean;
}

export type ProcessSelector = number | string;

interface ExecSessionSnapshot {
	command: string;
	name?: string;
	output: string;
	running: boolean;
	exitCode?: number;
	terminalState?: ExecTerminalState;
	cancelled?: boolean;
	sessionError?: string;
	stdinOpen?: boolean;
	tty: boolean;
	elapsedMs: number;
	originalTokenCount?: number;
	outputTruncated: boolean;
	captureOutput: string;
	captureOutputTruncated: boolean;
	/** The artifact a drain already filled for this process, so the exit capture replaces it instead of filing a second copy. */
	artifactUri?: string;
}

export interface ExecSessionRecord {
	id: number;
	name: string;
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

export interface ExecProcessSnapshot {
	id: number;
	name: string;
	command: string;
	cwd: string;
	ownerSessionId?: string;
	tty: boolean;
	stdinOpen: boolean;
	state: "running" | ExecTerminalState;
	exitCode?: number;
	startedAtMs: number;
	finishedAtMs?: number;
	output: string;
	outputTruncated: boolean;
}

export interface PtyDataEvent {
	processId: number;
	data: string;
}

export interface ExecCommandInput {
	cmd: string;
	name?: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	yield_time_ms?: number;
	max_output_tokens?: number;
	login?: boolean;
	ownerSessionId?: string;
}

export interface WriteStdinInput {
	process_id: ProcessSelector;
	chars?: string;
	/** Return as soon as this text appears in output produced after the write. */
	until?: string;
	yield_time_ms?: number;
	max_output_tokens?: number;
}

type ExecSessionUpdateCallback = (result: UnifiedExecResult) => void;

interface BaseExecSession {
	id: number;
	name: string;
	command: string;
	cwd: string;
	input: ExecCommandInput;
	buffer: string;
	pendingBuffer: string;
	emittedBuffer: string;
	captureBuffer: string;
	captureBufferTruncated: boolean;
	/** URI of the one artifact this process refills as it drains, minted the first time a drain would elide a middle. */
	artifactUri?: string;
	logBuffer: string;
	logStartCursor: number;
	logEndCursor: number;
	exitCode: number | null | undefined;
	terminalState: ExecTerminalState | undefined;
	pendingTerminalState: "cancelled" | undefined;
	sessionError: string | undefined;
	finalized: boolean;
	listeners: Set<() => void>;
	interactive: boolean;
	startedAtMs: number;
	finishedAtMs?: number;
	hidden: boolean;
	abortCleanup?: () => void;
	/** True before the first process-tree signal, so exit events cannot start a second cleanup. */
	processCleanupStarted: boolean;
	/** True while the `exec` call that created this session has not returned. `interruptForeground` targets exactly these. */
	foreground: boolean;
}

/** What is still known after `makeResult` deletes a drained session, so `write_stdin` can say more than `Unknown process id 30`. */
interface SessionHistory {
	command: string;
	name: string;
	tty: boolean;
	startedAtMs: number;
	finishedAtMs?: number;
	terminalState?: ExecTerminalState;
	exitCode?: number;
	sessionError?: string;
	/** Artifact holding the full drain, recorded by `recordSessionArtifact` after `captureExecResult`. */
	artifactId?: string;
	snapshot?: ExecProcessSnapshot;
}

interface PipeExecSession extends BaseExecSession {
	kind: "pipe";
	child: ChildProcessByStdio<null, Readable, Readable>;
}

interface PtyExecSession extends BaseExecSession {
	kind: "pty";
	child: PtyProcess;
	/**
	 * The terminal text as last reflected into `pendingBuffer`.
	 *
	 * Kept apart from `buffer` because `buffer` is display state that history
	 * trimming rewrites: a delta computed against a trimmed string cannot find
	 * its prefix and degrades to resending everything. See {@link computePtyDelta}.
	 */
	terminalRendered: string;
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
	interrupt(selector: ProcessSelector): Promise<boolean>;
	describe(selector: ProcessSelector): ExecSessionRecord | undefined;
	restart(selector: ProcessSelector): Promise<UnifiedExecResult | undefined>;
	hasSession(sessionId: number): boolean;
	getSessionCommand(selector: ProcessSelector): string | undefined;
	getSessionStdinOpen(selector: ProcessSelector): boolean | undefined;
	getSessionTty(selector: ProcessSelector): boolean | undefined;
	getSessionSnapshot(sessionId: number): ExecSessionSnapshot | undefined;
	listSessions(): ExecSessionRecord[];
	stopSession(selector: ProcessSelector): boolean;
	stopAllSessions(): number;
	/** Terminate every session whose `exec` has not returned. Kills by ownership, for callers that plumbed no `AbortSignal`. */
	interruptForeground(): number;
	/** Attach the drain artifact to a finished process so a later `write_stdin` can point at it. */
	recordSessionArtifact(sessionId: number, artifactId: string): void;
	onSessionExit(listener: (sessionId: number, command: string) => void): () => void;
	onSessionUpdate(listener: () => void): () => void;
	subscribeProcesses(listener: (snapshots: ExecProcessSnapshot[]) => void): () => void;
	onPtyData(listener: (event: PtyDataEvent) => void): () => void;
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
// Keep progress chunks 200ms apart in one response while returning promptly after the stream pauses.
const OUTPUT_IDLE_TIME_MS = 230;
const MAX_YIELD_TIME_MS = 120_000;
const MAX_COMMAND_HISTORY = 256;
const DEFAULT_MAX_SESSION_BUFFER_CHARS = UNIFIED_EXEC_OUTPUT_MAX_BYTES;
const PID_LIVENESS_POLL_MS = 250;
const LOST_PROCESS_ERROR = "process vanished before reporting an exit status";

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
	tty = false,
): { shell: string; command: string; env: NodeJS.ProcessEnv } {
	const shell = resolveShell(requestedShell);
	const env = withUnifiedExecEnvironment({ ...process.env }, tty);
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
	// An explicit zero is the describe-a-process call: take the current state and
	// return, without paying a floor the caller did not ask for.
	if (resolved <= 0) return 0;
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

/**
 * Writes return after their output settles. Pure reads stay attached until the process exits or the yield expires,
 * so one command does not become a chain of short polling results. yield-time_ms: 0 remains an immediate snapshot.
 */
export function clampedYieldNotice(requestedMs: number | undefined, resolvedMs: number): string | undefined {
	if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs) || requestedMs === resolvedMs) return undefined;
	return `yield-time_ms was clamped from ${requestedMs}ms to ${resolvedMs}ms.`;
}

function clampWriteYieldTime(
	yieldTimeMs: number | undefined,
	fallback: number,
	isPureRead: boolean,
	minEmptyWriteYieldTimeMs: number,
	minYieldTimeMs: number,
): number {
	const value = clampYieldTime(yieldTimeMs, fallback, minYieldTimeMs);
	if (!isPureRead || value === 0) return value;
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

function sanitizeBinaryOutput(text: string): string {
	let output = "";
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (char === "\u001b" && text[index + 1] === "[") {
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
	return compactSgrRuns(sanitizeBinaryOutput(stripTerminalControlSequences(text, false, true)))
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

/**
 * What changed on a PTY between two renders.
 *
 * `line-rewrite` is called out rather than folded into the text because a
 * repaint supersedes the repaint before it: a spinner that redraws its line
 * five hundred times between two polls is one line of information, and only the
 * caller knows whether the earlier frames are still pending.
 */
type PtyDelta = { kind: "append" | "line-rewrite"; text: string };

function computePtyDelta(previous: string, current: string): PtyDelta {
	if (current.startsWith(previous)) {
		return { kind: "append", text: current.slice(previous.length) };
	}

	const lineStart = previous.lastIndexOf("\n") + 1;
	const stablePrefix = previous.slice(0, lineStart);
	if (current.startsWith(stablePrefix)) {
		return { kind: "line-rewrite", text: `\r${current.slice(lineStart)}` };
	}

	// Committed history only ever grows and only ever from the tail, so a render
	// that shares no prefix with the last one means the two came from different
	// histories. Resending everything is the honest answer; keeping the invariant
	// so this never fires is the point of `terminalRendered`.
	return { kind: "append", text: current };
}

function appendPendingPtyDelta(session: PtyExecSession, delta: PtyDelta): void {
	// A rewrite carries the whole current line, and everything pending after the
	// last newline is that same line. Replacing the tail instead of appending is
	// what keeps a five-hundred-frame progress bar worth one line.
	if (delta.kind === "line-rewrite") {
		const tailStart = session.pendingBuffer.lastIndexOf("\n") + 1;
		session.pendingBuffer = `${session.pendingBuffer.slice(0, tailStart)}${delta.text}`;
		return;
	}
	session.pendingBuffer = capMiddleByBytes(`${session.pendingBuffer}${delta.text}`, UNIFIED_EXEC_OUTPUT_MAX_BYTES);
}

/**
 * Drop the oldest committed lines once the transcript outgrows its budget.
 *
 * The same prefix leaves `terminalRendered`, so the next delta still finds its
 * prefix. Trimming one of the two and not the other is what made every poll
 * after the first megabyte return the whole buffer.
 */
function capTerminalHistory(session: PtyExecSession, maxChars: number): void {
	const overflow = session.terminalCommitted.length - maxChars;
	if (overflow <= 0) return;
	const lineBreak = session.terminalCommitted.indexOf("\n", overflow);
	const dropped = lineBreak === -1 ? session.terminalCommitted.length : lineBreak + 1;
	session.terminalCommitted = session.terminalCommitted.slice(dropped);
	session.terminalRendered = session.terminalRendered.slice(dropped);
}

function generateChunkId(): string {
	return randomBytes(3).toString("hex");
}

/**
 * Take the output produced since the last drain, bounded to `maxOutputTokens`.
 *
 * Destructive on purpose: `pendingBuffer` is emptied so the next call reports what happened next, not what already
 * shipped. What the bound cuts out is therefore unreachable from a later drain, so `fullOutputRef` — the artifact
 * `refreshFullOutputRef` fills from `captureBuffer` before this runs — is the only route back to the middle.
 */
function consumeOutput(
	session: ExecSession,
	maxOutputTokens: number,
	fullOutputRef?: string,
): {
	output: string;
	original_token_count?: number;
	output_truncated?: boolean;
	elided_bytes?: number;
} {
	const text = session.pendingBuffer;
	session.pendingBuffer = "";
	session.emittedBuffer = session.buffer;
	if (text.length === 0) {
		return { output: "" };
	}

	return {
		...formattedTruncateText(text, maxOutputTokens, fullOutputRef),
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

function terminateProcessTree(rootPid: number | undefined, includeRootProcessGroup: boolean): void {
	if (rootPid === undefined || rootPid <= 0) return;
	if (process.platform === "win32") {
		try {
			execFileSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], { stdio: "ignore" });
		} catch {
			// The process tree already exited or taskkill could not signal it.
		}
		return;
	}
	const descendants = collectDescendantPids(rootPid);
	const targets = [...descendants.reverse(), rootPid];
	for (const pid of targets) {
		killPid(pid, "SIGTERM");
	}
	if (includeRootProcessGroup) {
		killPid(-rootPid, "SIGTERM");
	}
	for (const pid of targets) {
		killPid(pid, "SIGKILL");
	}
	if (includeRootProcessGroup) {
		killPid(-rootPid, "SIGKILL");
	}
}

function terminateRemainingDescendants(rootPid: number | undefined): void {
	if (rootPid === undefined || rootPid <= 0) return;
	if (process.platform === "win32") {
		terminateProcessTree(rootPid, false);
		return;
	}
	// The detached shell owns this process group. After its exit event, only descendants can remain in it.
	killPid(-rootPid, "SIGTERM");
	killPid(-rootPid, "SIGKILL");
}

export function createExecSessionManager(options: ExecSessionManagerOptions = {}): ExecSessionManager {
	let nextSessionId = 1;
	const sessions = new Map<number, ExecSession>();
	const reservedNames = new Set<string>();
	const history = new Map<number, SessionHistory>();
	const exitListeners = new Set<(sessionId: number, command: string) => void>();
	const updateListeners = new Set<() => void>();
	const processListeners = new Set<(snapshots: ExecProcessSnapshot[]) => void>();
	const ptyDataListeners = new Set<(event: PtyDataEvent) => void>();
	const ptyBackend = options.ptyBackend ?? createIsolatedNodePtyBackend();
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

	function rememberCommand(session: ExecSession): void {
		history.set(session.id, {
			command: session.command,
			name: session.name,
			tty: session.interactive,
			startedAtMs: session.startedAtMs,
		});
		if (history.size <= MAX_COMMAND_HISTORY) {
			return;
		}
		const oldest = history.keys().next().value;
		if (oldest !== undefined) history.delete(oldest);
	}

	function rememberOutcome(session: ExecSession): void {
		const entry = history.get(session.id);
		if (!entry) return;
		entry.finishedAtMs = session.finishedAtMs ?? Date.now();
		entry.terminalState = session.terminalState;
		entry.exitCode = session.exitCode ?? undefined;
		entry.sessionError = session.sessionError;
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
		const snapshots = processSnapshots();
		for (const listener of processListeners) {
			listener(snapshots);
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

	/** Why a `write_stdin` to a vanished id failed, stated so the caller can tell a typo from a finished job. */
	function unreachableProcessMessage(selector: ProcessSelector): string {
		const entry = typeof selector === "number" ? history.get(selector) : findHistoryByName(selector);
		if (!entry) {
			return typeof selector === "number"
				? `Unknown process id ${selector}: no process with that id has run in this session. Use the process_id exec_command returned.`
				: `Unknown process "${selector}": no process has that name in this session. Use the process_id exec_command returned.`;
		}
		const id = typeof selector === "number" ? selector : entry.name;
		return `Process ${id} is gone, so write_stdin cannot reach it. ${describeOutcome(entry)} ${describeArtifact(entry)}`;
	}

	function findHistoryByName(name: string): SessionHistory | undefined {
		for (const entry of history.values()) if (entry.name === name) return entry;
		return undefined;
	}

	function describeOutcome(entry: SessionHistory): string {
		const command = `\`${entry.command}\``;
		const ran = entry.finishedAtMs ? ` after ${formatSeconds(entry.finishedAtMs - entry.startedAtMs)}` : "";
		const ago = entry.finishedAtMs ? `, ${formatSeconds(Date.now() - entry.finishedAtMs)} ago` : "";
		if (entry.terminalState === "cancelled") return `${command} was killed by pi${ran}${ago}.`;
		if (entry.terminalState === "session_error") {
			return `${command} ended with a session error${ran}${ago}: ${entry.sessionError ?? "cause not recorded"}.`;
		}
		if (entry.terminalState === "exited") return `${command} exited with code ${entry.exitCode ?? 0}${ran}${ago}.`;
		return `${command} was started${ran}${ago} and its session was dropped before it reported an exit.`;
	}

	function describeArtifact(entry: SessionHistory): string {
		return entry.artifactId
			? `Its full output is at artifact://${entry.artifactId} — read it with read({path: "artifact://${entry.artifactId}"}).`
			: "Its output was returned by the call that drained it and is not stored in an artifact.";
	}

	function formatSeconds(ms: number): string {
		return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
	}

	function toRecord(session: ExecSession): ExecSessionRecord {
		const running = isRunning(session);
		return {
			id: session.id,
			name: session.name,
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

	function toProcessSnapshot(session: ExecSession): ExecProcessSnapshot {
		const running = isRunning(session);
		return {
			id: session.id,
			name: session.name,
			command: session.command,
			cwd: session.cwd,
			ownerSessionId: session.input.ownerSessionId,
			tty: session.kind === "pty",
			stdinOpen: running && session.interactive,
			state: running ? "running" : (session.terminalState ?? "exited"),
			exitCode: session.terminalState === "exited" ? (session.exitCode ?? 0) : undefined,
			startedAtMs: session.startedAtMs,
			finishedAtMs: session.finishedAtMs,
			output: session.captureBuffer,
			outputTruncated: session.captureBufferTruncated,
		};
	}

	function processSnapshots(): ExecProcessSnapshot[] {
		const active = Array.from(sessions.values())
			.filter((session) => !session.hidden)
			.map(toProcessSnapshot);
		const retained = Array.from(history.values())
			.map((entry) => entry.snapshot)
			.filter((snapshot): snapshot is ExecProcessSnapshot => snapshot !== undefined);
		return [...retained, ...active];
	}

	function deleteSession(sessionId: number): boolean {
		const session = sessions.get(sessionId);
		if (!session) return false;
		const entry = history.get(sessionId);
		if (entry) entry.snapshot = toProcessSnapshot(session);
		sessions.delete(sessionId);
		notifySessionUpdate();
		return true;
	}

	function deleteExitedSessions(): void {
		for (const [sessionId, session] of sessions) {
			if (!isRunning(session) && session.emittedBuffer === session.buffer) deleteSession(sessionId);
		}
	}

	function terminateSession(session: ExecSession): void {
		if (!isRunning(session)) return;
		session.abortCleanup?.();
		session.abortCleanup = undefined;
		session.pendingTerminalState = "cancelled";
		if (session.processCleanupStarted) return;
		session.processCleanupStarted = true;
		if (session.kind === "pty") {
			session.child.kill();
		} else {
			terminateProcessTree(session.child.pid, true);
		}
	}

	function finalizeSession(session: ExecSession): void {
		if (session.finalized) return;
		session.finalized = true;
		session.finishedAtMs = Date.now();
		rememberOutcome(session);
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
		session.terminalState = terminalState;
		session.exitCode = terminalState === "exited" ? (exitCode ?? 0) : undefined;
		session.sessionError = sessionError;
		finalizeSession(session);
	}

	function addTerminalState(result: UnifiedExecResult, session: ExecSession): void {
		if (session.terminalState === undefined) return;
		result.terminal_state = session.terminalState;
		if (session.terminalState === "exited") result.exit_code = session.exitCode ?? 0;
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
		if (session.kind === "pty") {
			const rendered = applyTerminalOutput(session, text);
			const delta = computePtyDelta(session.terminalRendered, rendered);
			session.terminalRendered = rendered;
			const captured = appendCaptureOutput(session.captureBuffer, delta.text);
			session.captureBuffer = captured.output;
			session.captureBufferTruncated ||= captured.truncated;
			appendPendingPtyDelta(session, delta);
			capTerminalHistory(session, maxSessionBufferChars);
			session.buffer = session.terminalRendered;
		} else {
			const normalized = normalizePipeOutput(text);
			const captured = appendCaptureOutput(session.captureBuffer, normalized);
			session.captureBuffer = captured.output;
			session.captureBufferTruncated ||= captured.truncated;
			session.buffer = `${session.buffer}${normalized}`;
			session.pendingBuffer = capMiddleByBytes(
				`${session.pendingBuffer}${normalized}`,
				UNIFIED_EXEC_OUTPUT_MAX_BYTES,
			);
			if (session.buffer.length > maxSessionBufferChars) {
				session.buffer = capMiddleByBytes(session.buffer, maxSessionBufferChars);
				session.emittedBuffer = "";
			}
		}
		notify(session);
	}

	/**
	 * Wait until the session exits, `ready` becomes true, or the yield expires.
	 *
	 * `ready` rides the same listener set the caller already wakes on, so an
	 * `until` pattern costs nothing beyond the substring test it performs.
	 */
	function waitForYield(
		session: ExecSession,
		yieldTimeMs: number,
		ready?: () => boolean,
		wakeOnIdle = true,
	): Promise<number> {
		const settled = () => !isRunning(session) || ready?.() === true;
		if (settled()) return Promise.resolve(0);

		const startedAt = Date.now();
		return new Promise((resolvePromise) => {
			let idleTimeout: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				clearTimeout(timeout);
				if (idleTimeout) clearTimeout(idleTimeout);
				session.listeners.delete(onWake);
			};
			const finish = () => {
				cleanup();
				resolvePromise(Date.now() - startedAt);
			};
			const onWake = () => {
				if (settled()) {
					finish();
					return;
				}
				if (ready || yieldTimeMs === 0 || !wakeOnIdle) return;
				if (idleTimeout) clearTimeout(idleTimeout);
				idleTimeout = setTimeout(finish, OUTPUT_IDLE_TIME_MS);
			};
			const timeout = setTimeout(finish, yieldTimeMs);
			session.listeners.add(onWake);
		});
	}

	/**
	 * Refill this process's artifact before a drain cuts a middle out of the same bytes.
	 *
	 * One artifact per process, replaced in place, so a chatty job files one growing log rather than one per poll.
	 * Runs only when the drain is about to elide, so an ordinary small result pays nothing.
	 */
	async function refreshFullOutputRef(session: ExecSession, maxOutputTokens: number): Promise<string | undefined> {
		if (!willElideMiddle(session.pendingBuffer, maxOutputTokens)) return session.artifactUri;
		if (session.captureBuffer.length === 0) return session.artifactUri;
		const uri = await mintQuietly(
			session.captureBuffer,
			session.name,
			session.artifactUri,
			session.input.ownerSessionId,
		);
		if (uri) {
			session.artifactUri = uri;
			const entry = history.get(session.id);
			if (entry) entry.artifactId = /^artifact:\/\/(.+)$/.exec(uri)?.[1] ?? entry.artifactId;
		}
		return session.artifactUri;
	}

	function makeResult(
		session: ExecSession,
		waitMs: number,
		maxOutputTokens: number,
		fullOutputRef?: string,
	): UnifiedExecResult {
		const consumed = consumeOutput(session, maxOutputTokens, fullOutputRef);
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
			// Carried on the result, not only inside the elision marker: a caller that reads `details` and never parses
			// the text still gets the pointer. Models copy what a tool hands back, not what it describes.
			if (fullOutputRef) result.full_output_ref = fullOutputRef;
			if (consumed.elided_bytes) result.output_elided_bytes = consumed.elided_bytes;
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
		const execution = resolveExecution(input.shell, input.cmd, input.tty === true);
		const shellArgs = login ? ["-lc", execution.command] : ["-c", execution.command];
		const child = spawn(shell, shellArgs, {
			cwd: workdir,
			stdio: ["ignore", "pipe", "pipe"],
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
			processCleanupStarted: false,
			foreground: true,
		};

		child.stdout.on("data", (data: Buffer) => {
			appendOutput(session, data.toString("utf8"));
		});
		child.stderr.on("data", (data: Buffer) => {
			appendOutput(session, data.toString("utf8"));
		});
		child.once("exit", () => {
			if (session.processCleanupStarted) return;
			session.processCleanupStarted = true;
			terminateRemainingDescendants(child.pid);
		});
		child.on("close", (code) => {
			completeSession(session, session.pendingTerminalState ?? "exited", code ?? 0);
		});
		child.on("error", (error) => {
			appendOutput(session, `${error.message}\n`);
			completeSession(session, "session_error", undefined, error.message);
		});

		// Under heavy process churn the runtime sometimes never reports this child's exit, which
		// would leave the session running forever and block every caller waiting on it. The pid is
		// the ground truth, so reap the session once it is gone. One grace tick after the pid
		// disappears lets a genuinely pending "close" (and its buffered output) win the race.
		// Without a recorded exit code the outcome is unknown, and reporting an unobserved
		// success would let a caller trust a command that may never have run.
		let pidGoneTicks = 0;
		const livenessPoll = setInterval(() => {
			if (!isRunning(session)) {
				clearInterval(livenessPoll);
				return;
			}
			if (child.pid === undefined) return;
			try {
				process.kill(child.pid, 0);
				pidGoneTicks = 0;
				return;
			} catch {
				pidGoneTicks++;
			}
			if (pidGoneTicks < 2) return;
			clearInterval(livenessPoll);
			if (child.exitCode === null) {
				completeSession(session, "session_error", undefined, LOST_PROCESS_ERROR);
				return;
			}
			completeSession(session, session.pendingTerminalState ?? "exited", child.exitCode);
		}, PID_LIVENESS_POLL_MS);
		livenessPoll.unref?.();

		session.abortCleanup = registerAbortHandler(signal, () => {
			terminateSession(session);
		});

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
		const execution = resolveExecution(input.shell, input.cmd, true);
		const shellArgs = login ? ["-lc", execution.command] : ["-c", execution.command];
		const child = await ptyBackend.spawn(shell, shellArgs, {
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
			processCleanupStarted: false,
			foreground: true,
			terminalRendered: "",
			terminalCommitted: "",
			terminalLine: [],
			terminalCursor: 0,
			terminalStyle: "",
			terminalPendingEscape: "",
		};

		child.onData((data) => {
			const event = { processId: session.id, data };
			for (const listener of ptyDataListeners) listener(event);
			appendOutput(session, data);
		});
		child.onExit(({ exitCode, sessionError }) => {
			if (sessionError) {
				completeSession(session, "session_error", undefined, sessionError);
				return;
			}
			completeSession(session, session.pendingTerminalState ?? "exited", exitCode ?? 0);
		});

		session.abortCleanup = registerAbortHandler(signal, () => {
			terminateSession(session);
		});

		return session;
	}

	async function waitForTerminal(session: ExecSession): Promise<number> {
		const startedAt = Date.now();
		while (isRunning(session)) {
			await waitForYield(session, 1_000);
		}
		return Date.now() - startedAt;
	}

	/** Text logged after `cursor`, the watermark an `until` match is tested against. */
	function logSince(session: ExecSession, cursor: number): string {
		return session.logBuffer.slice(Math.max(0, cursor - session.logStartCursor));
	}

	const manager: ExecSessionManager = {
		exec: async (input, cwd, signal, onUpdate) => {
			deleteExitedSessions();
			let reservedName: string | undefined;
			if (input.name) {
				const name = processName(input.name, nextSessionId);
				if (nameInUse(name)) throw new Error(`Process name already exists: ${name}`);
				input = { ...input, name };
				reservedName = name;
				reservedNames.add(name);
			}
			const shell = resolveShell(input.shell);
			const workdir = resolveWorkdir(cwd, input.workdir);
			let session: ExecSession;
			try {
				session = input.tty
					? await createPtySession(input, workdir, shell, signal)
					: createPipeSession(input, workdir, shell, signal);
			} finally {
				if (reservedName) reservedNames.delete(reservedName);
			}
			sessions.set(session.id, session);
			rememberCommand(session);
			notifySessionUpdate();
			const stopStreaming = streamSessionUpdates(session, onUpdate);

			try {
				const resolvedYieldMs = clampExecYieldTime(
					input.yield_time_ms,
					defaultExecYieldTimeMs,
					session.interactive,
					minNonInteractiveExecYieldTimeMs,
					minYieldTimeMs,
				);
				const waitedMs = await waitForYield(session, resolvedYieldMs, undefined, false);
				const maxOutputTokens = resolveMaxOutputTokens(input.max_output_tokens);
				const result = makeResult(
					session,
					waitedMs,
					maxOutputTokens,
					await refreshFullOutputRef(session, maxOutputTokens),
				);
				const clamped = clampedYieldNotice(input.yield_time_ms, resolvedYieldMs);
				if (clamped) result.notice = clamped;
				return result;
			} finally {
				session.foreground = false;
				stopStreaming?.();
			}
		},
		write: async (input) => {
			const session = resolveSession(input.process_id);
			if (!session) throw new Error(unreachableProcessMessage(input.process_id));
			// The watermark is taken before the write, so `until` tests only what
			// this call provoked. Matching whole history would return instantly on
			// any pattern the session had already printed once.
			const watermark = session.logEndCursor;
			const until = input.until;
			if (input.chars && input.chars.length > 0) {
				// `createPipeSession` gives a non-tty child `stdio[0]: "ignore"`; no pipe exists and none
				// can be attached later, so naming `tty=true` alone described a call already made.
				if (!session.interactive || session.kind !== "pty") {
					throw new Error(
						`Process ${session.id} has no stdin. exec_command opens stdin only when tty=true, and it cannot be opened after the process starts. Drop \`chars\` to drain or wait on this process, or start a new exec_command with tty=true for work that needs input.`,
					);
				}
				await session.child.write(input.chars);
			}
			const matched = () => (until === undefined ? false : logSince(session, watermark).includes(until));
			const pureRead = !input.chars || input.chars.length === 0;
			const resolvedYieldMs = clampWriteYieldTime(
				input.yield_time_ms,
				defaultWriteYieldTimeMs,
				pureRead,
				minEmptyWriteYieldTimeMs,
				minYieldTimeMs,
			);
			const ready = until === undefined ? undefined : matched;
			const waitedMs = isRunning(session) ? await waitForYield(session, resolvedYieldMs, ready, !pureRead) : 0;
			const maxOutputTokens = resolveMaxOutputTokens(input.max_output_tokens);
			const result = makeResult(
				session,
				waitedMs,
				maxOutputTokens,
				await refreshFullOutputRef(session, maxOutputTokens),
			);
			if (until !== undefined) result.until_matched = matched();
			const clamped = clampedYieldNotice(input.yield_time_ms, resolvedYieldMs);
			if (clamped) result.notice = clamped;
			return result;
		},
		resize: async (selector, cols, rows) => {
			const session = resolveSession(selector);
			if (!session || !isRunning(session) || session.kind !== "pty") return false;
			await session.child.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
			return true;
		},
		interrupt: async (selector) => {
			const session = resolveSession(selector);
			if (!session || !isRunning(session)) return false;
			if (session.kind === "pty") {
				await session.child.write("\u0003");
				return true;
			}
			if (session.child.pid === undefined) return false;
			killPid(process.platform === "win32" ? session.child.pid : -session.child.pid, "SIGINT");
			return true;
		},
		describe: (selector) => {
			const session = resolveSession(selector);
			return session ? toRecord(session) : undefined;
		},
		restart: async (selector) => {
			const session = resolveSession(selector);
			if (!session) return undefined;
			const input = { ...session.input, name: session.name, workdir: undefined };
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
		hasSession: (sessionId) => {
			const session = sessions.get(sessionId);
			return session !== undefined && !session.hidden;
		},
		getSessionCommand: (selector) =>
			resolveSession(selector)?.command ??
			(typeof selector === "number" ? history.get(selector)?.command : undefined),
		getSessionStdinOpen: (selector) => {
			const session = resolveSession(selector);
			return session && isRunning(session) ? session.interactive : undefined;
		},
		getSessionTty: (selector) =>
			resolveSession(selector)?.interactive ??
			(typeof selector === "number" ? history.get(selector)?.tty : undefined),
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
				cancelled: session.terminalState === "cancelled" ? true : undefined,
				sessionError: session.sessionError,
				stdinOpen: running ? session.interactive : undefined,
				tty: session.interactive,
				elapsedMs: Date.now() - session.startedAtMs,
				originalTokenCount: truncated.output_truncated ? approxTokenCount(session.buffer) : undefined,
				outputTruncated: truncated.output_truncated === true,
				captureOutput: session.captureBuffer,
				captureOutputTruncated: session.captureBufferTruncated,
				artifactUri: session.artifactUri,
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
		interruptForeground: () => {
			let stopped = 0;
			for (const session of sessions.values()) {
				if (!session.foreground || !isRunning(session)) continue;
				terminateSession(session);
				stopped++;
			}
			if (stopped > 0) notifySessionUpdate();
			return stopped;
		},
		recordSessionArtifact: (sessionId, artifactId) => {
			const entry = history.get(sessionId);
			if (entry) entry.artifactId = artifactId;
		},
		onSessionExit: (listener) => {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		onSessionUpdate: (listener) => {
			updateListeners.add(listener);
			return () => updateListeners.delete(listener);
		},
		subscribeProcesses: (listener) => {
			processListeners.add(listener);
			listener(processSnapshots());
			return () => processListeners.delete(listener);
		},
		onPtyData: (listener) => {
			ptyDataListeners.add(listener);
			return () => ptyDataListeners.delete(listener);
		},
		shutdown: () => {
			for (const session of sessions.values()) {
				terminateSession(session);
			}
			const hadProcesses =
				sessions.size > 0 || Array.from(history.values()).some((entry) => entry.snapshot !== undefined);
			sessions.clear();
			history.clear();
			if (hadProcesses) {
				notifySessionUpdate();
			}
		},
	};
	return manager;
}
