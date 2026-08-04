/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree";

export interface ModelCategory {
	model: string;
	thinking?: ThinkingLevel;
}

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
	name: string;
	displayName?: string;
	description: string;
	/** Optional exact tool allowlist. Omitted = inherit the parent active tools. */
	toolNames?: string[];
	/** Tool denylist — these tools are removed even if the parent defaults or allowlist include them. */
	disallowedTools?: string[];
	/** true = inherit all, string[] = only listed, false = none */
	extensions: true | string[] | false;
	/** true = inherit all, string[] = only listed, false = none */
	skills: true | string[] | false;
	modelCategory?: string;
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	systemPrompt: string;
	promptMode: "replace" | "append";
	/** Persistent memory scope. */
	memory?: MemoryScope;
	/** true = this is an embedded default agent (informational) */
	isDefault?: boolean;
	/** false = agent is hidden from the registry */
	enabled?: boolean;
	/** Where this agent was loaded from */
	source?: "default" | "project" | "global";
}

type JoinMode = "async" | "group" | "smart";

export interface AgentEvent {
	type: "tool-start" | "tool-end" | "text" | "turn-end" | "compaction";
	at: number;
	toolName?: string;
	text?: string;
	turnCount?: number;
	tokensBefore?: number;
}

export interface AgentRecord {
	id: string;
	type: SubagentType;
	description: string;
	status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "interrupted" | "error";
	result?: string;
	error?: string;
	toolUses: number;
	startedAt: number;
	completedAt?: number;
	/** Display label for the effective model used by this agent. */
	modelName?: string;
	/** Effective reasoning effort / thinking level used by this agent. */
	thinkingLevel?: ThinkingLevel;
	/** Whether the current provider request is using OpenAI priority service tier. */
	fastModeActive?: boolean;
	/** Root Pi session that owns the complete descendant tree. */
	rootSessionId: string;
	/** Immediate parent Pi session. */
	parentSessionId: string;
	/** Parent agent path; omitted for agents spawned by the root session. */
	parentAgentId?: string;
	/** Session id created for this agent, used to attach recursive children. */
	childSessionId?: string;
	/** Agent configuration snapshot used for queued starts and persisted resume. */
	agentConfig?: AgentConfig;
	/** Original delegated assignment, retained for inspection and restoration. */
	assignment: string;
	/** Working directory used by the child session. */
	cwd: string;
	/** Persisted child session JSONL path. */
	sessionFile?: string;
	/** Whether completion has been delivered to the owning parent session. */
	completionDelivered?: boolean;
	/** Whether lifetime usage has been persisted to the owning root session. */
	usageReported?: boolean;
	/** Recent structured activity for the HUD and inspector. */
	events: AgentEvent[];
	/** True for agents intentionally running outside the current inline tool call. */
	isBackground?: boolean;
	session?: AgentSession;
	runtime?: AgentSessionRuntime;
	abortController?: AbortController;
	promise?: Promise<string>;
	groupId?: string;
	joinMode?: JoinMode;
	/** Set when result was already consumed — suppresses completion notification. */
	resultConsumed?: boolean;
	/** Steering messages queued before the session was ready. */
	pendingSteers?: string[];
	/** Worktree info if the agent is running in an isolated worktree. */
	worktree?: { path: string; branch: string };
	/** Worktree cleanup result after agent completion. */
	worktreeResult?: { hasChanges: boolean; branch?: string };
	/** The tool_use_id from the original spawn call. */
	toolCallId?: string;
	/** Path to the streaming output transcript file. */
	outputFile?: string;
	/** Cleanup function for the output file stream subscription. */
	outputCleanup?: () => void;
	/**
	 * Lifetime usage breakdown, accumulated via `message_end` events. Survives
	 * compaction. Total = input + output + cacheWrite (cacheRead deliberately
	 * excluded — see issue #38). Initialized to zeros at spawn.
	 */
	lifetimeUsage: LifetimeUsage;
	/** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
	compactionCount: number;
	/** Visual identity for full-session mosaic panes. */
	mosaicIdentity?: {
		label: string;
		color: string;
	};
}

export interface EnvInfo {
	isGitRepo: boolean;
	branch: string;
	platform: string;
}
