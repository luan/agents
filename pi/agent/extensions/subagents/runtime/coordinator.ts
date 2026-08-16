import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { type RunResult, resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { type ForkTurns, selectForkedHistory } from "./fork-history.js";
import type { AgentConfig, AgentModelRole } from "./types.js";

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
			readonly type: "spawned" | "started" | "updated" | "checkpoint" | "settled" | "interrupted";
			readonly agent: SubagentSnapshot;
	  }
	| { readonly type: "message"; readonly target: string; readonly sender: string }
	| { readonly type: "transcript"; readonly target: string };
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

interface LiveAgent {
	id: string;
	rootSessionId: string;
	parentId?: string;
	cwd: string;
	description: string;
	status: SubagentStatus;
	message: string;
	result?: string;
	error?: string;
	startedAt: number;
	completedAt?: number;
	toolUses: number;
	cost: number;
	tokenCount: number;
	contextPercent?: number;
	compactions: number;
	compacting: boolean;
	activeTools: string[];
	latestInnerTool?: string;
	modelRole?: AgentModelRole;
	session?: AgentSession;
	runtime?: RunResult["runtime"];
	abortController: AbortController;
	request?: SpawnRequest;
	forkedHistory: AgentMessage[];
	pendingMessage?: string;
	pendingMessages: string[];
	pendingRuntimeMessages: { message: string; triggerTurn: boolean }[];
	transcriptGeneration: number;
	turnGeneration: number;
	activeTurnGeneration?: number;
	turnRuntimes: Map<number, RunResult["runtime"]>;
	transcriptFile?: string;
	restoredMessages?: readonly AgentMessage[];
	sessionUnsubscribe?: () => void;
	forkNonBoundaryTimestamps: Set<number>;
	pendingNonBoundaryMessages: string[];
}
export interface CoordinatorOptions {
	maxConcurrency?: number;
	maxDepth?: number;
	rootSessionDir?: string;
	run?: typeof runAgent;
}

export interface SubagentConfig {
	maxConcurrency: number;
	maxDepth: number;
}

export function loadSubagentConfig(agentDir = getAgentDir()): SubagentConfig {
	const path = join(agentDir, "subagents.json");
	if (!existsSync(path)) return { maxConcurrency: DEFAULT_MAX_CONCURRENCY, maxDepth: DEFAULT_MAX_DEPTH };
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Invalid subagent config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object") throw new Error(`Invalid subagent config ${path}: expected an object`);
	const input = value as Record<string, unknown>;
	const maxConcurrency = input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
	if (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1)
		throw new Error(`Invalid subagent config ${path}: maxConcurrency must be an integer >= 1`);
	if (!Number.isInteger(maxDepth) || (maxDepth as number) < 1)
		throw new Error(`Invalid subagent config ${path}: maxDepth must be an integer >= 1`);
	return { maxConcurrency: maxConcurrency as number, maxDepth: maxDepth as number };
}
export function subagentSessionDir(rootSessionDir: string, canonicalPath: string): string {
	const relative = canonicalPath.replace(/^\/root\/?/, "");
	if (!relative || relative.split("/").some((segment) => !/^[a-z0-9-]+$/.test(segment))) {
		throw new Error(`Invalid canonical subagent path: ${canonicalPath}`);
	}
	return join(rootSessionDir, "subagents", ...relative.split("/"));
}
function depth(path: string): number {
	return path.split("/").filter(Boolean).length - 1;
}

function isCanonicalAgentPath(value: unknown): value is string {
	return typeof value === "string" && /^\/root(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(value);
}

function isPersistedAgentState(value: unknown): value is PersistedSubagentState {
	if (!value || typeof value !== "object") return false;
	const agent = value as Partial<PersistedSubagentState>;
	const validParent =
		agent.parentId === undefined
			? isCanonicalAgentPath(agent.id) && depth(agent.id) === 1
			: (agent.parentId === "/root" || isCanonicalAgentPath(agent.parentId)) &&
				isCanonicalAgentPath(agent.id) &&
				agent.id.startsWith(`${agent.parentId}/`) &&
				depth(agent.id) === depth(agent.parentId) + 1;
	const validRole =
		agent.modelRole === undefined ||
		(typeof agent.modelRole === "object" &&
			typeof agent.modelRole.name === "string" &&
			typeof agent.modelRole.color === "string");
	return (
		validParent &&
		typeof agent.cwd === "string" &&
		typeof agent.description === "string" &&
		typeof agent.message === "string" &&
		["queued", "running", "idle", "failed", "interrupted"].includes(agent.status ?? "") &&
		Number.isFinite(agent.startedAt) &&
		(agent.completedAt === undefined || Number.isFinite(agent.completedAt)) &&
		Number.isFinite(agent.toolUses) &&
		Number.isFinite(agent.cost) &&
		Number.isFinite(agent.tokenCount) &&
		(agent.contextPercent === undefined || Number.isFinite(agent.contextPercent)) &&
		Number.isFinite(agent.compactions) &&
		Number.isFinite(agent.transcriptGeneration) &&
		(agent.result === undefined || typeof agent.result === "string") &&
		(agent.error === undefined || typeof agent.error === "string") &&
		(agent.transcriptFile === undefined || typeof agent.transcriptFile === "string") &&
		(agent.forkNonBoundaryTimestamps === undefined ||
			(Array.isArray(agent.forkNonBoundaryTimestamps) &&
				agent.forkNonBoundaryTimestamps.every((timestamp) => Number.isFinite(timestamp)))) &&
		validRole
	);
}

export function latestSubagentTreeCheckpoint(entries: readonly SessionEntry[]): SubagentTreeCheckpoint | undefined {
	const agents = new Map<string, PersistedSubagentState>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_STATE_ENTRY_TYPE) continue;
		const event = entry.data as Partial<PersistedSubagentEvent> | undefined;
		if (event?.version !== 1 || !isPersistedAgentState(event.agent)) continue;
		agents.set(event.agent.id, event.agent);
	}
	if (agents.size === 0) return undefined;
	return Object.freeze({
		version: 1,
		agents: Object.freeze([...agents.values()].sort((left, right) => left.id.localeCompare(right.id))),
	});
}

function loadPersistedTranscript(file: string | undefined): readonly AgentMessage[] | undefined {
	if (!file || !existsSync(file)) return undefined;
	try {
		const manager = SessionManager.open(file);
		return Object.freeze([...buildSessionContext(manager.getEntries(), manager.getLeafId()).messages]);
	} catch {
		return undefined;
	}
}

function compactText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, 512);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return compactText(content);
	if (!Array.isArray(content)) return "";
	return compactText(
		content
			.flatMap((part) => {
				if (!part || typeof part !== "object") return [];
				const item = part as Record<string, unknown>;
				if (item.type === "text") return [item.text];
				if (item.type === "image") return ["[image]"];
				return [];
			})
			.join(" "),
	);
}

function transcriptPreview(message: AgentMessage | undefined): TranscriptPreview | undefined {
	if (!message) return undefined;
	if (message.role === "user") return Object.freeze({ kind: "user", text: contentText(message.content) });
	if (message.role === "toolResult") {
		return Object.freeze({ kind: "tool", label: message.toolName, text: contentText(message.content) });
	}
	if (message.role === "assistant") {
		for (let index = message.content.length - 1; index >= 0; index--) {
			const part = message.content[index];
			if (!part) continue;
			if (part.type === "toolCall") {
				return Object.freeze({ kind: "tool", label: part.name, text: compactText(JSON.stringify(part.arguments)) });
			}
			if (part.type === "text" && compactText(part.text)) {
				return Object.freeze({ kind: "assistant", text: compactText(part.text) });
			}
			if (part.type === "thinking" && compactText(part.thinking)) {
				return Object.freeze({ kind: "assistant", label: "thinking", text: compactText(part.thinking) });
			}
		}
		return undefined;
	}
	if (message.role === "bashExecution") {
		const output = compactText(message.output);
		return Object.freeze({ kind: "bash", label: message.command, text: output || message.command });
	}
	if (message.role === "custom") {
		return Object.freeze({ kind: "custom", label: message.customType, text: contentText(message.content) });
	}
	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		return Object.freeze({ kind: "summary", text: compactText(message.summary) });
	}
	return undefined;
}

function messageCost(message: AgentMessage): number {
	if (message.role !== "assistant" && message.role !== "toolResult") return 0;
	return reportedCost(message.usage);
}

function reportedCost(usage: { cost?: { total?: number } } | undefined): number {
	const cost = usage?.cost?.total ?? 0;
	return Number.isFinite(cost) && cost > 0 ? cost : 0;
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
			? Object.freeze({ kind: "compacting" as const })
			: visibleTool
				? Object.freeze({ kind: "tool" as const, name: visibleTool })
				: undefined,
		modelRole: agent.modelRole ? Object.freeze({ ...agent.modelRole }) : undefined,
		transcriptAvailable: Boolean(agent.session || agent.restoredMessages),
	});
}

function persistedStateOf(agent: LiveAgent): PersistedSubagentState {
	const transcriptFile = agent.session?.sessionManager.getSessionFile?.() ?? agent.transcriptFile;
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
		modelRole: agent.modelRole ? Object.freeze({ ...agent.modelRole }) : undefined,
		transcriptFile: transcriptFile ?? undefined,
		transcriptGeneration: agent.transcriptGeneration,
		forkNonBoundaryTimestamps: Object.freeze(
			[...agent.forkNonBoundaryTimestamps].sort((left, right) => left - right),
		),
	});
}

export class SubagentCoordinator {
	readonly rootSessionId: string;
	private readonly agents = new Map<string, LiveAgent>();
	private readonly childSessions = new Map<string, string>();
	private readonly listeners = new Set<(event: CoordinatorUpdate) => void>();
	private readonly rootMessages: Array<{ sender: string; message: string }> = [];
	private readonly queue: LiveAgent[] = [];
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
		const config = loadSubagentConfig();
		this.maxConcurrency = options.maxConcurrency ?? config.maxConcurrency;
		this.maxDepth = options.maxDepth ?? config.maxDepth;
		if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1)
			throw new Error("maxConcurrency must be an integer >= 1");
		if (!Number.isInteger(this.maxDepth) || this.maxDepth < 1) throw new Error("maxDepth must be an integer >= 1");
		this.run = options.run ?? runAgent;
	}
	spawn(callerPath: string | undefined, request: SpawnRequest): string {
		if (!this.rootSessionDir && !callerPath) this.rootSessionDir = request.ctx.sessionManager.getSessionDir();
		const parent = callerPath ?? "/root";
		if (depth(parent) >= this.maxDepth) throw new Error(`Agent depth limit ${this.maxDepth} reached at ${parent}`);
		if (!/^[a-z0-9-]+$/.test(request.taskName))
			throw new Error("task_name must use lowercase letters, digits, and hyphens");
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
			forkNonBoundaryTimestamps: new Set(),
			pendingNonBoundaryMessages: [],
			transcriptGeneration: 0,
			turnGeneration: 0,
			turnRuntimes: new Map(),
		};
		this.agents.set(id, agent);
		this.emit({ type: "spawned", agent: snapshotOf(agent) });
		this.queue.push(agent);
		this.drain();
		return id;
	}
	async sendMessage(callerPath: string | undefined, target: string, message: string): Promise<boolean> {
		if (target === "/root") {
			const sender = callerPath ?? "/root";
			this.rootMessages.push({ sender, message });
			this.emit({ type: "message", target, sender });
			return true;
		}
		const agent = this.requireTarget(callerPath, target);
		if (agent.status !== "running" || !agent.session) {
			if (agent.status === "running") agent.pendingRuntimeMessages.push({ message, triggerTurn: false });
			else agent.pendingMessages.push(message);
			this.emit({ type: "message", target: agent.id, sender: callerPath ?? "/root" });
			return true;
		}
		agent.pendingNonBoundaryMessages.push(contentText(message));
		await agent.session.steer(message);
		this.emit({ type: "message", target: agent.id, sender: callerPath ?? "/root" });
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
		if (!agent.session && !agent.request) {
			throw new Error(`Agent ${agent.id} was restored as history and cannot be continued in this process`);
		}
		agent.status = "queued";
		agent.startedAt = Date.now();
		agent.completedAt = undefined;
		agent.result = undefined;
		agent.error = undefined;
		agent.abortController = new AbortController();
		if (agent.session && !agent.runtime) {
			agent.sessionUnsubscribe?.();
			agent.sessionUnsubscribe = undefined;
			agent.session = undefined;
		}
		if (agent.session) {
			agent.pendingMessage = message;
		} else if (agent.restoredMessages && agent.request) {
			agent.request = { ...agent.request, message };
			agent.forkedHistory = [...agent.restoredMessages];
		} else {
			agent.pendingMessages.push(message);
		}
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
		} else if (previous === "running") {
			agent.abortController.abort();
		} else throw new Error(`Agent ${agent.id} has no active turn`);
		agent.status = "interrupted";
		agent.completedAt = Date.now();
		this.emit({ type: "interrupted", agent: snapshotOf(agent) });
		return previous;
	}
	snapshot(): readonly SubagentSnapshot[] {
		return Object.freeze(
			[...this.agents.values()].map(snapshotOf).sort((left, right) => left.id.localeCompare(right.id)),
		);
	}
	checkpoint(): SubagentTreeCheckpoint {
		const agents = [...this.agents.values()]
			.map(persistedStateOf)
			.sort((left, right) => left.id.localeCompare(right.id));
		return Object.freeze({ version: 1, agents: Object.freeze(agents) });
	}
	persistedAgent(target: string): PersistedSubagentState | undefined {
		const agent = this.agents.get(target);
		return agent ? persistedStateOf(agent) : undefined;
	}
	restore(checkpoint: SubagentTreeCheckpoint, runtime?: Pick<SpawnRequest, "ctx" | "pi">): void {
		if (this.agents.size > 0) throw new Error("Cannot restore agent history into a non-empty coordinator");
		for (const saved of checkpoint.agents) {
			const wasActive = saved.status === "queued" || saved.status === "running";
			const restoredMessages = loadPersistedTranscript(saved.transcriptFile);
			const agent: LiveAgent = {
				id: saved.id,
				rootSessionId: this.rootSessionId,
				parentId: saved.parentId,
				cwd: saved.cwd,
				description: saved.description,
				status: wasActive ? "interrupted" : saved.status,
				message: saved.message,
				result: saved.result,
				error: saved.error,
				startedAt: saved.startedAt,
				completedAt: wasActive ? Date.now() : saved.completedAt,
				toolUses: saved.toolUses,
				cost: saved.cost,
				tokenCount: saved.tokenCount,
				contextPercent: saved.contextPercent,
				compactions: saved.compactions,
				compacting: false,
				activeTools: [],
				modelRole: saved.modelRole ? { ...saved.modelRole } : undefined,
				abortController: new AbortController(),
				request: runtime
					? {
							taskName: saved.id.split("/").at(-1)!,
							message: saved.message,
							pi: runtime.pi,
							ctx: runtime.ctx,
							agentConfig: saved.modelRole ? { role: saved.modelRole.name } : {},
							forkTurns: "none",
							cwd: saved.cwd,
						}
					: undefined,
				forkedHistory: [],
				pendingMessages: [],
				pendingRuntimeMessages: [],
				transcriptGeneration: saved.transcriptGeneration,
				turnGeneration: 0,
				turnRuntimes: new Map(),
				transcriptFile: saved.transcriptFile,
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
				if (event.type === "message" || event.type === "settled" || event.type === "interrupted") finish(event);
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
	drainRootMessages(): readonly { readonly sender: string; readonly message: string }[] {
		return Object.freeze(this.rootMessages.splice(0).map((message) => Object.freeze({ ...message })));
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
			this.disposeRuntime(agent.runtime);
			for (const runtime of agent.turnRuntimes.values()) this.disposeRuntime(runtime);
			agent.turnRuntimes.clear();
		}
		this.agents.clear();
		this.queue.length = 0;
		this.listeners.clear();
		this.childSessions.clear();
		this.rootMessages.length = 0;
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
			const agent = this.queue.shift();
			if (!agent) return;
			this.start(agent);
		}
	}
	private start(agent: LiveAgent): void {
		const turnGeneration = ++agent.turnGeneration;
		agent.activeTurnGeneration = turnGeneration;
		agent.status = "running";
		agent.startedAt = Date.now();
		this.running++;
		this.emit({ type: "started", agent: snapshotOf(agent) });
		if (agent.session) {
			const message = agent.pendingMessage;
			agent.pendingMessage = undefined;
			if (!message) throw new Error(`Agent ${agent.id} has no pending follow-up message`);
			const queued = agent.pendingMessages.splice(0);
			void this.continue(agent, [...queued, message].join("\n\n"), turnGeneration);
			return;
		}
		const request = agent.request;
		if (!request) throw new Error(`Agent ${agent.id} has no runnable session state`);
		const initialMessage = [request.message, ...agent.pendingMessages.splice(0)].join("\n\n");
		void this.run(request.ctx, initialMessage, {
			pi: request.pi,
			agentConfig: request.agentConfig,
			collaboration: {
				agentPath: agent.id,
				maxConcurrency: this.maxConcurrency,
				maxDepth: this.maxDepth,
			},
			cwd: request.cwd,
			sessionDir: subagentSessionDir(this.rootSessionDir ?? request.ctx.sessionManager.getSessionDir(), agent.id),
			signal: agent.abortController.signal,
			forkedHistory: agent.forkedHistory,
			onRuntimeResolved: (role) => {
				if (!this.disposed && agent.turnGeneration === turnGeneration) agent.modelRole = role;
			},
			onRuntimeCreated: (runtime) => {
				if (this.disposed || agent.turnGeneration !== turnGeneration) {
					this.disposeRuntime(runtime);
					return;
				}
				agent.turnRuntimes.set(turnGeneration, runtime);
			},
			onToolActivity: (activity) => this.recordToolActivity(agent, activity, turnGeneration),
			onUserMessage: (message) => this.recordUserMessage(agent, message),
			onSessionCreated: (session) => {
				if (this.disposed || agent.turnGeneration !== turnGeneration) return;
				agent.session = session;
				agent.transcriptFile = session.sessionManager.getSessionFile?.() ?? undefined;
				agent.restoredMessages = undefined;
				this.refreshSessionStats(agent, session);
				this.childSessions.set(session.sessionManager.getSessionId(), agent.id);
				bindSessionToRoot(this.rootSessionId, session.sessionManager.getSessionId());
				agent.sessionUnsubscribe = session.subscribe((event) => {
					let metadataChanged = false;
					if (event.type === "compaction_start") {
						agent.compacting = true;
						metadataChanged = true;
					}
					if (event.type === "message_end") {
						agent.cost += messageCost(event.message);
						this.refreshSessionStats(agent, session);
						metadataChanged = true;
					}
					if (event.type === "compaction_end" && !event.aborted) {
						agent.transcriptGeneration++;
						agent.cost += reportedCost(event.result?.usage);
						agent.compactions++;
						agent.compacting = false;
						this.refreshSessionStats(agent, session);
						metadataChanged = true;
					}
					if (event.type === "compaction_end" && event.aborted) {
						agent.compacting = false;
						metadataChanged = true;
					}
					if (event.type === "turn_end" || event.type === "agent_settled") {
						this.refreshSessionStats(agent, session);
						metadataChanged = true;
					}
					if (metadataChanged) this.emit({ type: "updated", agent: snapshotOf(agent) });
					this.emit({ type: "transcript", target: agent.id });
				});
				for (const pending of agent.pendingRuntimeMessages.splice(0)) {
					if (pending.triggerTurn) void session.followUp(pending.message);
					else {
						agent.pendingNonBoundaryMessages.push(contentText(pending.message));
						void session.steer(pending.message);
					}
				}
				this.emit({ type: "checkpoint", agent: snapshotOf(agent) });
			},
		}).then(
			(result) => this.finish(agent, result, turnGeneration),
			(error) => this.fail(agent, error, turnGeneration),
		);
	}
	private async continue(agent: LiveAgent, message: string, turnGeneration: number): Promise<void> {
		try {
			const result = await resumeAgent(agent.session!, message, {
				signal: agent.abortController.signal,
				onToolActivity: (activity) => {
					this.recordToolActivity(agent, activity, turnGeneration);
				},
				onUserMessage: (message) => this.recordUserMessage(agent, message),
			});
			this.finish(
				agent,
				{ responseText: result.responseText, session: agent.session!, runtime: agent.runtime! },
				turnGeneration,
			);
		} catch (error) {
			this.fail(agent, error, turnGeneration);
		}
	}
	private releaseTurn(agent: LiveAgent, turnGeneration: number): boolean {
		if (agent.activeTurnGeneration !== turnGeneration) return false;
		agent.activeTurnGeneration = undefined;
		this.running = Math.max(0, this.running - 1);
		return true;
	}
	private finish(agent: LiveAgent, result: RunResult, turnGeneration: number): void {
		const turnRuntime = agent.turnRuntimes.get(turnGeneration);
		agent.turnRuntimes.delete(turnGeneration);
		const released = this.releaseTurn(agent, turnGeneration);
		if (this.disposed || agent.status !== "running" || agent.turnGeneration !== turnGeneration) {
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
		this.emit({ type: "settled", agent: snapshotOf(agent) });
		this.drain();
	}
	private fail(agent: LiveAgent, error: unknown, turnGeneration: number): void {
		const turnRuntime = agent.turnRuntimes.get(turnGeneration);
		agent.turnRuntimes.delete(turnGeneration);
		if (turnRuntime !== agent.runtime) this.disposeRuntime(turnRuntime);
		const released = this.releaseTurn(agent, turnGeneration);
		if (this.disposed || agent.status !== "running" || agent.turnGeneration !== turnGeneration) {
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
	private recordToolActivity(agent: LiveAgent, activity: ToolActivity, turnGeneration: number): void {
		if (agent.turnGeneration !== turnGeneration) return;
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
	private disposeRuntime(runtime: RunResult["runtime"] | undefined): void {
		if (!runtime || this.disposedRuntimes.has(runtime) || typeof runtime.dispose !== "function") return;
		this.disposedRuntimes.add(runtime);
		void runtime.dispose().catch(() => undefined);
	}

	private refreshSessionStats(agent: LiveAgent, session: AgentSession): void {
		const stats = session.getSessionStats();
		agent.tokenCount = stats.tokens.total;
		agent.contextPercent = stats.contextUsage?.percent ?? undefined;
	}
}

const DIRECTORY_KEY = Symbol.for("pi.subagents.coordinator-directory.v1");
type CoordinatorDirectory = { roots: Map<string, SubagentCoordinator>; sessionRoots: Map<string, string> };
const globalDirectory = globalThis as typeof globalThis & { [DIRECTORY_KEY]?: CoordinatorDirectory };
if (!globalDirectory[DIRECTORY_KEY]) globalDirectory[DIRECTORY_KEY] = { roots: new Map(), sessionRoots: new Map() };
const directory = globalDirectory[DIRECTORY_KEY];
const { roots, sessionRoots } = directory;
export function createRootCoordinator(rootSessionId: string, options?: CoordinatorOptions): SubagentCoordinator {
	if (roots.has(rootSessionId)) throw new Error(`Coordinator already exists for ${rootSessionId}`);
	const coordinator = new SubagentCoordinator(rootSessionId, options);
	roots.set(rootSessionId, coordinator);
	sessionRoots.set(rootSessionId, rootSessionId);
	return coordinator;
}
export function bindSessionToRoot(rootSessionId: string, sessionId: string): void {
	if (!roots.has(rootSessionId)) throw new Error(`No coordinator exists for ${rootSessionId}`);
	sessionRoots.set(sessionId, rootSessionId);
}
export function getCoordinatorForSession(sessionId: string): SubagentCoordinator | undefined {
	const root = sessionRoots.get(sessionId);
	return root ? roots.get(root) : undefined;
}
export function removeRootCoordinator(rootSessionId: string): void {
	const coordinator = roots.get(rootSessionId);
	if (!coordinator) return;
	coordinator.dispose();
	roots.delete(rootSessionId);
	for (const [sessionId, root] of sessionRoots) if (root === rootSessionId) sessionRoots.delete(sessionId);
}
