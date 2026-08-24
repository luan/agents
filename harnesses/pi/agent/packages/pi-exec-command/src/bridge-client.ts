import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

interface BridgeResponse<T> {
	request_id: number;
	ok: boolean;
	result?: T;
	error?: string;
}

export interface BridgeReadResponse {
	chunks: Array<{ seq: number; stream: "stdout" | "stderr" | "pty"; chunk: string }>;
	nextSeq: number;
	exited: boolean;
	exitCode?: number | null;
	closed: boolean;
	failure?: string | null;
}

export interface ExecBridgeClient {
	request<T>(request: Record<string, unknown>): Promise<T>;
	shutdown(): Promise<void>;
}

export function createExecBridgeClient(binaryPath: () => string): ExecBridgeClient {
	let child: ChildProcessWithoutNullStreams | undefined;
	let nextRequestId = 1;
	let lineBuffer = "";
	let stderr = "";
	let closed = false;
	let decoder = new StringDecoder("utf8");
	const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

	function rejectAll(error: Error): void {
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	}

	function getChild(): ChildProcessWithoutNullStreams {
		if (closed) throw new Error("exec_command_bridge is shut down");
		if (child && child.exitCode === null && child.signalCode === null) return child;
		const binary = binaryPath();
		lineBuffer = "";
		stderr = "";
		decoder = new StringDecoder("utf8");
		child = spawn(binary, [], { stdio: "pipe", env: process.env });
		child.stdout.on("data", (data: Buffer) => {
			lineBuffer += decoder.write(data);
			for (;;) {
				const newline = lineBuffer.indexOf("\n");
				if (newline === -1) break;
				const line = lineBuffer.slice(0, newline).trim();
				lineBuffer = lineBuffer.slice(newline + 1);
				if (!line) continue;
				let response: BridgeResponse<unknown>;
				try {
					response = JSON.parse(line) as BridgeResponse<unknown>;
				} catch {
					continue;
				}
				const request = pending.get(response.request_id);
				if (!request) continue;
				pending.delete(response.request_id);
				if (response.ok) request.resolve(response.result);
				else request.reject(new Error(response.error ?? "exec_command_bridge request failed"));
			}
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr = `${stderr}${data.toString("utf8")}`.slice(-16_000);
		});
		child.on("error", (error) => rejectAll(error));
		child.on("close", (code, signal) => {
			const status = code === null ? `signal ${signal}` : `code ${code}`;
			rejectAll(new Error(`exec_command_bridge exited (${status})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
			child = undefined;
		});
		return child;
	}

	async function request<T>(value: Record<string, unknown>): Promise<T> {
		const requestId = nextRequestId++;
		const bridge = getChild();
		return new Promise<T>((resolve, reject) => {
			pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
			bridge.stdin.write(`${JSON.stringify({ ...value, request_id: requestId })}\n`, (error) => {
				if (!error) return;
				pending.delete(requestId);
				reject(error);
			});
		});
	}

	return {
		request,
		async shutdown() {
			if (closed) return;
			const bridge = child;
			if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
				await request<{ shutdown: boolean }>({ op: "shutdown" }).catch(() => undefined);
			}
			closed = true;
			if (bridge && bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
			rejectAll(new Error("exec_command_bridge is shut down"));
		},
	};
}
