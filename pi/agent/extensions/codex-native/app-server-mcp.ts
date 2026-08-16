import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { LocalMcpTool } from "./local-mcp.ts";

type CodexAppServerConfig = {
	command: string;
	args: string[];
	cwd: string;
};

type AppServerMessage = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { message?: string };
};

export type CodexAppServerMcpServer = {
	tools: LocalMcpTool[];
	enabled?: boolean;
	serverInfo?: unknown;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

// pi is often started from a launcher, whose PATH omits the `~/.local/bin` codex installs into, so that location is the last resort after the bare name.
export function resolveCodexCliPath(): string {
	const candidates = [
		process.env.CODEX_CLI_PATH,
		...(process.env.PATH ?? "").split(delimiter).map((entry) => (entry ? join(entry, "codex") : undefined)),
		join(homedir(), ".local", "bin", "codex"),
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return "codex";
}

// `never` is a choice, not an oversight: a Computer Use action clicks and types into this one person's apps, and they have asked not to be prompted.
const THREAD_APPROVAL_POLICY = "never";

// Only Computer Use has an unattended elicitation flow. Other MCP servers need an approval UI this bridge does not provide.
const AUTO_ACCEPT_MCP_ELICITATION_SERVERS = new Set(["computer-use"]);

// Every call must go through the codex app-server. Computer Use's helper checks its caller's `_senderParentTeamID` and `_senderResponsibleTeamID` against OpenAI's own,
// so a copy pi spawns answers `initialize` and `tools/list` and then never answers `tools/call`. Only the `codex` binary carries that identifier.
// One process serves every server: `mcpServerStatus/list` returns the whole inventory, and `mcpServer/tool/call` names its server per call.
export class CodexAppServerMcpClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private nextId = 1;
	private initialized: Promise<void> | undefined;
	private thread: Promise<string> | undefined;
	private readonly pending = new Map<number, PendingRequest>();

	constructor(
		private readonly config: CodexAppServerConfig = {
			command: resolveCodexCliPath(),
			args: ["app-server", "--stdio"],
			cwd: process.cwd(),
		},
	) {}

	// `detail: "full"` also resolves every remote connector, ~1.5s of session start for a surface `discoverCodexAppsTools` fetches over HTTPS. Schemas arrive either way.
	async listServers(): Promise<Map<string, CodexAppServerMcpServer>> {
		await this.ensureStarted();
		const response = await this.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" });
		const servers = new Map<string, CodexAppServerMcpServer>();
		for (const status of isRecord(response) ? asArray(response.data) : []) {
			if (!isRecord(status) || typeof status.name !== "string") continue;
			servers.set(status.name, {
				tools: Object.values(isRecord(status.tools) ? status.tools : {}).filter(isLocalMcpTool),
				...(typeof status.enabled === "boolean" ? { enabled: status.enabled } : {}),
				...("serverInfo" in status ? { serverInfo: status.serverInfo } : {}),
			});
		}
		return servers;
	}

	async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		await this.ensureStarted();
		const threadId = await this.ensureThread();
		return this.request("mcpServer/tool/call", { threadId, server, tool, arguments: args }, signal);
	}

	close(): void {
		this.child?.kill();
		this.child = undefined;
		this.initialized = undefined;
		this.thread = undefined;
		this.failPending(new Error("Codex app-server closed"));
	}

	private async ensureStarted(): Promise<void> {
		if (!this.initialized) {
			this.initialized = this.start().catch((error) => {
				this.close();
				throw error;
			});
		}
		await this.initialized;
	}

	private async start(): Promise<void> {
		this.child = spawn(this.config.command, this.config.args, {
			env: process.env,
			cwd: this.config.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stderr.resume();
		this.child.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk.toString()));
		this.child.on("error", (error) => this.failPending(error));
		this.child.on("exit", (code, signal) => {
			this.child = undefined;
			this.initialized = undefined;
			this.thread = undefined;
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
	}

	// Ephemeral and never given a turn: `mcpServer/tool/call` requires a thread id.
	private ensureThread(): Promise<string> {
		this.thread ??= this.request("thread/start", {
			cwd: this.config.cwd,
			ephemeral: true,
			approvalPolicy: THREAD_APPROVAL_POLICY,
			sandbox: "danger-full-access",
		})
			.then((started) => {
				const thread = isRecord(started) && isRecord(started.thread) ? started.thread : undefined;
				if (!thread || typeof thread.id !== "string")
					throw new Error("Codex app-server returned an invalid thread");
				return thread.id;
			})
			.catch((error) => {
				this.thread = undefined;
				throw error;
			});
		return this.thread;
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
				this.handleServerRequest(message);
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

	// `mcpServer/elicitation/request` arrives inside an open tool call and the call does not finish until it is answered, so silence is the one unacceptable response.
	private handleServerRequest(message: AppServerMessage): void {
		if (message.method !== "mcpServer/elicitation/request") {
			this.writeResponse(message.id!, undefined, { message: `Unsupported app-server request: ${message.method}` });
			return;
		}
		const serverName =
			isRecord(message.params) && typeof message.params.serverName === "string"
				? message.params.serverName
				: undefined;
		if (!serverName || !AUTO_ACCEPT_MCP_ELICITATION_SERVERS.has(serverName)) {
			this.writeResponse(message.id!, undefined, {
				message: `MCP elicitation rejected for untrusted server ${serverName ?? "unknown"}`,
			});
			return;
		}
		this.writeResponse(message.id!, { action: "accept", content: null, _meta: null });
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
