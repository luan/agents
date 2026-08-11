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
import { loadModelRoles, resolveModelRole, roleColor, roleNames } from "../../model-roles/catalog.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { isSubagentOrchestrationToolName } from "./orchestration-tools.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import type { AgentConfig, AgentModelRole, SubagentType, ThinkingLevel } from "./types.js";
import { type AssistantUsage, readAssistantUsage } from "./usage.js";

const GRACE_TURNS = 5;

/** Extract text from a message content block array. */
function extractText(content: unknown[]): string {
	return content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text ?? "")
		.join("\n");
}

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
function normalizeMaxTurns(n: number | undefined): number | undefined {
	if (n == null || n === 0) return undefined;
	return Math.max(1, n);
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
	type: "start" | "end";
	toolName: string;
}

interface RunOptions {
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
	/** Called after model role resolution. */
	onRuntimeResolved?: (modelRole: AgentModelRole | undefined) => void;
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

interface RunResult {
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

interface AgentTurnResult {
	responseText: string;
	error?: string;
}

/** Error of the latest turn when it ended in a provider failure, else undefined. */
export function findRetryableError(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason !== "error") return undefined;
		return entry.message.errorMessage || "Assistant request failed";
	}
	return undefined;
}

/**
 * Re-issue the failed provider request, keeping every completed step of the turn.
 *
 * The failure and any tool calls it left unanswered are dropped from the live context so
 * `continue()` resumes from the last user or tool result message. Session entries keep the
 * failure for history; providers skip errored assistant messages when building requests.
 */
async function resumeFailedRequest(session: AgentSession): Promise<void> {
	const messages = session.agent.state.messages;
	let keep = messages.length;
	while (keep > 0) {
		const message = messages[keep - 1];
		if (message.role !== "assistant") break;
		// Trailing assistant messages are the failure itself or a request whose tool calls
		// never produced results — both block continue() and must not be replayed.
		if (message.stopReason === "stop" || message.stopReason === "length") break;
		keep--;
	}
	if (keep < messages.length) session.agent.state.messages = messages.slice(0, keep);
	await session.agent.continue();
}

function getActiveTurnError(session: AgentSession): string | undefined {
	return findRetryableError(session.sessionManager.getBranch());
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

export function resolveSessionRuntimeOptions(modelRegistry: object): Record<string, unknown> {
	const modelRuntime = (modelRegistry as { runtime?: unknown }).runtime;
	if (modelRuntime) return { modelRuntime };
	return { modelRegistry };
}

export interface PreparedAgentRun {
	effectiveCwd: string;
	agentDir: string;
	systemPrompt: string;
	toolNames: string[];
	selectedToolNames: Set<string>;
	noSkills: boolean;
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	modelRole: AgentModelRole | undefined;
	loader: DefaultResourceLoader;
	disallowedSet: Set<string> | undefined;
}

export async function prepareAgentRun(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: Pick<RunOptions, "agentConfig" | "cwd" | "description" | "pi" | "onRuntimeResolved">,
	loadResources = true,
): Promise<PreparedAgentRun> {
	const agentConfig = options.agentConfig;
	const effectiveCwd = options.cwd ?? ctx.cwd;
	const env = await detectEnv(options.pi, effectiveCwd);
	const extras: PromptExtras = { delegatedTask: { taskName: options.description ?? type, message: prompt } };
	const skills = agentConfig.skills;

	if (Array.isArray(skills)) {
		const loaded = preloadSkills(skills, effectiveCwd);
		if (loaded.length > 0) extras.skillBlocks = loaded;
	}

	const selectedToolNames = new Set(agentConfig.toolNames ?? options.pi.getActiveTools());
	let toolNames = [...selectedToolNames];
	if (agentConfig.memory) {
		const existingNames = new Set(toolNames);
		const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
		const hasWriteTools =
			(existingNames.has("write") && !denied?.has("write")) || (existingNames.has("edit") && !denied?.has("edit"));
		const extraNames = missingToolNames(
			hasWriteTools ? MEMORY_TOOL_NAMES : READ_ONLY_MEMORY_TOOL_NAMES,
			existingNames,
		);
		if (extraNames.length > 0) {
			toolNames = [...toolNames, ...extraNames];
			for (const name of extraNames) selectedToolNames.add(name);
		}
		extras.memoryBlock = hasWriteTools
			? buildMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd)
			: buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
	}

	const systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, ctx.getSystemPrompt(), extras);
	const noSkills = skills === false || Array.isArray(skills);
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: effectiveCwd,
		agentDir,
		noSkills,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	if (loadResources) await loader.reload();

	const catalog = loadModelRoles();
	const role = resolveModelRole(agentConfig.role, ctx.modelRegistry, catalog);
	const model = role?.model ?? ctx.model;
	const thinkingLevel = role?.candidate.thinking ?? (model?.reasoning ? options.pi.getThinkingLevel() : undefined);
	const modelRole = role
		? {
				name: role.roleName,
				color: roleColor(catalog.roles[role.roleName]!, roleNames(catalog).indexOf(role.roleName)),
			}
		: undefined;
	options.onRuntimeResolved?.(modelRole);

	return {
		effectiveCwd,
		agentDir,
		systemPrompt,
		toolNames,
		selectedToolNames,
		noSkills,
		model,
		thinkingLevel,
		modelRole,
		loader,
		disallowedSet: agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined,
	};
}

export async function runAgent(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: RunOptions,
): Promise<RunResult> {
	const agentConfig = options.agentConfig;
	const prepared = await prepareAgentRun(ctx, type, prompt, options);
	const {
		effectiveCwd,
		agentDir,
		systemPrompt,
		toolNames,
		selectedToolNames,
		model,
		thinkingLevel,
		loader,
		disallowedSet,
	} = prepared;
	const noSkills = prepared.noSkills;
	const loadResources = async (cwd: string, resourceAgentDir: string) => {
		if (cwd === effectiveCwd && resourceAgentDir === agentDir) return loader;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: resourceAgentDir,
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

	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile, options.sessionDir, effectiveCwd)
		: SessionManager.create(effectiveCwd, options.sessionDir);
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
	if (agentConfig.role) sessionManager.appendCustomEntry("model_role", { role: agentConfig.role });
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
			if (!findRetryableError(session.sessionManager.getBranch())) {
				throw new Error("No failed assistant turn is available to retry");
			}
			await resumeFailedRequest(session);
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
	if (!findRetryableError(session.sessionManager.getBranch())) {
		throw new Error("No failed assistant turn is available to retry");
	}

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
		await resumeFailedRequest(session);
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
