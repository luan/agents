import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createRmuxPtyBackend, resolveRmuxBinary } from "../../exec-command/adapter/rmux-pty-backend.ts";
import { prepareAgentRun, type ToolActivity } from "./agent-runner.js";
import { isSubagentOrchestrationToolName } from "./orchestration-tools.js";
import type { AgentAttachment, AgentConfig, AttachedAgentRuntime, SubagentType, ThinkingLevel } from "./types.js";
import { type AssistantUsage, readAssistantUsage } from "./usage.js";

const ATTACHED_GRACE_TURNS = 5;

interface AttachedRunOptions {
	pi: ExtensionAPI;
	description: string;
	agentConfig: AgentConfig;
	cwd: string;
	sessionDir: string;
	signal?: AbortSignal;
	onRuntimeResolved?: (model: Model<any> | undefined, thinkingLevel: ThinkingLevel | undefined) => void;
	onToolActivity?: (activity: ToolActivity) => void;
	onTextDelta?: (delta: string, fullText: string) => void;
	onTurnEnd?: (turnCount: number) => void;
	onAssistantUsage?: (usage: AssistantUsage, durationMs: number) => void;
	onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
	onReady?: (state: { sessionFile?: string; sessionId: string }) => void;
	onController?: (controller: AttachedAgentRuntime, attachment: AgentAttachment) => void;
	onExternalTurnStart?: () => void;
	onExternalResult?: (result: ResultMessage) => void;
}

export interface ResultMessage {
	type: "result";
	turnId: string;
	responseText: string;
	error?: string;
}

export interface AttachedAgentBridgeState {
	started: boolean;
	streaming: boolean;
	lastResult?: ResultMessage;
}

class Controller implements AttachedAgentRuntime {
	readonly #pending = new Map<
		string,
		{ resolve: (result: { responseText: string; error?: string }) => void; reject: (error: Error) => void }
	>();
	readonly #completed = new Map<string, { responseText: string; error?: string }>();
	#buffer = "";
	#closed = false;

	constructor(
		private readonly socket: Socket,
		private readonly onMessage: (message: any) => void,
	) {
		socket.on("data", (chunk) => this.#read(chunk.toString("utf8")));
		socket.on("close", () => this.#close(new Error("Attached agent control channel closed")));
		socket.on("error", (error) => this.#close(error));
	}

	get closed(): boolean {
		return this.#closed;
	}

	start(): Promise<{ responseText: string; error?: string }> {
		return this.#request("initial", { type: "start" });
	}

	async steer(message: string): Promise<void> {
		this.#send({ type: "steer", message });
	}

	run(prompt: string): Promise<{ responseText: string; error?: string }> {
		return this.#request(randomUUID(), { type: "prompt", message: prompt });
	}

	async stop(): Promise<void> {
		this.#send({ type: "stop" });
	}

	#request(turnId: string, message: object): Promise<{ responseText: string; error?: string }> {
		const result = this.#wait(turnId);
		try {
			this.#send({ ...message, turnId });
			return result;
		} catch (error) {
			this.#pending.delete(turnId);
			return Promise.reject(error);
		}
	}

	#wait(turnId: string): Promise<{ responseText: string; error?: string }> {
		const completed = this.#completed.get(turnId);
		if (completed) {
			this.#completed.delete(turnId);
			return Promise.resolve(completed);
		}
		return new Promise((resolve, reject) => this.#pending.set(turnId, { resolve, reject }));
	}

	#send(message: object): void {
		if (this.#closed) throw new Error("Attached agent control channel is closed");
		this.socket.write(`${JSON.stringify(message)}\n`);
	}

	#read(chunk: string): void {
		this.#buffer += chunk;
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line) continue;
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (message.type === "state" && message.lastResult) this.#settle(message.lastResult as ResultMessage);
			if (message.type === "result") this.#settle(message as ResultMessage);
			if (message.type === "error") this.#fail(new Error(message.error));
			this.onMessage(message);
		}
	}

	#settle(result: ResultMessage): void {
		const value = { responseText: result.responseText, error: result.error };
		const pending = this.#pending.get(result.turnId);
		if (pending) {
			pending.resolve(value);
			this.#pending.delete(result.turnId);
		} else {
			this.#completed.set(result.turnId, value);
		}
	}

	#close(error: Error): void {
		this.#closed = true;
		this.#fail(error);
	}

	#fail(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#completed.clear();
	}
}

function socketPath(rootSessionId: string, agentId: string, launchId: string): string {
	const key = createHash("sha256").update(`${rootSessionId}\0${agentId}\0${launchId}`).digest("hex").slice(0, 24);
	return join(homedir(), ".pi", "agent", "rmux", "agents", `${key}.sock`);
}

function connect(path: string, timeoutMs = 5000, signal?: AbortSignal): Promise<Socket> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			if (!existsSync(path)) {
				if (Date.now() >= deadline) {
					reject(new Error(`Attached agent socket did not appear: ${path}`));
					return;
				}
				setTimeout(attempt, 50);
				return;
			}
			const socket = createConnection(path);
			socket.once("connect", () => resolve(socket));
			socket.once("error", (error) => {
				socket.destroy();
				if (Date.now() >= deadline) reject(error);
				else setTimeout(attempt, 50);
			});
		};
		attempt();
	});
}

export async function connectAttachedAgent(
	attachment: AgentAttachment,
	onState?: (state: AttachedAgentBridgeState) => void,
	onMessage?: (message: any) => void,
	startIfNeeded = true,
): Promise<AttachedAgentRuntime> {
	const socket = await connect(attachment.socketPath);
	let resolveState = (_state: AttachedAgentBridgeState) => {};
	const state = new Promise<AttachedAgentBridgeState>((resolve) => {
		resolveState = resolve;
	});
	const controller = new Controller(socket, (message) => {
		if (message.type === "state") resolveState(message as AttachedAgentBridgeState);
		if (message.type !== "state") onMessage?.(message);
	});
	const connected = await state;
	onState?.(connected);
	if (!connected.started && startIfNeeded) void controller.start().catch(() => undefined);
	return controller;
}

export function attachedAgentTerminalsAvailable(): boolean {
	return resolveRmuxBinary() !== undefined;
}

export async function runAttachedAgent(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	rootSessionId: string,
	agentId: string,
	options: AttachedRunOptions,
): Promise<{ responseText: string; error?: string }> {
	options.signal?.throwIfAborted();
	const rmuxBinary = resolveRmuxBinary();
	if (!rmuxBinary) throw new Error("Attachable terminals are unavailable on this machine");
	const prepared = await prepareAgentRun(ctx, type, prompt, options);
	const allowedTools = prepared.toolNames.filter(
		(name) => !prepared.disallowedSet?.has(name) && !isSubagentOrchestrationToolName(name),
	);
	const controlExtension = fileURLToPath(new URL("./attached-agent-bridge.mjs", import.meta.url));
	const args = [
		"--session-dir",
		options.sessionDir,
		"--name",
		agentId,
		"--system-prompt",
		prepared.systemPrompt,
		"--tools",
		allowedTools.join(","),
		"--no-context-files",
		"--no-prompt-templates",
		"--approve",
	];
	if (prepared.noSkills) args.push("--no-skills");
	if (prepared.noExtensions) args.push("--no-extensions");
	for (const extension of prepared.extensionPaths ?? []) args.push("--extension", extension);
	args.push("--extension", controlExtension);
	if (prepared.thinkingLevel) args.push("--thinking", prepared.thinkingLevel);
	if (prepared.model?.provider) args.push("--provider", prepared.model.provider);
	if (prepared.model?.id) args.push("--model", prepared.model.id);

	const launchId = randomUUID().slice(0, 8);
	const controlSocket = socketPath(rootSessionId, agentId, launchId);
	mkdirSync(dirname(controlSocket), { recursive: true });
	mkdirSync(options.sessionDir, { recursive: true });
	const configPath = join(options.sessionDir, "attached-agent.json");
	writeFileSync(
		configPath,
		`${JSON.stringify({
			socketPath: controlSocket,
			cliPath: join(getPackageDir(), "dist", "cli.js"),
			cwd: prepared.effectiveCwd,
			agentName: agentId,
			args,
			prompt,
		})}\n`,
		{ mode: 0o600 },
	);

	const launcher = fileURLToPath(new URL("./attached-agent-launcher.mjs", import.meta.url));
	const sessionName = `pi-agent-${agentId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(-40)}-${launchId}`;
	const child = await createRmuxPtyBackend({ binary: rmuxBinary }).spawn(process.execPath, [launcher, configPath], {
		cwd: prepared.effectiveCwd,
		env: process.env,
		name: process.env.TERM || "xterm-256color",
		sessionName,
		cols: 100,
		rows: 30,
	});
	const abortChild = () => child.kill();
	options.signal?.addEventListener("abort", abortChild, { once: true });
	if (options.signal?.aborted) {
		abortChild();
		options.signal.throwIfAborted();
	}
	let socket: Socket;
	try {
		socket = await connect(controlSocket, 5000, options.signal);
	} catch (error) {
		options.signal?.removeEventListener("abort", abortChild);
		child.kill();
		try {
			unlinkSync(configPath);
		} catch {}
		throw error;
	}
	let text = "";
	let turnCount = 0;
	const maxTurns = options.agentConfig.maxTurns ? Math.max(1, options.agentConfig.maxTurns) : undefined;
	let softLimitReached = false;
	let messageStartedAt: number | undefined;
	let firstTokenAt: number | undefined;
	let controller: Controller;
	controller = new Controller(socket, (message) => {
		if (message.type === "ready") options.onReady?.(message.state);
		if (
			message.type === "event" &&
			message.turnId?.startsWith("terminal-") &&
			message.event?.type === "agent_start"
		) {
			options.onExternalTurnStart?.();
		}
		if (message.type === "result" && message.turnId?.startsWith("terminal-")) {
			options.onExternalResult?.(message as ResultMessage);
		}
		if (message.type !== "event") return;
		const event = message.event as JsonAgentSessionEvent;
		if (event.type === "message_start" && event.message.role === "assistant") {
			text = "";
			messageStartedAt = Date.now();
			firstTokenAt = undefined;
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			firstTokenAt ??= Date.now();
			text += event.assistantMessageEvent.delta;
			options.onTextDelta?.(event.assistantMessageEvent.delta, text);
		}
		if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
		if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
		if (event.type === "turn_end") {
			options.onTurnEnd?.(++turnCount);
			if (!softLimitReached && maxTurns !== undefined && turnCount >= maxTurns) {
				softLimitReached = true;
				void controller
					.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.")
					.catch(() => undefined);
			} else if (softLimitReached && maxTurns !== undefined && turnCount >= maxTurns + ATTACHED_GRACE_TURNS) {
				void controller.stop().catch(() => undefined);
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const usage = readAssistantUsage(event.message);
			const startedAt = firstTokenAt ?? messageStartedAt;
			if (usage && startedAt !== undefined) options.onAssistantUsage?.(usage, Math.max(1, Date.now() - startedAt));
		}
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
		}
	});
	if (!child.attachment) throw new Error("Attached terminal did not provide a launcher");
	const attachment: AgentAttachment = {
		mode: "terminal",
		sessionName: child.name ?? sessionName,
		socketPath: controlSocket,
		command: child.attachment.command,
		args: child.attachment.args,
	};
	options.onController?.(controller, attachment);
	return controller.start().finally(() => options.signal?.removeEventListener("abort", abortChild));
}
