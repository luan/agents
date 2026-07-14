import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export type LocalMcpTool = {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		openWorldHint?: boolean;
	};
};

export type NodeReplConfig = {
	command: string;
	args: string[];
	env: Record<string, string>;
};

export type LocalMcpServerConfig = NodeReplConfig & {
	cwd?: string;
};

export type ComputerUseApproval = (message: string) => Promise<boolean>;
export type LocalMcpApproval = ComputerUseApproval;

export async function discoverLocalMcpServers(
	pluginRoot: string,
): Promise<Array<{ name: string; config: LocalMcpServerConfig }>> {
	const manifest = await readJson<{
		mcpServers?: Record<string, { command?: string; args?: string[]; cwd?: string; env?: Record<string, string> }>;
	}>(join(pluginRoot, ".mcp.json"));
	return Object.entries(manifest?.mcpServers ?? []).flatMap(([name, server]) => {
		if (!server.command) return [];
		const command = isAbsolute(server.command) ? server.command : resolve(pluginRoot, server.command);
		return [
			{
				name,
				config: {
					command,
					args: server.args ?? [],
					cwd: server.cwd ? resolve(pluginRoot, server.cwd) : pluginRoot,
					env: server.env ?? {},
				},
			},
		];
	});
}

type JsonRpcResponse = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { message?: string };
};

type NodeReplHostFile = {
	entries?: Array<{
		updatedAt?: string;
		paths?: {
			nodeReplPath?: string;
			nodePath?: string;
			nodeModuleDirs?: string[];
		};
	}>;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

export async function findCodexCliPath(
	codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): Promise<string | undefined> {
	const configEnv = await readNodeReplConfigEnv(codexHome);
	return process.env.CODEX_CLI_PATH ?? configEnv.CODEX_CLI_PATH;
}

export async function findNodeReplConfig(
	codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): Promise<NodeReplConfig | undefined> {
	const configuredPath = process.env.NODE_REPL_PATH;
	const hosts = await readJson<NodeReplHostFile>(join(codexHome, "chrome-native-hosts-v2.json"));
	const hostPaths = (hosts?.entries ?? [])
		.filter((entry) => entry.paths?.nodeReplPath)
		.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
		.map((entry) => entry.paths!);
	const selected = configuredPath
		? { nodeReplPath: configuredPath, nodePath: undefined, nodeModuleDirs: undefined }
		: hostPaths[0];
	if (!selected?.nodeReplPath) return undefined;

	const env: Record<string, string> = {
		...(await readNodeReplConfigEnv(codexHome)),
		CODEX_HOME: codexHome,
		NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: process.env.NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS ?? "10000",
		SKY_CUA_NATIVE_PIPE_PATH:
			process.env.SKY_CUA_NATIVE_PIPE_PATH ??
			join(
				homedir(),
				"Library",
				"Group Containers",
				"2DC432GLL2.com.openai.sky.CUAService",
				"IPC",
				"computeruse.sock",
			),
		...(process.env.NODE_REPL_TRUSTED_CODE_PATHS
			? { NODE_REPL_TRUSTED_CODE_PATHS: process.env.NODE_REPL_TRUSTED_CODE_PATHS }
			: { NODE_REPL_TRUSTED_CODE_PATHS: codexHome }),
	};
	if (selected.nodePath) env.NODE_REPL_NODE_PATH = selected.nodePath;
	if (selected.nodeModuleDirs?.length) env.NODE_REPL_NODE_MODULE_DIRS = selected.nodeModuleDirs.join(delimiter);
	if (process.env.SKY_CUA_SERVICE_PATH) env.SKY_CUA_SERVICE_PATH = process.env.SKY_CUA_SERVICE_PATH;
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key.startsWith("NODE_REPL_")) env[key] = value;
	}

	return { command: selected.nodeReplPath, args: [], env };
}

async function readNodeReplConfigEnv(codexHome: string): Promise<Record<string, string>> {
	try {
		const config = await readFile(join(codexHome, "config.toml"), "utf8");
		const section = config.match(/\[mcp_servers\.node_repl\.env\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";
		const env: Record<string, string> = {};
		for (const line of section.split("\n")) {
			const match = line.match(/^([A-Z0-9_]+)\s*=\s*"((?:\\.|[^"\\])*)"\s*$/);
			if (!match) continue;
			const key = match[1]!;
			if (key.startsWith("NODE_REPL_") || key.startsWith("BROWSER_USE_") || key === "CODEX_CLI_PATH") {
				env[key] = JSON.parse(`"${match[2]}"`) as string;
			}
		}
		return env;
	} catch {
		return {};
	}
}

export class LocalMcpClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private nextId = 1;
	private initialized: Promise<void> | undefined;
	private readonly pending = new Map<number, PendingRequest>();
	private approval: LocalMcpApproval = async () => false;

	constructor(private readonly config: LocalMcpServerConfig) {}

	async listTools(): Promise<LocalMcpTool[]> {
		await this.ensureInitialized();
		const response = await this.request("tools/list", {});
		const result = isRecord(response) ? response : {};
		return Array.isArray(result.tools) ? result.tools.filter(isLocalMcpTool) : [];
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
			return await this.request("tools/call", { name, arguments: args }, signal);
		} finally {
			this.approval = async () => false;
		}
	}

	close(): void {
		this.child?.kill();
		this.child = undefined;
		this.initialized = undefined;
		const error = new Error("Local MCP server closed");
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
			cwd: "cwd" in this.config ? this.config.cwd : undefined,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stderr.resume();
		this.child.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk.toString()));
		this.child.on("error", (error) => this.failPending(error));
		this.child.on("exit", (code, signal) => {
			this.child = undefined;
			this.initialized = undefined;
			this.failPending(new Error(`Local MCP server exited (${code ?? signal ?? "unknown"})`));
		});
		const initialized = await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "pi-codex-native", version: "0" },
		});
		if (!isRecord(initialized)) throw new Error("Local MCP server returned an invalid initialize response");
		this.notify("notifications/initialized", {});
	}

	private request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (!this.child?.stdin.writable) return Promise.reject(new Error("Local MCP server is unavailable"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(id);
				reject(new Error("Local MCP request aborted"));
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
			this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			let message: JsonRpcResponse;
			try {
				message = JSON.parse(line) as JsonRpcResponse;
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
			if (message.error) request.reject(new Error(message.error.message ?? "Local MCP request failed"));
			else request.resolve(message.result);
		}
	}

	private async handleServerRequest(message: JsonRpcResponse): Promise<void> {
		if (message.method !== "elicitation/create") {
			this.writeResponse(message.id!, undefined, { message: `Unsupported local MCP request: ${message.method}` });
			return;
		}
		const messageText =
			isRecord(message.params) && typeof message.params.message === "string"
				? message.params.message
				: "Allow this Computer Use action?";
		const accepted = await this.approval(messageText);
		this.writeResponse(message.id!, { action: accepted ? "accept" : "decline" });
	}

	private writeResponse(id: number, result?: unknown, error?: { message: string }): void {
		this.child?.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error: { code: -32601, message: error.message } } : { result }) })}\n`,
		);
	}

	private failPending(error: Error): void {
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, any> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLocalMcpTool(value: unknown): value is LocalMcpTool {
	return isRecord(value) && typeof value.name === "string";
}
