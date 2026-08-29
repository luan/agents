import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

interface BridgeResponse<T> {
	request_id: number;
	ok: boolean;
	result?: T;
	error?: string;
}

// type-boundary: native bridge stdout is untrusted JSON; this parser validates the response envelope before dispatch.
type BridgeResponseBoundary = unknown;

function parseBridgeResponse(line: string): BridgeResponse<unknown> | undefined {
	let value: BridgeResponseBoundary;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<BridgeResponse<unknown>>;
	if (!Number.isSafeInteger(candidate.request_id) || typeof candidate.ok !== "boolean") return undefined;
	if (candidate.ok === false && candidate.error !== undefined && typeof candidate.error !== "string") return undefined;
	return candidate as BridgeResponse<unknown>;
}

export interface TerminalBridgeReadResponse {
	chunks: Array<{ startSeq?: number; seq: number; stream: "stdout" | "stderr" | "pty"; bytes: Uint8Array }>;
	nextSeq: number;
	more?: boolean;
	exited: boolean;
	exitCode?: number | null;
	closed: boolean;
	failure?: string | null;
}

// type-boundary: native bridge result payloads are untrusted JSON; validate read results before consumers reduce them.
type TerminalBridgeReadBoundary = unknown;

const BASE64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/;

export function parseTerminalBridgeReadResponse(
	value: TerminalBridgeReadBoundary,
	expectedNextSeq?: number,
): TerminalBridgeReadResponse | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<Record<keyof TerminalBridgeReadResponse, unknown>>;
	if (!Array.isArray(candidate.chunks) || !Number.isSafeInteger(candidate.nextSeq) || Number(candidate.nextSeq) < 1)
		return undefined;
	if (typeof candidate.exited !== "boolean" || typeof candidate.closed !== "boolean") return undefined;
	if (candidate.more !== undefined && typeof candidate.more !== "boolean") return undefined;
	if (candidate.exitCode !== undefined && candidate.exitCode !== null && !Number.isSafeInteger(candidate.exitCode))
		return undefined;
	if (candidate.failure !== undefined && candidate.failure !== null && typeof candidate.failure !== "string")
		return undefined;
	const chunks: TerminalBridgeReadResponse["chunks"] = [];
	let previousSeq = 0;
	for (const value of candidate.chunks) {
		if (!value || typeof value !== "object") return undefined;
		const chunk = value as Partial<{
			startSeq: number;
			seq: number;
			stream: "stdout" | "stderr" | "pty";
			chunk: string;
		}>;
		const seq = Number(chunk.seq);
		const startSeq = chunk.startSeq === undefined ? seq : Number(chunk.startSeq);
		if (
			!Number.isSafeInteger(chunk.seq) ||
			seq < 1 ||
			!Number.isSafeInteger(startSeq) ||
			startSeq < 1 ||
			startSeq > seq
		)
			return undefined;
		if (previousSeq > 0 && startSeq !== previousSeq + 1) return undefined;
		if (chunk.stream !== "stdout" && chunk.stream !== "stderr" && chunk.stream !== "pty") return undefined;
		const bytes = decodeBase64(chunk.chunk);
		if (!bytes) return undefined;
		previousSeq = seq;
		chunks.push({ startSeq, seq: previousSeq, stream: chunk.stream, bytes });
	}
	if (chunks.length > 0 && candidate.nextSeq !== previousSeq + 1) return undefined;
	const first = chunks[0];
	if (expectedNextSeq !== undefined && (first ? (first.startSeq ?? first.seq) : candidate.nextSeq) !== expectedNextSeq)
		return undefined;
	return {
		chunks,
		nextSeq: Number(candidate.nextSeq),
		...(typeof candidate.more === "boolean" ? { more: candidate.more } : {}),
		exited: candidate.exited,
		...(typeof candidate.exitCode === "number" || candidate.exitCode === null ? { exitCode: candidate.exitCode } : {}),
		closed: candidate.closed,
		...(typeof candidate.failure === "string" || candidate.failure === null ? { failure: candidate.failure } : {}),
	};
}

function decodeBase64(value: unknown): Uint8Array | undefined {
	return typeof value === "string" && BASE64.test(value) ? Buffer.from(value, "base64") : undefined;
}

export interface TerminalBridgeClient {
	request<T>(request: Record<string, unknown>): Promise<T>;
	shutdown(): Promise<void>;
}

export interface TerminalBridgeClientDependencies {
	readonly binaryPath: () => string;
	readonly spawnBridge: (binaryPath: string) => ChildProcessWithoutNullStreams;
}

const BRIDGE_SHUTDOWN_GRACE_MS = 1_000;

/** Multiplex JSON-line requests over one shared native bridge process. */
export function createTerminalBridgeClient({
	binaryPath,
	spawnBridge,
}: TerminalBridgeClientDependencies): TerminalBridgeClient {
	let child: ChildProcessWithoutNullStreams | undefined;
	let nextRequestId = 1;
	let closed = false;
	let shutdownPromise: Promise<void> | undefined;
	const pending = new Map<
		number,
		{ readonly owner: ChildProcessWithoutNullStreams; resolve(value: unknown): void; reject(error: Error): void }
	>();

	function rejectPending(error: Error, owner?: ChildProcessWithoutNullStreams): void {
		for (const [requestId, request] of pending) {
			if (owner && request.owner !== owner) continue;
			pending.delete(requestId);
			request.reject(error);
		}
	}

	function fail(owner: ChildProcessWithoutNullStreams, error: Error): void {
		if (child === owner) child = undefined;
		rejectPending(error, owner);
		if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
	}

	function getChild(): ChildProcessWithoutNullStreams {
		if (closed) throw new Error("terminal bridge is shut down");
		if (child && child.exitCode === null && child.signalCode === null) return child;
		const binary = binaryPath();
		let lineBuffer = "";
		let stderr = "";
		const decoder = new StringDecoder("utf8");
		const spawned = spawnBridge(binary);
		child = spawned;
		spawned.stdout.on("data", (data: Buffer) => {
			lineBuffer += decoder.write(data);
			for (;;) {
				const newline = lineBuffer.indexOf("\n");
				if (newline === -1) break;
				const line = lineBuffer.slice(0, newline).trim();
				lineBuffer = lineBuffer.slice(newline + 1);
				if (!line) continue;
				const response = parseBridgeResponse(line);
				if (!response) {
					fail(spawned, new Error("terminal bridge emitted an invalid response"));
					return;
				}
				const request = pending.get(response.request_id);
				if (!request || request.owner !== spawned) {
					fail(spawned, new Error(`terminal bridge responded to unknown request ${response.request_id}`));
					return;
				}
				pending.delete(response.request_id);
				if (response.ok) request.resolve(response.result);
				else request.reject(new Error(response.error ?? "terminal bridge request failed"));
			}
		});
		spawned.stderr.on("data", (data: Buffer) => {
			stderr = `${stderr}${data.toString("utf8")}`.slice(-16_000);
		});
		spawned.on("error", (error) => fail(spawned, error));
		spawned.on("close", (code, signal) => {
			const status = code === null ? `signal ${signal}` : `code ${code}`;
			rejectPending(
				new Error(`terminal bridge exited (${status})${stderr.trim() ? `: ${stderr.trim()}` : ""}`),
				spawned,
			);
			if (child === spawned) child = undefined;
		});
		return spawned;
	}

	async function request<T>(value: Record<string, unknown>): Promise<T> {
		const requestId = nextRequestId++;
		const bridge = getChild();
		return new Promise<T>((resolve, reject) => {
			pending.set(requestId, { owner: bridge, resolve: resolve as (value: unknown) => void, reject });
			const rejectWrite = (error: Error): void => {
				pending.delete(requestId);
				reject(error);
			};
			try {
				bridge.stdin.write(`${JSON.stringify({ ...value, request_id: requestId })}\n`, (error) => {
					if (error) rejectWrite(error);
				});
			} catch (error) {
				rejectWrite(error instanceof Error ? error : new Error("terminal bridge write failed"));
			}
		});
	}

	return {
		request,
		shutdown() {
			if (shutdownPromise) return shutdownPromise;
			shutdownPromise = (async () => {
				const bridge = child;
				const wasRunning = bridge && bridge.exitCode === null && bridge.signalCode === null;
				const exited = wasRunning
					? new Promise<void>((resolve) => bridge.once("close", () => resolve()))
					: Promise.resolve();
				const graceful = wasRunning
					? request<{ shutdown: boolean }>({ op: "shutdown" }).catch(() => undefined)
					: Promise.resolve();
				const deadline = wasRunning
					? setTimeout(() => {
							if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
						}, BRIDGE_SHUTDOWN_GRACE_MS)
					: undefined;
				deadline?.unref();
				closed = true;
				try {
					await graceful;
				} finally {
					if (deadline) clearTimeout(deadline);
					if (bridge && bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
					rejectPending(new Error("terminal bridge is shut down"));
					await exited;
				}
			})();
			return shutdownPromise;
		},
	};
}
