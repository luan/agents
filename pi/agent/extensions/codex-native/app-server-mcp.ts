import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { LocalMcpApproval, LocalMcpTool } from "./local-mcp";

type CodexAppServerConfig = {
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
};

type AppServerMessage = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { message?: string };
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

export class CodexAppServerMcpClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private nextId = 1;
	private initialized: Promise<void> | undefined;
	private threadId: string | undefined;
	private readonly pending = new Map<number, PendingRequest>();
	private approval: LocalMcpApproval = async () => false;

	constructor(
		private readonly serverName: string,
		private readonly config: CodexAppServerConfig,
	) {}

	async listTools(): Promise<LocalMcpTool[]> {
		await this.ensureInitialized();
		const response = await this.request("mcpServerStatus/list", {
			threadId: this.threadId,
			detail: "full",
		});
		const status = isRecord(response)
			? asArray(response.data).find((entry) => isRecord(entry) && entry.name === this.serverName)
			: undefined;
		if (!isRecord(status) || !isRecord(status.tools)) return [];
		return Object.values(status.tools).filter(isLocalMcpTool);
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		approval?: LocalMcpApproval,
	): Promise<unknown> {
		await this.ensureInitialized();
		this.approval = approval ?? (async () => false);
		try {
			return await this.request(
				"mcpServer/tool/call",
				{
					threadId: this.threadId,
					server: this.serverName,
					tool: name,
					arguments: args,
				},
				signal,
			);
		} finally {
			this.approval = async () => false;
		}
	}

	close(): void {
		this.child?.kill();
		this.child = undefined;
		this.initialized = undefined;
		this.threadId = undefined;
		const error = new Error("Codex app-server MCP client closed");
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			this.initialized = this.start().catch((error) => {
				this.initialized = undefined;
				this.close();
				throw error;
			});
		}
		await this.initialized;
	}

	private async start(): Promise<void> {
		this.child = spawn(this.config.command, this.config.args, {
			env: { ...process.env, ...this.config.env },
			cwd: this.config.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stderr.resume();
		this.child.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk.toString()));
		this.child.on("error", (error) => this.failPending(error));
		this.child.on("exit", (code, signal) => {
			this.child = undefined;
			this.initialized = undefined;
			this.threadId = undefined;
			this.failPending(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
		});
		await this.request("initialize", {
			clientInfo: { name: "pi-codex-native", title: "Pi Codex Native", version: "0" },
			capabilities: {
				experimentalApi: true,
				requestAttestation: false,
				mcpServerOpenaiFormElicitation: true,
			},
		});
		const started = await this.request("thread/start", {
			cwd: this.config.cwd,
			ephemeral: true,
			approvalPolicy: "never",
			sandbox: "danger-full-access",
		});
		const thread = isRecord(started) && isRecord(started.thread) ? started.thread : undefined;
		if (!thread || typeof thread.id !== "string") throw new Error("Codex app-server returned an invalid thread");
		this.threadId = thread.id;
	}

	private request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex app-server is unavailable"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(id);
				reject(new Error("Codex app-server request aborted"));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.child?.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			let message: AppServerMessage;
			try {
				message = JSON.parse(line) as AppServerMessage;
			} catch {
				continue;
			}
			if (message.method && typeof message.id === "number") {
				void this.handleServerRequest(message);
				continue;
			}
			if (typeof message.id !== "number") continue;
			const request = this.pending.get(message.id);
			if (!request) continue;
			this.pending.delete(message.id);
			if (message.error) request.reject(new Error(message.error.message ?? "Codex app-server request failed"));
			else request.resolve(message.result);
		}
	}

	private async handleServerRequest(message: AppServerMessage): Promise<void> {
		if (message.method !== "mcpServer/elicitation/request") {
			this.writeResponse(message.id!, undefined, { message: `Unsupported app-server request: ${message.method}` });
			return;
		}
		const prompt =
			isRecord(message.params) && typeof message.params.message === "string"
				? message.params.message
				: "Allow this MCP action?";
		const accepted = await this.approval(prompt);
		this.writeResponse(message.id!, { action: accepted ? "accept" : "decline", content: null, _meta: null });
	}

	private writeResponse(id: number, result?: unknown, error?: { message: string }): void {
		this.child?.stdin.write(
			`${JSON.stringify({ id, ...(error ? { error: { code: -32601, message: error.message } } : { result }) })}\n`,
		);
	}

	private failPending(error: Error): void {
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, any> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLocalMcpTool(value: unknown): value is LocalMcpTool {
	return isRecord(value) && typeof value.name === "string";
}
