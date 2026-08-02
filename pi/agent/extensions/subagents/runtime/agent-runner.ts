/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import type { Model } from "@earendil-works/pi-ai";
import type {
	CreateAgentSessionRuntimeResult,
	ExtensionContext,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentSession,
	type AgentSessionEvent,
	AgentSessionRuntime,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { extractText } from "./context.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { loadModelCategories, resolveModelCategory } from "./model-categories.js";
import { resolveDefaultModel } from "./model-resolver.js";
import { isSubagentOrchestrationToolName } from "./orchestration-tools.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import type { AgentConfig, SubagentType, ThinkingLevel } from "./types.js";
import { type AssistantUsage, readAssistantUsage } from "./usage.js";

const GRACE_TURNS = 5;

function isGeneratedDelta(event: AgentSessionEvent): boolean {
	return (
		event.type === "message_update" &&
		(event.assistantMessageEvent.type === "text_delta" ||
			event.assistantMessageEvent.type === "thinking_delta" ||
			event.assistantMessageEvent.type === "toolcall_delta")
	);
}

const MEMORY_TOOL_NAMES = ["read", "write", "edit"];
const READ_ONLY_MEMORY_TOOL_NAMES = ["read"];

function missingToolNames(required: string[], existing: Set<string>): string[] {
	return required.filter((name) => !existing.has(name));
}

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
	if (n == null || n === 0) return undefined;
	return Math.max(1, n);
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
	type: "start" | "end";
	toolName: string;
}

export interface RunOptions {
	/** ExtensionAPI instance — used for pi.exec() instead of execSync. */
	pi: ExtensionAPI;
	description?: string;
	agentConfig: AgentConfig;
	signal?: AbortSignal;
	/** Override working directory (e.g. for worktree isolation). */
	cwd?: string;
	/** Directory for a new persistent child session. */
	sessionDir?: string;
	/** Existing child session JSONL to reopen. */
	sessionFile?: string;
	/** Retry the latest failed turn instead of appending a new prompt. */
	retry?: boolean;
	/** Called on tool start/end with activity info. */
	onToolActivity?: (activity: ToolActivity) => void;
	/** Called on streaming text deltas from the assistant response. */
	onTextDelta?: (delta: string, fullText: string) => void;
	onSessionCreated?: (session: AgentSession) => void;
	onRuntimeCreated?: (runtime: AgentSessionRuntime) => void;
	/** Called after model and thinking settings are resolved. */
	onRuntimeResolved?: (model: Model<any> | undefined, thinkingLevel: ThinkingLevel | undefined) => void;
	/** Called at the end of each agentic turn with the cumulative count. */
	onTurnEnd?: (turnCount: number) => void;
	/**
	 * Called once per assistant message_end with that message's usage delta.
	 * Lets callers maintain a lifetime accumulator that survives compaction
	 * (which replaces session.state.messages and resets stats-derived sums).
	 */
	onAssistantUsage?: (usage: AssistantUsage, durationMs: number) => void;
	/**
	 * Called when the session successfully compacts. `tokensBefore` is upstream's
	 * pre-compaction context size estimate. Aborted compactions don't fire.
	 */
	onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

export interface RunResult {
	responseText: string;
	session: AgentSession;
	runtime: AgentSessionRuntime;
	/** True if the agent was hard-aborted (max_turns + grace exceeded). */
	aborted: boolean;
	/** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
	steered: boolean;
	/** Final provider error after automatic retries are exhausted. */
	error?: string;
}

export interface AgentTurnResult {
	responseText: string;
	error?: string;
}

export interface RetryableTurn {
	userEntryId: string;
	content: Parameters<AgentSession["sendUserMessage"]>[0];
	error: string;
}

export function findRetryableTurn(entries: readonly SessionEntry[]): RetryableTurn | undefined {
	let failedAssistantIndex = -1;
	let error: string | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason !== "error") return undefined;
		failedAssistantIndex = index;
		error = entry.message.errorMessage || "Assistant request failed";
		break;
	}
	if (failedAssistantIndex === -1 || !error) return undefined;

	for (let index = failedAssistantIndex - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "user") {
			return {
				userEntryId: entry.id,
				content: entry.message.content as Parameters<AgentSession["sendUserMessage"]>[0],
				error,
			};
		}
	}
	return undefined;
}

function getActiveTurnError(session: AgentSession): string | undefined {
	return findRetryableTurn(session.sessionManager.getBranch())?.error;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
	let text = "";
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start") {
			text = "";
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			text += event.assistantMessageEvent.delta;
		}
	});
	return { getText: () => text, unsubscribe };
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const msg = session.messages[i];
		if (msg.role !== "assistant") continue;
		const text = extractText(msg.content).trim();
		if (text) return text;
	}
	return "";
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
	if (!signal) return () => {};
	const onAbort = () => session.abort();
	if (signal.aborted) {
		onAbort();
		return () => {};
	}
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

export function filterExtensionsByPath<T extends { path: string; resolvedPath: string }>(
	extensions: readonly T[],
	allowedPaths: readonly string[],
): T[] {
	const normalizedAllowed = allowedPaths.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, ""));
	return extensions.filter((extension) =>
		normalizedAllowed.some((allowedPath) =>
			[extension.path, extension.resolvedPath].some((path) => {
				const normalizedPath = path.replaceAll("\\", "/");
				return normalizedPath === allowedPath || normalizedPath.endsWith(`/${allowedPath}`);
			}),
		),
	);
}

export function resolveSessionRuntimeOptions(modelRegistry: object): Record<string, unknown> {
	const modelRuntime = (modelRegistry as { runtime?: unknown }).runtime;
	if (modelRuntime) return { modelRuntime };
	return { modelRegistry };
}

export async function runAgent(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: RunOptions,
): Promise<RunResult> {
	const agentConfig = options.agentConfig;
	const config = {
		displayName: agentConfig.displayName ?? agentConfig.name,
		description: agentConfig.description,
		toolNames: agentConfig.toolNames,
		extensions: agentConfig.extensions,
		skills: agentConfig.skills,
		promptMode: agentConfig.promptMode,
	};

	// Resolve working directory: worktree override > parent cwd
	const effectiveCwd = options.cwd ?? ctx.cwd;

	const env = await detectEnv(options.pi, effectiveCwd);

	// Get parent system prompt for append-mode agents
	const parentSystemPrompt = ctx.getSystemPrompt();

	// Build prompt extras (memory, skill preloading)
	const extras: PromptExtras = { delegatedTask: { taskName: options.description ?? type, message: prompt } };

	const extensions = config.extensions;
	const skills = config.skills;

	// Skill preloading: when skills is string[], preload their content into prompt
	if (Array.isArray(skills)) {
		const loaded = preloadSkills(skills, effectiveCwd);
		if (loaded.length > 0) {
			extras.skillBlocks = loaded;
		}
	}

	const parentActiveToolNames = new Set(options.pi.getActiveTools());
	const explicitAllowedToolNames = agentConfig.toolNames;
	const selectedToolNames = new Set(explicitAllowedToolNames ?? [...parentActiveToolNames]);
	let toolNames = [...selectedToolNames];

	// Persistent memory: detect write capability and branch accordingly.
	// Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
	if (agentConfig.memory) {
		const existingNames = new Set(toolNames);
		const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
		const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
		const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

		if (hasWriteTools) {
			const extraNames = missingToolNames(MEMORY_TOOL_NAMES, existingNames);
			if (extraNames.length > 0) {
				toolNames = [...toolNames, ...extraNames];
				for (const name of extraNames) selectedToolNames.add(name);
			}
			extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
		} else {
			// Read-only memory: only add read tool name, use read-only prompt
			const extraNames = missingToolNames(READ_ONLY_MEMORY_TOOL_NAMES, existingNames);
			if (extraNames.length > 0) {
				toolNames = [...toolNames, ...extraNames];
				for (const name of extraNames) selectedToolNames.add(name);
			}
			extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
		}
	}

	const systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);

	// When skills is string[], we've already preloaded them into the prompt.
	// Still pass noSkills: true since we don't need the skill loader to load them again.
	const noSkills = skills === false || Array.isArray(skills);

	const agentDir = getAgentDir();

	// Load extensions/skills: true or string[] → load; false → don't.
	// Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
	// buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
	// would defeat prompt_mode: replace and isolated: true. Parent context, if
	// wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
	// is embedded in systemPromptOverride) or inherit_context (conversation).
	const loadResources = async (cwd: string, resourceAgentDir: string) => {
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: resourceAgentDir,
			noExtensions: extensions === false,
			extensionsOverride: Array.isArray(extensions)
				? (base) => ({ ...base, extensions: filterExtensionsByPath(base.extensions, extensions) })
				: undefined,
			noSkills,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		return resourceLoader;
	};
	const loader = await loadResources(effectiveCwd, agentDir);

	const category = resolveModelCategory(
		agentConfig.modelCategory,
		ctx.modelRegistry,
		loadModelCategories(effectiveCwd),
	);

	// Resolve model: config.model > config.modelCategory > parent model
	const model = resolveDefaultModel(category.model ?? ctx.model, ctx.modelRegistry, agentConfig.model);

	// Resolve thinking level: agent config > model category > parent
	const thinkingLevel =
		agentConfig.thinking ?? category.thinking ?? (model?.reasoning ? options.pi.getThinkingLevel() : undefined);
	options.onRuntimeResolved?.(model, thinkingLevel);

	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile, options.sessionDir, effectiveCwd)
		: SessionManager.create(effectiveCwd, options.sessionDir);
	const disallowedSet = agentConfig?.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
	const createRuntime = async ({
		cwd,
		agentDir: runtimeAgentDir,
		sessionManager: runtimeSessionManager,
		sessionStartEvent,
	}: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	}): Promise<CreateAgentSessionRuntimeResult> => {
		const settingsManager = SettingsManager.create(cwd, runtimeAgentDir);
		const resourceLoader =
			runtimeSessionManager === sessionManager ? loader : await loadResources(cwd, runtimeAgentDir);
		const sessionOpts = {
			cwd,
			agentDir: runtimeAgentDir,
			sessionManager: runtimeSessionManager,
			settingsManager,
			...resolveSessionRuntimeOptions(ctx.modelRegistry),
			model,
			tools: toolNames,
			resourceLoader,
			sessionStartEvent,
		} as NonNullable<Parameters<typeof createAgentSession>[0]>;
		if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;

		const result = await createAgentSession(sessionOpts);
		const activeTools = result.session.getActiveToolNames().filter((toolName) => {
			if (isSubagentOrchestrationToolName(toolName)) return false;
			if (disallowedSet?.has(toolName)) return false;
			return selectedToolNames.has(toolName);
		});
		result.session.setActiveToolsByName(activeTools);
		return {
			...result,
			services: {
				cwd,
				agentDir: runtimeAgentDir,
				modelRuntime: result.session.modelRuntime,
				settingsManager,
				resourceLoader,
				diagnostics: [],
			},
			diagnostics: [],
		};
	};
	const initialRuntime = await createRuntime({
		cwd: effectiveCwd,
		agentDir,
		sessionManager,
	});
	const runtime = new AgentSessionRuntime(
		initialRuntime.session,
		initialRuntime.services,
		createRuntime,
		initialRuntime.diagnostics,
		initialRuntime.modelFallbackMessage,
	);
	const session = runtime.session;
	options.onRuntimeCreated?.(runtime);

	// Publish the child session id before extension session_start hooks run so
	// recursive subagent extensions can attach to their parent record.
	options.onSessionCreated?.(session);

	// Bind extensions so that session_start fires and extensions can initialize
	// (e.g. loading credentials, setting up state). Placed after tool filtering
	// so extension-provided skills/prompts from extendResourcesFromExtensions()
	// respect the active tool set. All ExtensionBindings fields are optional.
	await session.bindExtensions({
		onError: (err) => {
			options.onToolActivity?.({
				type: "end",
				toolName: `extension-error:${err.extensionPath}`,
			});
		},
	});

	// Track turns for graceful max_turns enforcement
	let turnCount = 0;
	const maxTurns = normalizeMaxTurns(agentConfig.maxTurns);
	let softLimitReached = false;
	let aborted = false;

	let currentMessageText = "";
	let messageOpenedAt: number | undefined;
	let firstTokenAt: number | undefined;
	const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "turn_end") {
			turnCount++;
			options.onTurnEnd?.(turnCount);
			if (maxTurns != null) {
				if (!softLimitReached && turnCount >= maxTurns) {
					softLimitReached = true;
					session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
				} else if (softLimitReached && turnCount >= maxTurns + GRACE_TURNS) {
					aborted = true;
					session.abort();
				}
			}
		}
		if (event.type === "message_start") {
			currentMessageText = "";
			if (event.message.role === "assistant") {
				messageOpenedAt = Date.now();
				firstTokenAt = undefined;
			}
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			currentMessageText += event.assistantMessageEvent.delta;
			options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
		}
		if (isGeneratedDelta(event) && firstTokenAt === undefined) firstTokenAt = Date.now();
		if (event.type === "tool_execution_start") {
			options.onToolActivity?.({ type: "start", toolName: event.toolName });
		}
		if (event.type === "tool_execution_end") {
			options.onToolActivity?.({ type: "end", toolName: event.toolName });
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const usage = readAssistantUsage(event.message);
			const startedAt = firstTokenAt ?? messageOpenedAt;
			const durationMs = startedAt === undefined ? undefined : Math.max(1, Date.now() - startedAt);
			messageOpenedAt = undefined;
			firstTokenAt = undefined;
			if (usage && durationMs !== undefined) options.onAssistantUsage?.(usage, durationMs);
		}
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
		}
	});

	const collector = collectResponseText(session);
	const cleanupAbort = forwardAbortSignal(session, options.signal);

	try {
		if (options.retry) {
			const retryable = findRetryableTurn(session.sessionManager.getBranch());
			if (!retryable) throw new Error("No failed assistant turn is available to retry");
			const navigation = await session.navigateTree(retryable.userEntryId);
			if (navigation.cancelled) throw new Error("Retry cancelled while branching away from the failed turn");
			await session.sendUserMessage(retryable.content as Parameters<AgentSession["sendUserMessage"]>[0]);
		} else {
			await session.prompt(prompt);
		}
	} finally {
		unsubTurns();
		collector.unsubscribe();
		cleanupAbort();
	}

	const activeSession = runtime.session;
	const responseText = collector.getText().trim() || getLastAssistantText(activeSession);
	return {
		responseText,
		session: activeSession,
		runtime,
		aborted,
		steered: softLimitReached,
		error: getActiveTurnError(activeSession),
	};
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
	session: AgentSession,
	prompt: string,
	options: {
		onToolActivity?: (activity: ToolActivity) => void;
		onAssistantUsage?: (usage: AssistantUsage, durationMs: number) => void;
		onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
		signal?: AbortSignal;
	} = {},
): Promise<AgentTurnResult> {
	const collector = collectResponseText(session);
	const cleanupAbort = forwardAbortSignal(session, options.signal);

	let messageOpenedAt: number | undefined;
	let firstTokenAt: number | undefined;
	const unsubEvents =
		options.onToolActivity || options.onAssistantUsage || options.onCompaction
			? session.subscribe((event: AgentSessionEvent) => {
					if (event.type === "message_start" && event.message.role === "assistant") {
						messageOpenedAt = Date.now();
						firstTokenAt = undefined;
					}
					if (isGeneratedDelta(event) && firstTokenAt === undefined) firstTokenAt = Date.now();
					if (event.type === "tool_execution_start")
						options.onToolActivity?.({ type: "start", toolName: event.toolName });
					if (event.type === "tool_execution_end")
						options.onToolActivity?.({ type: "end", toolName: event.toolName });
					if (event.type === "message_end" && event.message.role === "assistant") {
						const usage = readAssistantUsage(event.message);
						const startedAt = firstTokenAt ?? messageOpenedAt;
						const durationMs = startedAt === undefined ? undefined : Math.max(1, Date.now() - startedAt);
						messageOpenedAt = undefined;
						firstTokenAt = undefined;
						if (usage && durationMs !== undefined) options.onAssistantUsage?.(usage, durationMs);
					}
					if (event.type === "compaction_end" && !event.aborted && event.result) {
						options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
					}
				})
			: () => {};

	try {
		await session.prompt(prompt);
	} finally {
		collector.unsubscribe();
		unsubEvents();
		cleanupAbort();
	}

	return {
		responseText: collector.getText().trim() || getLastAssistantText(session),
		error: getActiveTurnError(session),
	};
}

export async function retryFailedTurn(
	session: AgentSession,
	options: {
		onToolActivity?: (activity: ToolActivity) => void;
		onAssistantUsage?: (usage: AssistantUsage, durationMs: number) => void;
		onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
		signal?: AbortSignal;
	} = {},
): Promise<AgentTurnResult> {
	const retryable = findRetryableTurn(session.sessionManager.getBranch());
	if (!retryable) throw new Error("No failed assistant turn is available to retry");

	const collector = collectResponseText(session);
	const cleanupAbort = forwardAbortSignal(session, options.signal);
	let messageOpenedAt: number | undefined;
	let firstTokenAt: number | undefined;
	const unsubEvents = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			messageOpenedAt = Date.now();
			firstTokenAt = undefined;
		}
		if (isGeneratedDelta(event) && firstTokenAt === undefined) firstTokenAt = Date.now();
		if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
		if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
		if (event.type === "message_end" && event.message.role === "assistant") {
			const usage = readAssistantUsage(event.message);
			const startedAt = firstTokenAt ?? messageOpenedAt;
			const durationMs = startedAt === undefined ? undefined : Math.max(1, Date.now() - startedAt);
			messageOpenedAt = undefined;
			firstTokenAt = undefined;
			if (usage && durationMs !== undefined) options.onAssistantUsage?.(usage, durationMs);
		}
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
		}
	});

	try {
		const navigation = await session.navigateTree(retryable.userEntryId);
		if (navigation.cancelled) throw new Error("Retry cancelled while branching away from the failed turn");
		await session.sendUserMessage(retryable.content as Parameters<AgentSession["sendUserMessage"]>[0]);
	} finally {
		collector.unsubscribe();
		unsubEvents();
		cleanupAbort();
	}

	return {
		responseText: collector.getText().trim() || getLastAssistantText(session),
		error: getActiveTurnError(session),
	};
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(session: AgentSession, message: string): Promise<void> {
	await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
	const parts: string[] = [];

	for (const msg of session.messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			if (text.trim()) parts.push(`[User]: ${text.trim()}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const toolCalls: string[] = [];
			for (const c of msg.content) {
				if (c.type === "text" && c.text) textParts.push(c.text);
				else if (c.type === "toolCall")
					toolCalls.push(`  Tool: ${(c as any).name ?? (c as any).toolName ?? "unknown"}`);
			}
			if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
			if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
		} else if (msg.role === "toolResult") {
			const text = extractText(msg.content);
			const truncated = text.length > 200 ? `${text.slice(0, 200)}...` : text;
			parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
		}
	}

	return parts.join("\n\n");
}
