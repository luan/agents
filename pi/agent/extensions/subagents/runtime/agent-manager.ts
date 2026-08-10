/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { findRetryableError, resumeAgent, retryFailedTurn, runAgent, type ToolActivity } from "./agent-runner.js";
import { childSessionDir, type PersistedAgent } from "./persistence.js";
import type { AgentConfig, AgentEvent, AgentRecord, IsolationMode, SubagentType } from "./types.js";
import { type AssistantUsage, addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "./worktree.js";

type OnAgentComplete = (record: AgentRecord) => void;
type OnAgentStart = (record: AgentRecord) => void;
type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
type OnAgentRemove = (record: AgentRecord) => void;
type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;
const MAX_RETAINED_TERMINAL_AGENTS = 100;
const TERMINAL_AGENT_RETENTION_MS = 10 * 60_000;

interface SpawnArgs {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	type: SubagentType;
	prompt: string;
	options: SpawnOptions;
}

interface SpawnOptions {
	description: string;
	rootSessionId: string;
	parentAgentId?: string;
	parentSessionId: string;
	assignment: string;
	id?: string;
	agentConfig: AgentConfig;
	resolveRuntime?: () => { pi: ExtensionAPI; ctx: ExtensionContext } | undefined;
	isBackground?: boolean;
	/** Isolation mode — "worktree" creates a temp git worktree for the agent. */
	isolation?: IsolationMode;
	/** Override working directory for the agent. */
	cwd?: string;
	/** Parent abort signal — when aborted, the subagent is also stopped. */
	signal?: AbortSignal;
	/** Called on tool start/end with activity info (for streaming progress to UI). */
	onToolActivity?: (activity: ToolActivity) => void;
	/** Called on streaming text deltas from the assistant response. */
	onTextDelta?: (delta: string, fullText: string) => void;
	/** Called when the agent session is created (for accessing session stats). */
	onSessionCreated?: (session: AgentSession) => void;
	/** Called at the end of each agentic turn with the cumulative count. */
	onTurnEnd?: (turnCount: number) => void;
	/** Called once per assistant message_end with that message's usage delta. */
	onAssistantUsage?: (usage: AssistantUsage, durationMs: number) => void;
	/** Called when the session successfully compacts. */
	onCompaction?: (info: CompactionInfo) => void;
}

interface ResumeOptions {
	signal?: AbortSignal;
	deliverCompletion?: boolean;
	onAssistantUsage?: (usage: AssistantUsage, durationMs: number) => void;
	rootSessionId?: string;
}

export class AgentManager {
	private agents = new Map<string, AgentRecord>();
	private cleanupInterval: ReturnType<typeof setInterval>;
	private onComplete?: OnAgentComplete;
	private onStart?: OnAgentStart;
	private onCompact?: OnAgentCompact;
	private onRemove?: OnAgentRemove;
	private maxConcurrent: number;
	private maxRetainedTerminal: number;

	/** Queue of background agents waiting to start. */
	private queue: { id: string; args: SpawnArgs }[] = [];
	/** Number of currently running background agents. */
	private runningBackground = 0;
	private foregroundWaiters = new Map<string, () => void>();
	private parentSignalDetachers = new Map<string, () => void>();

	constructor(
		onComplete?: OnAgentComplete,
		maxConcurrent = DEFAULT_MAX_CONCURRENT,
		onStart?: OnAgentStart,
		onCompact?: OnAgentCompact,
		onRemove?: OnAgentRemove,
		maxRetainedTerminal = MAX_RETAINED_TERMINAL_AGENTS,
	) {
		this.onComplete = onComplete;
		this.onStart = onStart;
		this.onCompact = onCompact;
		this.onRemove = onRemove;
		this.maxConcurrent = maxConcurrent;
		this.maxRetainedTerminal = maxRetainedTerminal;
		// Keep terminal agents briefly for inspection, then remove them from memory and persistence.
		this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
		this.cleanupInterval.unref();
	}

	private findRecord(id: string, rootSessionId?: string): AgentRecord | undefined {
		const direct = this.agents.get(id);
		if (direct && (!rootSessionId || direct.rootSessionId === rootSessionId)) return direct;
		return [...this.agents.values()].find(
			(record) => record.id === id && (!rootSessionId || record.rootSessionId === rootSessionId),
		);
	}

	private deleteRecord(record: AgentRecord): void {
		for (const [key, candidate] of this.agents) {
			if (candidate !== record) continue;
			this.agents.delete(key);
			return;
		}
	}

	/**
	 * Spawn an agent and return its ID immediately (for background use).
	 * If the concurrency limit is reached, the agent is queued.
	 */
	spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
		const requestedId = options.id
			?.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		const localId = requestedId || randomUUID().slice(0, 17);
		const id = options.parentAgentId ? `${options.parentAgentId}/${localId}` : localId;
		if (this.agents.has(id)) throw new Error(`Agent id already exists: ${id}`);
		const abortController = new AbortController();
		const record: AgentRecord = {
			id,
			type,
			description: options.description,
			status: options.isBackground ? "queued" : "running",
			rootSessionId: options.rootSessionId,
			parentSessionId: options.parentSessionId,
			parentAgentId: options.parentAgentId,
			agentConfig: options.agentConfig,
			assignment: options.assignment,
			cwd: options.cwd ?? ctx.cwd,
			events: [],
			isBackground: options.isBackground === true,
			toolUses: 0,
			startedAt: Date.now(),
			abortController,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
			compactionCount: 0,
		};
		this.agents.set(id, record);

		const args: SpawnArgs = { pi, ctx, type, prompt, options };

		if (options.isBackground && this.runningBackground >= this.maxConcurrent) {
			// Queue it — will be started when a running agent completes
			this.queue.push({ id, args });
			return id;
		}

		// startAgent can throw (e.g. strict worktree-isolation failure) — clean
		// up the record so callers don't see an orphan in `listAgents()`.
		try {
			this.startAgent(id, record, args);
		} catch (err) {
			this.agents.delete(id);
			throw err;
		}
		return id;
	}

	/** Actually start an agent (called immediately or from queue drain). */
	private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
		const runtime = options.resolveRuntime ? options.resolveRuntime() : { pi, ctx };
		if (!runtime) throw new Error(`Parent session unavailable for queued agent ${id}`);
		const baseCwd = record.cwd;
		// Worktree isolation: try to create a temporary git worktree. Strict —
		// fail loud if not possible (no silent fallback to main tree). Done
		// BEFORE state mutation so a throw doesn't leave the record half-running.
		let worktreeCwd: string | undefined;
		if (options.isolation === "worktree") {
			const wt = createWorktree(baseCwd, id);
			if (!wt) {
				throw new Error(
					'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
						"Initialize git and commit at least once, or omit `isolation`.",
				);
			}
			record.worktree = wt;
			worktreeCwd = wt.path;
		}

		record.status = "running";
		record.startedAt = Date.now();
		if (options.isBackground) this.runningBackground++;
		this.onStart?.(record);

		// Wire parent abort signal to stop the subagent when the parent is interrupted
		let detachParentSignal: (() => void) | undefined;
		if (options.signal) {
			const onParentAbort = () => this.abort(id);
			if (options.signal.aborted) onParentAbort();
			else {
				options.signal.addEventListener("abort", onParentAbort, { once: true });
				detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
			}
		}
		const detach = () => {
			this.parentSignalDetachers.get(id)?.();
			this.parentSignalDetachers.delete(id);
		};
		this.parentSignalDetachers.set(id, () => {
			detachParentSignal?.();
			detachParentSignal = undefined;
		});

		const promise = runAgent(runtime.ctx, type, prompt, {
			pi: runtime.pi,
			description: options.description,
			agentConfig: options.agentConfig,
			sessionDir: childSessionDir(record.rootSessionId, id),
			onRuntimeResolved: (model, thinkingLevel) => {
				record.modelName = modelLabel(model);
				record.thinkingLevel = thinkingLevel;
			},
			cwd: worktreeCwd ?? options.cwd,
			signal: record.abortController!.signal,
			onToolActivity: (activity) => {
				if (activity.type === "end") record.toolUses++;
				this.pushEvent(record, {
					type: activity.type === "start" ? "tool-start" : "tool-end",
					at: Date.now(),
					toolName: activity.toolName,
				});
				options.onToolActivity?.(activity);
			},
			onTurnEnd: (turnCount) => {
				this.pushEvent(record, { type: "turn-end", at: Date.now(), turnCount });
				options.onTurnEnd?.(turnCount);
			},
			onTextDelta: (delta, fullText) => {
				this.pushEvent(record, { type: "text", at: Date.now(), text: delta });
				options.onTextDelta?.(delta, fullText);
			},
			onAssistantUsage: (usage, durationMs) => {
				addUsage(record.lifetimeUsage, usage);
				options.onAssistantUsage?.(usage, durationMs);
			},
			onCompaction: (info) => {
				record.compactionCount++;
				this.pushEvent(record, { type: "compaction", at: Date.now(), tokensBefore: info.tokensBefore });
				this.onCompact?.(record, info);
				options.onCompaction?.(info);
			},
			onRuntimeCreated: (agentRuntime) => {
				record.runtime = agentRuntime;
			},
			onSessionCreated: (session) => {
				record.session = session;
				record.sessionFile = session.sessionManager.getSessionFile();
				record.childSessionId = session.sessionManager.getSessionId();
				// Flush any steers that arrived before the session was ready
				if (record.pendingSteers?.length) {
					for (const msg of record.pendingSteers) {
						session.steer(msg).catch(() => {});
					}
					record.pendingSteers = undefined;
				}
				options.onSessionCreated?.(session);
			},
		})
			.then(({ responseText, session, runtime: agentRuntime, aborted, steered, error }) => {
				// Don't overwrite status if externally stopped via abort()
				if (record.status !== "stopped") {
					record.status = error ? "error" : aborted ? "aborted" : steered ? "steered" : "completed";
				}
				record.result = responseText;
				record.error = error;
				record.runtime = agentRuntime;
				record.session = agentRuntime.session ?? session;
				record.completedAt ??= Date.now();

				detach();

				// Final flush of streaming output file
				if (record.outputCleanup) {
					try {
						record.outputCleanup();
					} catch {
						/* ignore */
					}
					record.outputCleanup = undefined;
				}

				// Clean up worktree if used
				if (record.worktree) {
					const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
					record.worktreeResult = wtResult;
					if (wtResult.hasChanges && wtResult.branch) {
						record.result =
							(record.result ?? "") +
							`\n\n---\nChanges saved to branch \`${wtResult.branch}\`. Merge with: \`git merge ${wtResult.branch}\``;
					}
				}

				this.enforceRetention(record.rootSessionId);
				if (record.isBackground) {
					this.runningBackground = Math.max(0, this.runningBackground - 1);
					try {
						this.onComplete?.(record);
					} catch {
						/* ignore completion side-effect errors */
					}
					this.drainQueue();
				}
				this.foregroundWaiters.get(id)?.();
				this.foregroundWaiters.delete(id);
				return responseText;
			})
			.catch((err) => {
				// Don't overwrite status if externally stopped via abort()
				if (record.status !== "stopped") {
					record.status = "error";
				}
				record.error = err instanceof Error ? err.message : String(err);
				record.completedAt ??= Date.now();

				detach();

				// Final flush of streaming output file on error
				if (record.outputCleanup) {
					try {
						record.outputCleanup();
					} catch {
						/* ignore */
					}
					record.outputCleanup = undefined;
				}

				// Best-effort worktree cleanup on error
				if (record.worktree) {
					try {
						const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
						record.worktreeResult = wtResult;
					} catch {
						/* ignore cleanup errors */
					}
				}

				this.enforceRetention(record.rootSessionId);
				if (record.isBackground) {
					this.runningBackground = Math.max(0, this.runningBackground - 1);
					try {
						this.onComplete?.(record);
					} catch {
						/* ignore completion side-effect errors */
					} finally {
						this.drainQueue();
					}
				}
				this.foregroundWaiters.get(id)?.();
				this.foregroundWaiters.delete(id);
				return "";
			});

		record.promise = promise;
	}

	/** Start queued agents up to the concurrency limit. */
	private drainQueue() {
		while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
			const queued = this.queue[0]!;
			if (queued.args.options.resolveRuntime && !queued.args.options.resolveRuntime()) break;
			const next = this.queue.shift()!;
			const record = this.agents.get(next.id);
			if (!record || record.status !== "queued") continue;
			try {
				this.startAgent(next.id, record, next.args);
			} catch (err) {
				// Late failure (e.g. strict worktree-isolation) — surface on the record
				// so the user/agent can see it via /agents, then keep draining.
				record.status = "error";
				record.error = err instanceof Error ? err.message : String(err);
				record.completedAt = Date.now();
				this.enforceRetention(record.rootSessionId);
				this.onComplete?.(record);
			}
		}
	}

	drain(): void {
		this.drainQueue();
	}

	/** Resume an agent, reopening its persisted child session when necessary. */
	async resume(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		id: string,
		prompt: string,
		options: ResumeOptions = {},
	): Promise<AgentRecord | undefined> {
		const record = this.findRecord(id, options.rootSessionId);
		const session = record?.runtime?.session ?? record?.session;
		if (!record || (!session && (!record.sessionFile || !record.agentConfig))) return undefined;
		this.beginTurn(record, options.deliverCompletion === true);

		try {
			if (session) {
				const turn = await resumeAgent(session, prompt, this.turnOptions(record, options));
				this.finishTurn(record, turn.responseText, turn.error);
			} else {
				const agentConfig = record.agentConfig;
				if (!agentConfig) return undefined;
				const turn = await runAgent(ctx, record.type, prompt, {
					pi,
					description: record.description,
					agentConfig,
					cwd: record.cwd,
					sessionFile: record.sessionFile,
					...this.persistedTurnOptions(record, options),
				});
				record.runtime = turn.runtime;
				record.session = turn.runtime.session;
				record.sessionFile = turn.runtime.session.sessionManager.getSessionFile();
				this.finishTurn(record, turn.responseText, turn.error);
			}
		} catch (err) {
			this.finishTurn(record, "", err instanceof Error ? err.message : String(err));
		}
		return record;
	}

	async retry(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		id: string,
		options: ResumeOptions = {},
	): Promise<AgentRecord | undefined> {
		const record = this.findRecord(id, options.rootSessionId);
		const session = record?.runtime?.session ?? record?.session;
		if (!record || (!session && (!record.sessionFile || !record.agentConfig))) return undefined;
		if (session && !findRetryableError(session.sessionManager.getBranch())) return undefined;
		if (record.sessionFile && !session) {
			const persistedSession = SessionManager.open(record.sessionFile, undefined, record.cwd);
			if (!findRetryableError(persistedSession.getBranch())) return undefined;
		}
		this.beginTurn(record, options.deliverCompletion === true);

		try {
			if (session) {
				const turn = await retryFailedTurn(session, this.turnOptions(record, options));
				this.finishTurn(record, turn.responseText, turn.error);
			} else {
				const agentConfig = record.agentConfig;
				if (!agentConfig) return undefined;
				const turn = await runAgent(ctx, record.type, record.assignment, {
					pi,
					description: record.description,
					agentConfig,
					cwd: record.cwd,
					sessionFile: record.sessionFile,
					retry: true,
					...this.persistedTurnOptions(record, options),
				});
				record.runtime = turn.runtime;
				record.session = turn.runtime.session;
				record.sessionFile = turn.runtime.session.sessionManager.getSessionFile();
				this.finishTurn(record, turn.responseText, turn.error);
			}
		} catch (err) {
			this.finishTurn(record, "", err instanceof Error ? err.message : String(err));
		}
		return record;
	}

	async waitForForeground(id: string): Promise<void> {
		const record = this.agents.get(id);
		if (!record || record.isBackground || record.status !== "running") return;
		await new Promise<void>((resolve) => this.foregroundWaiters.set(id, resolve));
	}

	background(id: string): boolean {
		const record = this.agents.get(id);
		if (!record || record.isBackground || record.status !== "running") return false;
		record.isBackground = true;
		this.runningBackground++;
		this.parentSignalDetachers.get(id)?.();
		this.onStart?.(record);
		this.parentSignalDetachers.delete(id);
		this.foregroundWaiters.get(id)?.();
		this.foregroundWaiters.delete(id);
		return true;
	}

	async steer(id: string, message: string, rootSessionId?: string): Promise<boolean> {
		const record = this.findRecord(id, rootSessionId);
		if (!record || record.status !== "running") return false;
		const session = record.runtime?.session ?? record.session;
		if (!session) {
			record.pendingSteers ??= [];
			record.pendingSteers.push(message);
			return true;
		}
		await session.steer(message);
		return true;
	}

	private beginTurn(record: AgentRecord, deliverCompletion: boolean): void {
		if (deliverCompletion) record.completionDelivered = false;
		record.status = "running";
		record.startedAt = Date.now();
		record.completedAt = undefined;
		record.result = undefined;
		record.error = undefined;
		record.abortController = new AbortController();
		if (record.isBackground) this.runningBackground++;
		this.onStart?.(record);
	}

	private finishTurn(record: AgentRecord, result: string, error?: string): void {
		record.status = error ? "error" : "completed";
		record.result = result;
		record.error = error;
		record.completedAt = Date.now();
		this.enforceRetention(record.rootSessionId);
		if (record.isBackground) {
			this.runningBackground = Math.max(0, this.runningBackground - 1);
			this.onComplete?.(record);
			this.drainQueue();
		}
	}

	private pushEvent(record: AgentRecord, event: AgentEvent): void {
		record.events.push(event);
		if (record.events.length > 100) record.events.splice(0, record.events.length - 100);
	}

	private turnOptions(record: AgentRecord, options: ResumeOptions) {
		return {
			signal: options.signal,
			onToolActivity: (activity: ToolActivity) => {
				if (activity.type === "end") record.toolUses++;
				this.pushEvent(record, {
					type: activity.type === "start" ? "tool-start" : "tool-end",
					at: Date.now(),
					toolName: activity.toolName,
				});
			},
			onAssistantUsage: (usage: AssistantUsage, durationMs: number) => {
				addUsage(record.lifetimeUsage, usage);
				options.onAssistantUsage?.(usage, durationMs);
			},
			onCompaction: (info: CompactionInfo) => {
				record.compactionCount++;
				this.pushEvent(record, { type: "compaction", at: Date.now(), tokensBefore: info.tokensBefore });
				this.onCompact?.(record, info);
			},
		};
	}

	private persistedTurnOptions(record: AgentRecord, options: ResumeOptions) {
		return {
			onRuntimeCreated: (runtime: AgentRecord["runtime"]) => {
				record.runtime = runtime;
			},
			onSessionCreated: (session: AgentSession) => {
				record.session = session;
				record.sessionFile = session.sessionManager.getSessionFile();
			},
			...this.turnOptions(record, options),
		};
	}

	getLatestRetryableRecord(): AgentRecord | undefined {
		return this.listAgents().find((record) => {
			const session = record.runtime?.session ?? record.session;
			return session ? findRetryableError(session.sessionManager.getBranch()) !== undefined : false;
		});
	}

	restore(records: PersistedAgent[], enforceRetention = true): void {
		const rootSessionIds = new Set<string>();
		for (const persisted of records) {
			const id = persisted.id.replace(/^\/root\//, "");
			const rootSessionId = persisted.rootSessionId ?? persisted.parentSessionId;
			if (this.findRecord(id, rootSessionId)) continue;
			rootSessionIds.add(rootSessionId);
			const storageKey = this.agents.has(id) ? `${rootSessionId}\0${id}` : id;
			this.agents.set(storageKey, {
				...persisted,
				id,
				parentAgentId: persisted.parentAgentId?.replace(/^\/root\//, ""),
				rootSessionId,
				status: persisted.status === "running" || persisted.status === "queued" ? "interrupted" : persisted.status,
				events: persisted.events ?? [],
			});
		}
		if (enforceRetention) {
			for (const rootSessionId of rootSessionIds) this.enforceRetention(rootSessionId);
		}
	}

	getRecord(id: string, rootSessionId?: string): AgentRecord | undefined {
		return this.findRecord(id, rootSessionId);
	}

	listAgents(rootSessionId?: string): AgentRecord[] {
		return [...this.agents.values()]
			.filter((record) => !rootSessionId || record.rootSessionId === rootSessionId)
			.sort((a, b) => b.startedAt - a.startedAt);
	}

	findByChildSessionId(sessionId: string): AgentRecord | undefined {
		return [...this.agents.values()].find((record) => record.childSessionId === sessionId);
	}

	getRootSessionId(sessionId: string): string {
		return this.findByChildSessionId(sessionId)?.rootSessionId ?? sessionId;
	}

	abort(id: string, rootSessionId?: string): boolean {
		const record = this.findRecord(id, rootSessionId);
		if (!record) return false;

		// Remove from queue if queued
		if (record.status === "queued") {
			this.queue = this.queue.filter((q) => q.id !== id);
			record.status = "stopped";
			record.completedAt = Date.now();
			this.enforceRetention(record.rootSessionId);
			return true;
		}

		if (record.status !== "running") return false;
		record.abortController?.abort();
		record.status = "stopped";
		record.completedAt = Date.now();
		this.enforceRetention(record.rootSessionId);
		return true;
	}

	private enforceRetention(rootSessionId: string): void {
		const cutoff = Date.now() - TERMINAL_AGENT_RETENTION_MS;
		const terminal = [...this.agents.values()]
			.filter(
				(record) =>
					record.rootSessionId === rootSessionId && record.status !== "running" && record.status !== "queued",
			)
			.sort((left, right) => (right.completedAt ?? right.startedAt) - (left.completedAt ?? left.startedAt));
		for (const [index, record] of terminal.entries()) {
			if (index < this.maxRetainedTerminal && (record.completedAt ?? record.startedAt) >= cutoff) continue;
			record.session?.dispose?.();
			this.deleteRecord(record);
			this.onRemove?.(record);
		}
	}

	private cleanup() {
		const rootSessionIds = new Set([...this.agents.values()].map((record) => record.rootSessionId));
		for (const rootSessionId of rootSessionIds) this.enforceRetention(rootSessionId);
	}

	/** Whether any foreground agents are still running or queued. */
	hasBlockingRunning(): boolean {
		return [...this.agents.values()].some(
			(r) => !r.isBackground && (r.status === "running" || r.status === "queued"),
		);
	}

	/** Whether any agents are still running or queued. */
	hasRunning(): boolean {
		return [...this.agents.values()].some((r) => r.status === "running" || r.status === "queued");
	}

	/** Abort all running and queued agents immediately. */
	abortAll(): number {
		let count = 0;
		const rootSessionIds = new Set<string>();
		// Clear queued agents first
		for (const queued of this.queue) {
			const record = this.agents.get(queued.id);
			if (record) {
				record.status = "stopped";
				record.completedAt = Date.now();
				rootSessionIds.add(record.rootSessionId);
				count++;
			}
		}
		this.queue = [];
		// Abort running agents
		for (const record of this.agents.values()) {
			if (record.status === "running") {
				record.abortController?.abort();
				record.status = "stopped";
				record.completedAt = Date.now();
				rootSessionIds.add(record.rootSessionId);
				count++;
			}
		}
		for (const rootSessionId of rootSessionIds) this.enforceRetention(rootSessionId);
		return count;
	}

	/** Wait for all running and queued agents to complete (including queued ones). */
	async waitForAll(): Promise<void> {
		// Loop because drainQueue respects the concurrency limit — as running
		// agents finish they start queued ones, which need awaiting too.
		while (true) {
			this.drainQueue();
			const pending = [...this.agents.values()]
				.filter((r) => r.status === "running" || r.status === "queued")
				.map((r) => r.promise)
				.filter(Boolean);
			if (pending.length === 0) break;
			await Promise.allSettled(pending);
		}
	}

	dispose() {
		clearInterval(this.cleanupInterval);
		// Clear queue
		this.queue = [];
		for (const record of this.agents.values()) {
			record.session?.dispose();
		}
		this.agents.clear();
		// Prune any orphaned git worktrees (crash recovery)
		try {
			pruneWorktrees(process.cwd());
		} catch {
			/* ignore */
		}
	}
}

function modelLabel(model: Model<any> | undefined): string | undefined {
	const name = model?.name || model?.id;
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}
