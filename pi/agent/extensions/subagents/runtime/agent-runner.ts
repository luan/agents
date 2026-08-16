/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
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
import { createNestedToolActivityReader } from "./nested-tool-activity.js";
import { buildAgentPrompt } from "./prompts.js";
import type { AgentConfig, AgentModelRole } from "./types.js";

/** Extract text from a message content block array. */
function extractText(content: unknown[]): string {
	return content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text ?? "")
		.join("\n");
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
	type: "start" | "end";
	toolName: string;
	nested?: boolean;
}

interface RunOptions {
	/** ExtensionAPI instance — used for pi.exec() instead of execSync. */
	pi: ExtensionAPI;
	agentConfig: AgentConfig;
	collaboration?: { agentPath: string; maxConcurrency: number; maxDepth: number };
	signal?: AbortSignal;
	/** Override the working directory for the child session. */
	cwd?: string;
	/** Directory for a new persistent child session. */
	sessionDir?: string;
	/** Sanitized parent transcript selected by spawn_agent fork_turns. */
	forkedHistory?: AgentMessage[];
	/** Called on tool start/end with activity info. */
	onToolActivity?: (activity: ToolActivity) => void;
	/** Called when a user message enters the child transcript. */
	onUserMessage?: (message: AgentMessage) => void;
	onSessionCreated?: (session: AgentSession) => void;
	onRuntimeCreated?: (runtime: AgentSessionRuntime) => void;
	/** Called after model role resolution. */
	onRuntimeResolved?: (modelRole: AgentModelRole | undefined) => void;
}

export interface RunResult {
	responseText: string;
	session: AgentSession;
	runtime: AgentSessionRuntime;
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

function getActiveTurnError(session: AgentSession): string | undefined {
	return findRetryableError(session.sessionManager.getBranch());
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession, onUserMessage?: (message: AgentMessage) => void) {
	let text = "";
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start" && event.message.role === "user") onUserMessage?.(event.message);
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

/** Forward tool start/end events, splitting a code-mode `exec` cell's nested calls into their own events. */
function subscribeToolActivity(session: AgentSession, onToolActivity?: (activity: ToolActivity) => void): () => void {
	if (!onToolActivity) return () => {};
	const nestedActivity = createNestedToolActivityReader();
	return session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "tool_execution_start") onToolActivity({ type: "start", toolName: event.toolName });
		if (event.type === "tool_execution_update") {
			for (const toolName of nestedActivity.started(event.partialResult)) {
				onToolActivity({ type: "start", toolName, nested: true });
			}
		}
		if (event.type === "tool_execution_end") {
			for (const toolName of nestedActivity.ended(event.result)) {
				onToolActivity({ type: "end", toolName, nested: true });
			}
			onToolActivity({ type: "end", toolName: event.toolName });
		}
	});
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
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	modelRole: AgentModelRole | undefined;
	loader: DefaultResourceLoader;
}

export async function prepareAgentRun(
	ctx: ExtensionContext,
	options: Pick<RunOptions, "agentConfig" | "collaboration" | "cwd" | "pi" | "onRuntimeResolved">,
	loadResources = true,
): Promise<PreparedAgentRun> {
	const effectiveCwd = options.cwd ?? ctx.cwd;
	const toolNames = options.pi.getActiveTools();
	const systemPrompt = buildAgentPrompt(ctx.getSystemPrompt(), options.collaboration);
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: effectiveCwd,
		agentDir,
		noSkills: false,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	if (loadResources) await loader.reload();

	const catalog = loadModelRoles();
	const role = options.agentConfig.role
		? resolveModelRole(options.agentConfig.role, ctx.modelRegistry, catalog)
		: undefined;
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
		model,
		thinkingLevel,
		modelRole,
		loader,
	};
}

export async function runAgent(ctx: ExtensionContext, prompt: string, options: RunOptions): Promise<RunResult> {
	const agentConfig = options.agentConfig;
	const prepared = await prepareAgentRun(ctx, options);
	const { effectiveCwd, agentDir, systemPrompt, toolNames, model, thinkingLevel, loader } = prepared;
	const loadResources = async (cwd: string, resourceAgentDir: string) => {
		if (cwd === effectiveCwd && resourceAgentDir === agentDir) return loader;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: resourceAgentDir,
			noSkills: false,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		return resourceLoader;
	};

	const sessionManager = SessionManager.create(effectiveCwd, options.sessionDir);
	for (const message of options.forkedHistory ?? []) sessionManager.appendMessage(message as never);
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
		const activeTools = result.session.getActiveToolNames().filter((toolName) => toolNames.includes(toolName));
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
	options.onRuntimeCreated?.(runtime);

	const session = runtime.session;

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

	const unsubTurns = subscribeToolActivity(session, options.onToolActivity);

	const collector = collectResponseText(session, options.onUserMessage);
	const cleanupAbort = forwardAbortSignal(session, options.signal);

	try {
		await session.prompt(prompt);
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
		onUserMessage?: (message: AgentMessage) => void;
		signal?: AbortSignal;
	} = {},
): Promise<AgentTurnResult> {
	const collector = collectResponseText(session, options.onUserMessage);
	const cleanupAbort = forwardAbortSignal(session, options.signal);

	const unsubEvents = subscribeToolActivity(session, options.onToolActivity);

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
