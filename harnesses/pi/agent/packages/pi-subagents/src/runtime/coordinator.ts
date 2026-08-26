import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type ForkTurns, selectForkedHistory } from "../core/fork-history.ts";
import type { AgentConfig, AgentModelRole } from "../core/types.ts";
import { registerPresentationResolver } from "../protocol/presentation.ts";
import { registerSessionHierarchyProvider, type SessionHierarchyEntry } from "../protocol/session-hierarchy.ts";
import { type RunResult, resumeAgent, runAgent, type ToolActivity } from "./agent-runner.ts";

export const DEFAULT_MAX_CONCURRENCY = 8;
export const DEFAULT_MAX_DEPTH = 2;
export const SUBAGENT_STATE_ENTRY_TYPE = "subagents:agent-v1";
export type SubagentStatus = "queued" | "running" | "idle" | "failed" | "interrupted";
export type TranscriptPreview = {
	readonly kind: "assistant" | "bash" | "custom" | "summary" | "tool" | "user";
	readonly label?: string;
	readonly text: string;
};

export interface SubagentSnapshot {
	readonly id: string;
	readonly rootSessionId: string;
	readonly parentId?: string;
	readonly cwd: string;
	readonly description: string;
	readonly status: SubagentStatus;
	readonly message: string;
	readonly result?: string;
	readonly error?: string;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly toolUses: number;
	readonly cost: number;
	readonly tokenCount: number;
	readonly contextPercent?: number;
	readonly compactions: number;
	readonly activity?: { readonly kind: "compacting" } | { readonly kind: "tool"; readonly name: string };
	readonly modelRole?: AgentModelRole;
	readonly transcriptAvailable: boolean;
}

export type CoordinatorUpdate =
	| {
			type: "spawned" | "started" | "updated" | "checkpoint" | "settled" | "interrupted";
			agent: SubagentSnapshot;
	  }
	| { type: "mailbox"; delivery: CollaborationDelivery }
	| { type: "transcript"; target: string };

export type CollaborationMessageType = "MESSAGE" | "FINAL_ANSWER";

export interface CollaborationDelivery {
	readonly id: number;
	readonly type: CollaborationMessageType;
	readonly target: string;
	readonly sender: string;
	readonly payload: string;
}

export interface TranscriptSource {
	getMessages(): readonly AgentMessage[];
	generation(): number;
	preview(): TranscriptPreview | undefined;
	subscribe(listener: () => void): () => void;
}

export interface SpawnRequest {
	taskName: string;
	message: string;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	agentConfig: AgentConfig;
	forkTurns?: ForkTurns;
	cwd?: string;
	signal?: AbortSignal;
}

export interface PersistedSubagentState {
	readonly id: string;
	readonly parentId?: string;
	readonly cwd: string;
	readonly description: string;
	readonly status: SubagentStatus;
	readonly message: string;
	readonly result?: string;
	readonly error?: string;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly toolUses: number;
	readonly cost: number;
	readonly tokenCount: number;
	readonly contextPercent?: number;
	readonly compactions: number;
	readonly requestedRole?: string;
	readonly modelRole?: AgentModelRole;
	readonly transcriptFile?: string;
	readonly transcriptGeneration: number;
	readonly forkNonBoundaryTimestamps?: readonly number[];
}

export interface SubagentTreeCheckpoint {
	readonly version: 1;
	readonly agents: readonly PersistedSubagentState[];
}

export interface PersistedSubagentEvent {
	readonly version: 1;
	readonly agent: PersistedSubagentState;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

interface LiveAgent extends Omit<Mutable<PersistedSubagentState>, "forkNonBoundaryTimestamps"> {
	rootSessionId: string;
	compacting: boolean;
	activeTools: string[];
	latestInnerTool?: string;
	session?: AgentSession;
	runtime?: RunResult["runtime"];
	abortController: AbortController;
	request?: SpawnRequest;
	forkedHistory: AgentMessage[];
	pendingMessage?: string;
	pendingMessages: string[];
	pendingRuntimeMessages: { message: string; triggerTurn: boolean }[];
	turnGeneration: number;
	activeTurnGeneration?: number;
	turnRuntimes: Map<number, RunResult["runtime"]>;
	restoredMessages?: readonly AgentMessage[];
	sessionUnsubscribe?: () => void;
	presentationUnregister?: () => void;
	forkNonBoundaryTimestamps: Set<number>;
	pendingNonBoundaryMessages: string[];
}

export interface CoordinatorOptions {
	maxConcurrency?: number;
	maxDepth?: number;
	rootSessionDir?: string;
	run?: typeof runAgent;
}

function canonicalTaskName(value: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function depth(path: string): number {
	return path.split("/").filter(Boolean).length - 1;
}

function isCanonicalAgentPath(value: string): boolean {
	return /^\/root(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(value);
}

export function subagentSessionDir(rootSessionDir: string, canonicalPath: string): string {
	const relative = canonicalPath.replace(/^\/root\/?/, "");
	if (!relative || relative.split("/").some((segment) => !canonicalTaskName(segment))) {
		throw new Error(`Invalid canonical subagent path: ${canonicalPath}`);
	}
	return join(rootSessionDir, "subagents", ...relative.split("/"));
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isFiniteNumber(value: object, key: keyof PersistedSubagentState): boolean {
	const item = (value as Record<string, JsonValue | undefined>)[key];
	return typeof item === "number" && Number.isFinite(item);
}

// type-boundary: custom session entry data is extension-owned JSON; this validator narrows it before restoration.
function isPersistedAgentState(value: object | null | undefined): value is PersistedSubagentState {
	if (!value || !("id" in value) || typeof value.id !== "string" || !isCanonicalAgentPath(value.id)) return false;
	const parentId = "parentId" in value ? value.parentId : undefined;
	const validParent =
		parentId === undefined
			? depth(value.id) === 1
			: typeof parentId === "string" &&
				(parentId === "/root" || isCanonicalAgentPath(parentId)) &&
				value.id.startsWith(`${parentId}/`) &&
				depth(value.id) === depth(parentId) + 1;
	if (!validParent) return false;
	const status = "status" in value ? value.status : undefined;
	const requestedRole = "requestedRole" in value ? value.requestedRole : undefined;
	const role = "modelRole" in value ? value.modelRole : undefined;
	return (
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"description" in value &&
		typeof value.description === "string" &&
		"message" in value &&
		typeof value.message === "string" &&
		typeof status === "string" &&
		["queued", "running", "idle", "failed", "interrupted"].includes(status) &&
		isFiniteNumber(value, "startedAt") &&
		isFiniteNumber(value, "toolUses") &&
		isFiniteNumber(value, "cost") &&
		isFiniteNumber(value, "tokenCount") &&
		isFiniteNumber(value, "compactions") &&
		isFiniteNumber(value, "transcriptGeneration") &&
		(!("completedAt" in value) ||
			value.completedAt === undefined ||
			(typeof value.completedAt === "number" && Number.isFinite(value.completedAt))) &&
		(!("contextPercent" in value) ||
			value.contextPercent === undefined ||
			(typeof value.contextPercent === "number" && Number.isFinite(value.contextPercent))) &&
		(!("result" in value) || value.result === undefined || typeof value.result === "string") &&
		(!("error" in value) || value.error === undefined || typeof value.error === "string") &&
		(requestedRole === undefined || typeof requestedRole === "string") &&
		(!("transcriptFile" in value) || value.transcriptFile === undefined || typeof value.transcriptFile === "string") &&
		(role === undefined ||
			(typeof role === "object" &&
				role !== null &&
				"name" in role &&
				typeof role.name === "string" &&
				"color" in role &&
				typeof role.color === "string")) &&
		(!("forkNonBoundaryTimestamps" in value) ||
			value.forkNonBoundaryTimestamps === undefined ||
			(Array.isArray(value.forkNonBoundaryTimestamps) &&
				value.forkNonBoundaryTimestamps.every(
					(timestamp) => typeof timestamp === "number" && Number.isFinite(timestamp),
				)))
	);
}

export function latestSubagentTreeCheckpoint(entries: readonly SessionEntry[]): SubagentTreeCheckpoint | undefined {
	const agents = new Map<string, PersistedSubagentState>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_STATE_ENTRY_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("agent" in data)) continue;
		const agent = data.agent;
		if (!agent || typeof agent !== "object" || !isPersistedAgentState(agent)) continue;
		agents.set(agent.id, agent);
	}
	if (agents.size === 0) return undefined;
	return Object.freeze({
		version: 1,
		agents: Object.freeze([...agents.values()].sort((a, b) => a.id.localeCompare(b.id))),
	});
}

function loadPersistedTranscript(file?: string): readonly AgentMessage[] | undefined {
	if (!file || !existsSync(file)) return undefined;
	try {
		const manager = SessionManager.open(file);
		return Object.freeze([...buildSessionContext(manager.getEntries(), manager.getLeafId()).messages]);
	} catch {
		return undefined;
	}
}

function childTranscriptFile(
	rootSessionDir: string | undefined,
	agentId: string,
	file: string | undefined,
): string | undefined {
	if (!rootSessionDir || !file) return undefined;
	try {
		const childDirectory = realpathSync(subagentSessionDir(rootSessionDir, agentId));
		const candidate = realpathSync(file);
		const pathFromChild = relative(childDirectory, candidate);
		if (!pathFromChild || pathFromChild.startsWith("..") || isAbsolute(pathFromChild)) return undefined;
		return candidate;
	} catch {
		return undefined;
	}
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 512);
}

type TextContent = Extract<AgentMessage, { role: "user" | "toolResult" | "custom" }>["content"];

function contentText(content: TextContent): string {
	if (typeof content === "string") return compactText(content);
	const parts: string[] = [];
	for (const part of content) {
		if (!("type" in part)) continue;
		if (part.type === "image") parts.push("[image]");
		if (part.type === "text" && "text" in part && typeof part.text === "string") parts.push(part.text);
	}
	return compactText(parts.join(" "));
}

function transcriptPreview(message?: AgentMessage): TranscriptPreview | undefined {
	if (!message) return undefined;
	if (message.role === "user") return Object.freeze({ kind: "user", text: contentText(message.content) });
	if (message.role === "toolResult")
		return Object.freeze({ kind: "tool", label: message.toolName, text: contentText(message.content) });
	if (message.role === "assistant") {
		for (let index = message.content.length - 1; index >= 0; index--) {
			const part = message.content[index];
			if (part.type === "toolCall")
				return Object.freeze({ kind: "tool", label: part.name, text: compactText(JSON.stringify(part.arguments)) });
			if (part.type === "text" && compactText(part.text))
				return Object.freeze({ kind: "assistant", text: compactText(part.text) });
			if (part.type === "thinking" && compactText(part.thinking))
				return Object.freeze({ kind: "assistant", label: "thinking", text: compactText(part.thinking) });
		}
		return undefined;
	}
	if (message.role === "bashExecution")
		return Object.freeze({
			kind: "bash",
			label: message.command,
			text: compactText(message.output) || message.command,
		});
	if (message.role === "custom")
		return Object.freeze({ kind: "custom", label: message.customType, text: contentText(message.content) });
	if (message.role === "compactionSummary" || message.role === "branchSummary")
		return Object.freeze({ kind: "summary", text: compactText(message.summary) });
	return undefined;
}

function reportedCost(usage?: { cost?: { total?: number } }): number {
	const cost = usage?.cost?.total ?? 0;
	return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function messageCost(message: AgentMessage): number {
	return message.role === "assistant" || message.role === "toolResult" ? reportedCost(message.usage) : 0;
}

function snapshotOf(agent: LiveAgent): SubagentSnapshot {
	const activeTool = agent.activeTools.at(-1);
	const visibleTool = activeTool === "exec" && agent.latestInnerTool ? agent.latestInnerTool : activeTool;
	return Object.freeze({
		id: agent.id,
		rootSessionId: agent.rootSessionId,
		parentId: agent.parentId,
		cwd: agent.cwd,
		description: agent.description,
		status: agent.status,
		message: agent.message,
		result: agent.result,
		error: agent.error,
		startedAt: agent.startedAt,
		completedAt: agent.completedAt,
		toolUses: agent.toolUses,
		cost: agent.cost,
		tokenCount: agent.tokenCount,
		contextPercent: agent.contextPercent,
		compactions: agent.compactions,
		activity: agent.compacting
			? { kind: "compacting" as const }
			: visibleTool
				? { kind: "tool" as const, name: visibleTool }
				: undefined,
		modelRole: agent.modelRole ? Object.freeze({ ...agent.modelRole }) : undefined,
		transcriptAvailable: Boolean(agent.session || agent.restoredMessages),
	});
}

function persistedStateOf(agent: LiveAgent): PersistedSubagentState {
	return Object.freeze({
		id: agent.id,
		parentId: agent.parentId,
		cwd: agent.cwd,
		description: agent.description,
		status: agent.status,
		message: agent.message,
		result: agent.result,
		error: agent.error,
		startedAt: agent.startedAt,
		completedAt: agent.completedAt,
		toolUses: agent.toolUses,
		cost: agent.cost,
		tokenCount: agent.tokenCount,
		contextPercent: agent.contextPercent,
		compactions: agent.compactions,
		requestedRole: agent.requestedRole,
		modelRole: agent.modelRole ? Object.freeze({ ...agent.modelRole }) : undefined,
		transcriptFile: agent.session?.sessionManager.getSessionFile?.() ?? agent.transcriptFile,
		transcriptGeneration: agent.transcriptGeneration,
		forkNonBoundaryTimestamps: Object.freeze([...agent.forkNonBoundaryTimestamps].sort((a, b) => a - b)),
	});
}

export class SubagentCoordinator {
	readonly rootSessionId: string;
	private readonly agents = new Map<string, LiveAgent>();
	private readonly childSessions = new Map<string, string>();
	private readonly listeners = new Set<(event: CoordinatorUpdate) => void>();
	private readonly mailboxes = new Map<string, CollaborationDelivery[]>();
	private readonly queue: LiveAgent[] = [];
	private nextDeliveryId = 1;
	private running = 0;
	private readonly maxConcurrency: number;
	private readonly maxDepth: number;
	private rootSessionDir?: string;
	private disposed = false;
	private readonly disposedRuntimes = new Set<RunResult["runtime"]>();
	private readonly run: typeof runAgent;

	constructor(rootSessionId: string, options: CoordinatorOptions = {}) {
		this.rootSessionId = rootSessionId;
		this.rootSessionDir = options.rootSessionDir;
		this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
		this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
		if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1)
			throw new Error("maxConcurrency must be an integer >= 1");
		if (!Number.isInteger(this.maxDepth) || this.maxDepth < 1) throw new Error("maxDepth must be an integer >= 1");
		this.run = options.run ?? runAgent;
	}

	spawn(callerPath: string | undefined, request: SpawnRequest): string {
		if (!this.rootSessionDir && !callerPath) this.rootSessionDir = request.ctx.sessionManager.getSessionDir();
		const parent = callerPath ?? "/root";
		if (depth(parent) >= this.maxDepth) throw new Error(`Agent depth limit ${this.maxDepth} reached at ${parent}`);
		if (!canonicalTaskName(request.taskName))
			throw new Error("task_name must use lowercase letters, digits, and single hyphens");
		const id = `${parent}/${request.taskName}`;
		if (this.agents.has(id)) throw new Error(`task_name "${request.taskName}" is already used by ${id}`);
		const messages = buildSessionContext(
			request.ctx.sessionManager.getEntries(),
			request.ctx.sessionManager.getLeafId(),
		).messages;
		const agent: LiveAgent = {
			id,
			rootSessionId: this.rootSessionId,
			parentId: callerPath,
			cwd: request.cwd ?? request.ctx.cwd,
			description: request.taskName,
			status: "queued",
			message: request.message,
			startedAt: Date.now(),
			toolUses: 0,
			cost: 0,
			tokenCount: 0,
			compactions: 0,
			requestedRole: request.agentConfig.role,
			transcriptGeneration: 0,
			compacting: false,
			activeTools: [],
			abortController: new AbortController(),
			request,
			forkedHistory: selectForkedHistory(
				messages,
				request.forkTurns ?? "all",
				callerPath ? this.agents.get(callerPath)?.forkNonBoundaryTimestamps : undefined,
			),
			pendingMessages: [],
			pendingRuntimeMessages: [],
			turnGeneration: 0,
			turnRuntimes: new Map(),
			forkNonBoundaryTimestamps: new Set(),
			pendingNonBoundaryMessages: [],
		};
		this.agents.set(id, agent);
		this.emit({ type: "spawned", agent: snapshotOf(agent) });
		this.queue.push(agent);
		this.drain();
		return id;
	}

	async sendMessage(callerPath: string | undefined, target: string, message: string): Promise<boolean> {
		const recipient = target === "/root" ? "/root" : this.requireTarget(callerPath, target).id;
		this.enqueueDelivery("MESSAGE", recipient, callerPath ?? "/root", message);
		return true;
	}

	async followUp(callerPath: string | undefined, target: string, message: string): Promise<void> {
		const agent = this.requireTarget(callerPath, target);
		if (agent.status === "queued") {
			agent.pendingMessages.push(message);
			return;
		}
		if (agent.status === "running") {
			if (agent.session) await agent.session.followUp(message);
			else agent.pendingRuntimeMessages.push({ message, triggerTurn: true });
			return;
		}
		if (!agent.session && !agent.request)
			throw new Error(`Agent ${agent.id} was restored as history and cannot be continued in this process`);
		agent.status = "queued";
		agent.startedAt = Date.now();
		agent.completedAt = undefined;
		agent.result = undefined;
		agent.error = undefined;
		agent.abortController = new AbortController();
		if (agent.session) agent.pendingMessage = message;
		else if (agent.activeTurnGeneration !== undefined) agent.pendingMessage = message;
		else if (agent.restoredMessages && agent.request) {
			agent.request = { ...agent.request, message };
			agent.forkedHistory = [...agent.restoredMessages];
		} else agent.pendingMessages.push(message);
		this.queue.push(agent);
		this.emit({ type: "checkpoint", agent: snapshotOf(agent) });
		this.drain();
	}

	async interrupt(callerPath: string | undefined, target: string): Promise<SubagentStatus> {
		const agent = this.requireTarget(callerPath, target);
		const previous = agent.status;
		if (previous === "queued") {
			const index = this.queue.indexOf(agent);
			if (index >= 0) this.queue.splice(index, 1);
		} else if (previous === "running") agent.abortController.abort();
		else throw new Error(`Agent ${agent.id} has no active turn`);
		agent.status = "interrupted";
		agent.completedAt = Date.now();
		this.emit({ type: "interrupted", agent: snapshotOf(agent) });
		return previous;
	}

	snapshot(): readonly SubagentSnapshot[] {
		return Object.freeze([...this.agents.values()].map(snapshotOf).sort((a, b) => a.id.localeCompare(b.id)));
	}
	checkpoint(): SubagentTreeCheckpoint {
		return Object.freeze({
			version: 1,
			agents: Object.freeze([...this.agents.values()].map(persistedStateOf).sort((a, b) => a.id.localeCompare(b.id))),
		});
	}
	persistedAgent(target: string): PersistedSubagentState | undefined {
		const agent = this.agents.get(target);
		return agent ? persistedStateOf(agent) : undefined;
	}

	restore(checkpoint: SubagentTreeCheckpoint, runtime?: Pick<SpawnRequest, "ctx" | "pi">): void {
		if (this.agents.size > 0) throw new Error("Cannot restore agent history into a non-empty coordinator");
		for (const saved of checkpoint.agents) {
			const wasActive = saved.status === "queued" || saved.status === "running";
			const transcriptFile = childTranscriptFile(this.rootSessionDir, saved.id, saved.transcriptFile);
			const restoredMessages = loadPersistedTranscript(transcriptFile);
			const agent: LiveAgent = {
				id: saved.id,
				parentId: saved.parentId,
				cwd: saved.cwd,
				description: saved.description,
				message: saved.message,
				result: saved.result,
				error: saved.error,
				startedAt: saved.startedAt,
				toolUses: saved.toolUses,
				cost: saved.cost,
				tokenCount: saved.tokenCount,
				contextPercent: saved.contextPercent,
				compactions: saved.compactions,
				requestedRole: saved.requestedRole,
				modelRole: saved.modelRole ? { ...saved.modelRole } : undefined,
				transcriptGeneration: saved.transcriptGeneration,
				transcriptFile,
				rootSessionId: this.rootSessionId,
				status: wasActive ? "interrupted" : saved.status,
				completedAt: wasActive ? Date.now() : saved.completedAt,
				compacting: false,
				activeTools: [],
				abortController: new AbortController(),
				request: runtime
					? {
							taskName: saved.id.split("/").at(-1)!,
							message: saved.message,
							pi: runtime.pi,
							ctx: runtime.ctx,
							agentConfig:
								saved.requestedRole !== undefined
									? { role: saved.requestedRole }
									: saved.modelRole
										? { role: saved.modelRole.name }
										: {},
							forkTurns: "none",
							cwd: saved.cwd,
						}
					: undefined,
				forkedHistory: [],
				pendingMessages: [],
				pendingRuntimeMessages: [],
				turnGeneration: 0,
				turnRuntimes: new Map(),
				restoredMessages,
				forkNonBoundaryTimestamps: new Set(saved.forkNonBoundaryTimestamps ?? []),
				pendingNonBoundaryMessages: [],
			};
			this.agents.set(agent.id, agent);
		}
	}

	subscribe(listener: (event: CoordinatorUpdate) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	waitForUpdate(signal?: AbortSignal, timeoutMs = 30_000): Promise<CoordinatorUpdate | undefined> {
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (event?: CoordinatorUpdate) => {
				unsubscribe();
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				resolve(event);
			};
			const unsubscribe = this.subscribe((event) => {
				if (event.type === "mailbox" || event.type === "settled" || event.type === "interrupted") finish(event);
			});
			const abort = () => finish();
			signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(() => finish(), timeoutMs);
			timer.unref();
			if (signal?.aborted) abort();
		});
	}

	transcript(target: string): TranscriptSource | undefined {
		const agent = this.agents.get(target);
		if (!agent) return undefined;
		return Object.freeze({
			getMessages: () => Object.freeze([...(agent.session?.state.messages ?? agent.restoredMessages ?? [])]),
			generation: () => agent.transcriptGeneration,
			preview: () => transcriptPreview((agent.session?.state.messages ?? agent.restoredMessages)?.at(-1)),
			subscribe: (listener: () => void) =>
				this.subscribe((event) => {
					if (event.type === "transcript" && event.target === agent.id) listener();
				}),
		});
	}

	pathForSession(sessionId: string): string | undefined {
		return this.childSessions.get(sessionId);
	}
	drainMailbox(target: string): readonly CollaborationDelivery[] {
		const mailbox = this.mailboxes.get(target);
		if (!mailbox || mailbox.length === 0) return Object.freeze([]);
		this.mailboxes.delete(target);
		return Object.freeze(mailbox.splice(0));
	}
	resolve(callerPath: string | undefined, target: string): string | undefined {
		if (target === "/root") return "/root";
		if (target.startsWith("/")) return this.agents.has(target) ? target : undefined;
		const direct = `${callerPath ?? "/root"}/${target}`;
		return this.agents.has(direct) ? direct : undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const agent of this.agents.values()) {
			agent.abortController.abort();
			agent.sessionUnsubscribe?.();
			agent.presentationUnregister?.();
			this.disposeRuntime(agent.runtime);
			for (const runtime of agent.turnRuntimes.values()) this.disposeRuntime(runtime);
		}
		this.agents.clear();
		this.queue.length = 0;
		this.listeners.clear();
		this.childSessions.clear();
		this.mailboxes.clear();
	}

	private requireTarget(callerPath: string | undefined, target: string): LiveAgent {
		const id = this.resolve(callerPath, target);
		const agent = id ? this.agents.get(id) : undefined;
		if (!agent) throw new Error(`No agent matches "${target}"`);
		return agent;
	}
	private emit(event: CoordinatorUpdate): void {
		for (const listener of [...this.listeners]) listener(event);
	}
	private enqueueDelivery(type: CollaborationMessageType, target: string, sender: string, payload: string): void {
		const delivery = Object.freeze({ id: this.nextDeliveryId++, type, target, sender, payload });
		const mailbox = this.mailboxes.get(target) ?? [];
		mailbox.push(delivery);
		this.mailboxes.set(target, mailbox);
		this.emit({ type: "mailbox", delivery });
	}
	private recordUserMessage(agent: LiveAgent, message: AgentMessage): void {
		if (message.role !== "user") return;
		const text = contentText(message.content);
		const index = agent.pendingNonBoundaryMessages.indexOf(text);
		if (index < 0) return;
		agent.pendingNonBoundaryMessages.splice(index, 1);
		agent.forkNonBoundaryTimestamps.add(message.timestamp);
	}
	private drain(): void {
		while (this.running < Math.max(0, this.maxConcurrency - 1)) {
			const index = this.queue.findIndex((agent) => agent.activeTurnGeneration === undefined);
			if (index < 0) return;
			const [agent] = this.queue.splice(index, 1);
			if (!agent) return;
			this.start(agent);
		}
	}
	private start(agent: LiveAgent): void {
		const generation = ++agent.turnGeneration;
		agent.activeTurnGeneration = generation;
		agent.status = "running";
		agent.startedAt = Date.now();
		this.running++;
		this.emit({ type: "started", agent: snapshotOf(agent) });
		if (agent.session) {
			const message = agent.pendingMessage;
			agent.pendingMessage = undefined;
			if (!message) throw new Error(`Agent ${agent.id} has no pending follow-up message`);
			void this.continue(agent, [...agent.pendingMessages.splice(0), message].join("\n\n"), generation);
			return;
		}
		const request = agent.request;
		if (!request) throw new Error(`Agent ${agent.id} has no runnable session state`);
		const restartMessage = agent.pendingMessage;
		agent.pendingMessage = undefined;
		const initialMessage = [request.message, restartMessage, ...agent.pendingMessages.splice(0)]
			.filter((message): message is string => Boolean(message))
			.join("\n\n");
		void this.run(request.ctx, initialMessage, {
			pi: request.pi,
			agentConfig: request.agentConfig,
			collaboration: { agentPath: agent.id, maxConcurrency: this.maxConcurrency, maxDepth: this.maxDepth },
			cwd: request.cwd,
			sessionDir: subagentSessionDir(this.rootSessionDir ?? request.ctx.sessionManager.getSessionDir(), agent.id),
			signal: agent.abortController.signal,
			forkedHistory: agent.forkedHistory,
			onRuntimeResolved: (role) => {
				if (!this.disposed && agent.turnGeneration === generation) agent.modelRole = role;
			},
			onRuntimeCreated: (runtime) => {
				if (this.disposed || agent.turnGeneration !== generation) this.disposeRuntime(runtime);
				else agent.turnRuntimes.set(generation, runtime);
			},
			onToolActivity: (activity) => this.recordToolActivity(agent, activity, generation),
			onUserMessage: (message) => this.recordUserMessage(agent, message),
			onSessionCreated: (session) => this.attachSession(agent, session, generation),
		}).then(
			(result) => this.finish(agent, result, generation),
			(error: object) => this.fail(agent, error, generation),
		);
	}

	private attachSession(agent: LiveAgent, session: AgentSession, generation: number): void {
		if (this.disposed || agent.turnGeneration !== generation) return;
		agent.session = session;
		agent.presentationUnregister?.();
		agent.presentationUnregister = registerPresentationResolver(agent.id, {
			resolveTool: (name) => session.getToolDefinition(name),
			resolveCustomMessage: (customType) => session.extensionRunner.getMessageRenderer(customType),
		});
		agent.transcriptFile = session.sessionManager.getSessionFile?.();
		agent.restoredMessages = undefined;
		this.refreshSessionStats(agent, session);
		this.childSessions.set(session.sessionManager.getSessionId(), agent.id);
		bindSessionToRoot(this.rootSessionId, session.sessionManager.getSessionId());
		agent.sessionUnsubscribe = session.subscribe((event) => {
			let changed = false;
			if (event.type === "compaction_start") {
				agent.compacting = true;
				changed = true;
			}
			if (event.type === "message_end") {
				agent.cost += messageCost(event.message);
				this.refreshSessionStats(agent, session);
				changed = true;
			}
			if (event.type === "compaction_end") {
				agent.compacting = false;
				changed = true;
				if (!event.aborted) {
					agent.transcriptGeneration++;
					agent.cost += reportedCost(event.result?.usage);
					agent.compactions++;
					this.refreshSessionStats(agent, session);
				}
			}
			if (event.type === "turn_end" || event.type === "agent_settled") {
				this.refreshSessionStats(agent, session);
				changed = true;
			}
			if (changed) this.emit({ type: "updated", agent: snapshotOf(agent) });
			this.emit({ type: "transcript", target: agent.id });
		});
		for (const pending of agent.pendingRuntimeMessages.splice(0)) {
			if (pending.triggerTurn) void session.followUp(pending.message);
			else {
				agent.pendingNonBoundaryMessages.push(compactText(pending.message));
				void session.steer(pending.message);
			}
		}
		this.emit({ type: "checkpoint", agent: snapshotOf(agent) });
	}

	private async continue(agent: LiveAgent, message: string, generation: number): Promise<void> {
		try {
			const result = await resumeAgent(agent.session!, message, {
				signal: agent.abortController.signal,
				onToolActivity: (activity) => this.recordToolActivity(agent, activity, generation),
				onUserMessage: (user) => this.recordUserMessage(agent, user),
			});
			this.finish(agent, { ...result, session: agent.session!, runtime: agent.runtime! }, generation);
		} catch (error) {
			this.fail(agent, error instanceof Error ? error : new Error(String(error)), generation);
		}
	}
	private releaseTurn(agent: LiveAgent, generation: number): boolean {
		if (agent.activeTurnGeneration !== generation) return false;
		agent.activeTurnGeneration = undefined;
		this.running = Math.max(0, this.running - 1);
		return true;
	}
	private finish(agent: LiveAgent, result: RunResult, generation: number): void {
		const turnRuntime = agent.turnRuntimes.get(generation);
		agent.turnRuntimes.delete(generation);
		const released = this.releaseTurn(agent, generation);
		const preserveInterruptedTurn =
			!this.disposed &&
			agent.turnGeneration === generation &&
			(agent.status === "queued" || agent.status === "interrupted");
		if (preserveInterruptedTurn) {
			agent.session = result.session;
			agent.runtime = result.runtime;
			this.refreshSessionStats(agent, result.session);
			if (released) this.drain();
			return;
		}
		if (this.disposed || agent.status !== "running" || agent.turnGeneration !== generation) {
			if (result.runtime !== agent.runtime) this.disposeRuntime(result.runtime);
			if (turnRuntime !== result.runtime && turnRuntime !== agent.runtime) this.disposeRuntime(turnRuntime);
			if (released) this.drain();
			return;
		}
		agent.session = result.session;
		agent.runtime = result.runtime;
		this.refreshSessionStats(agent, result.session);
		agent.result = result.responseText;
		agent.error = result.error;
		agent.status = result.error ? "failed" : "idle";
		agent.completedAt = Date.now();
		if (!result.error) this.enqueueDelivery("FINAL_ANSWER", agent.parentId ?? "/root", agent.id, result.responseText);
		this.emit({ type: "settled", agent: snapshotOf(agent) });
		this.drain();
	}
	private fail(agent: LiveAgent, error: object, generation: number): void {
		const turnRuntime = agent.turnRuntimes.get(generation);
		agent.turnRuntimes.delete(generation);
		const released = this.releaseTurn(agent, generation);
		const preserveInterruptedTurn =
			!this.disposed &&
			agent.turnGeneration === generation &&
			(agent.status === "queued" || agent.status === "interrupted") &&
			Boolean(agent.session && turnRuntime);
		if (preserveInterruptedTurn) {
			agent.runtime = turnRuntime;
			if (released) this.drain();
			return;
		}
		if (turnRuntime !== agent.runtime) this.disposeRuntime(turnRuntime);
		if (this.disposed || agent.status !== "running" || agent.turnGeneration !== generation) {
			if (released) this.drain();
			return;
		}
		agent.error = error instanceof Error ? error.message : String(error);
		agent.result = "";
		agent.status = "failed";
		agent.completedAt = Date.now();
		this.emit({ type: "settled", agent: snapshotOf(agent) });
		this.drain();
	}
	private recordToolActivity(agent: LiveAgent, activity: ToolActivity, generation: number): void {
		if (agent.turnGeneration !== generation) return;
		if (activity.type === "start") {
			agent.activeTools.push(activity.toolName);
			if (activity.nested) agent.latestInnerTool = activity.toolName;
		} else {
			const index = agent.activeTools.lastIndexOf(activity.toolName);
			if (index >= 0) agent.activeTools.splice(index, 1);
			if (activity.toolName === "exec" && !activity.nested) agent.latestInnerTool = undefined;
			agent.toolUses++;
		}
		this.emit({ type: "updated", agent: snapshotOf(agent) });
	}
	private disposeRuntime(runtime?: RunResult["runtime"]): void {
		if (!runtime || this.disposedRuntimes.has(runtime)) return;
		this.disposedRuntimes.add(runtime);
		void runtime.dispose().catch(() => undefined);
	}
	private refreshSessionStats(agent: LiveAgent, session: AgentSession): void {
		const stats = session.getSessionStats();
		agent.tokenCount = stats.tokens.total;
		agent.contextPercent = stats.contextUsage?.percent ?? undefined;
	}
}

interface CoordinatorDirectory {
	roots: Map<string, SubagentCoordinator>;
	sessionRoots: Map<string, string>;
	hierarchyProviders: Map<string, () => void>;
}
const DIRECTORY_KEY = Symbol.for("pi.subagents.coordinator-directory.v1");
const globalDirectory = globalThis as typeof globalThis & { [DIRECTORY_KEY]?: CoordinatorDirectory };
const directory = globalDirectory[DIRECTORY_KEY] ?? {
	roots: new Map(),
	sessionRoots: new Map(),
	hierarchyProviders: new Map(),
};
directory.hierarchyProviders ??= new Map();
globalDirectory[DIRECTORY_KEY] = directory;

export function createRootCoordinator(rootSessionId: string, options?: CoordinatorOptions): SubagentCoordinator {
	if (directory.roots.has(rootSessionId)) throw new Error(`Coordinator already exists for ${rootSessionId}`);
	const coordinator = new SubagentCoordinator(rootSessionId, options);
	directory.roots.set(rootSessionId, coordinator);
	directory.sessionRoots.set(rootSessionId, rootSessionId);
	directory.hierarchyProviders.set(
		rootSessionId,
		registerSessionHierarchyProvider((sessionId) => descendantSessions(rootSessionId, coordinator, sessionId)),
	);
	return coordinator;
}
export function bindSessionToRoot(rootSessionId: string, sessionId: string): void {
	if (!directory.roots.has(rootSessionId)) throw new Error(`No coordinator exists for ${rootSessionId}`);
	directory.sessionRoots.set(sessionId, rootSessionId);
}
export function getCoordinatorForSession(sessionId: string): SubagentCoordinator | undefined {
	const root = directory.sessionRoots.get(sessionId);
	return root ? directory.roots.get(root) : undefined;
}
export function removeRootCoordinator(rootSessionId: string): void {
	const coordinator = directory.roots.get(rootSessionId);
	if (!coordinator) return;
	coordinator.dispose();
	directory.hierarchyProviders.get(rootSessionId)?.();
	directory.hierarchyProviders.delete(rootSessionId);
	directory.roots.delete(rootSessionId);
	for (const [sessionId, root] of directory.sessionRoots)
		if (root === rootSessionId) directory.sessionRoots.delete(sessionId);
}

function descendantSessions(
	rootSessionId: string,
	coordinator: SubagentCoordinator,
	sessionId: string,
): readonly SessionHierarchyEntry[] | undefined {
	if (directory.sessionRoots.get(sessionId) !== rootSessionId) return undefined;
	const callerPath = sessionId === rootSessionId ? "/root" : coordinator.pathForSession(sessionId);
	if (!callerPath) return undefined;
	return [...directory.sessionRoots.entries()]
		.filter(([, root]) => root === rootSessionId)
		.flatMap(([candidate]) => {
			const path = candidate === rootSessionId ? "/root" : coordinator.pathForSession(candidate);
			return path && (path === callerPath || path.startsWith(`${callerPath}/`)) ? [{ sessionId: candidate, path }] : [];
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}
