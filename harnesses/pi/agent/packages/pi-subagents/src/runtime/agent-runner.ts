import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeResult,
	createAgentSession,
	createAgentSessionRuntime,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ModelRuntime,
	type SessionEntry,
	SessionManager,
	type SessionStartEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { listCodeModeToolNames } from "pi-code-mode/sdk";
import { getModelRoleCatalog, resolveModelRole, seedChildModelRole } from "pi-model-roles/sdk";
import { SUBAGENT_TASK_MESSAGE_TYPE } from "../core/fork-history.ts";
import { buildAgentPrompt } from "../core/prompts.ts";
import type { AgentConfig, AgentModelRole } from "../core/types.ts";
import { createNestedToolActivityReader } from "./nested-tool-activity.ts";

type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];

function extractText(content: AssistantContent): string {
	return content
		.filter((item): item is Extract<AssistantContent[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export interface ToolActivity {
	type: "start" | "end";
	toolName: string;
	nested?: boolean;
}

export interface RunOptions {
	pi: ExtensionAPI;
	agentConfig: AgentConfig;
	collaboration?: {
		agentPath: string;
		maxConcurrency: number;
		maxDepth: number;
		completionDelivery?: "none" | "parent";
	};
	signal?: AbortSignal;
	cwd?: string;
	sessionDir?: string;
	forkedHistory?: AgentMessage[];
	onToolActivity?: (activity: ToolActivity) => void;
	onUserMessage?: (message: AgentMessage) => void;
	onSessionCreated?: (session: AgentSession) => void;
	onRuntimeCreated?: (runtime: AgentSessionRuntime) => void;
	onRuntimeResolved?: (modelRole: AgentModelRole | undefined) => void;
}

export interface RunResult {
	responseText: string;
	session: AgentSession;
	runtime: AgentSessionRuntime;
	error?: string;
}

interface AgentTurnResult {
	responseText: string;
	error?: string;
}

type AgentTaskContext = { agentPath: string };

function parentAgentPath(agentPath: string): string {
	return agentPath.slice(0, agentPath.lastIndexOf("/")) || "/root";
}

function taskContent(prompt: string, context: AgentTaskContext): string {
	return `Message Type: NEW_TASK\nTask name: ${context.agentPath}\nSender: ${parentAgentPath(context.agentPath)}\nPayload:\n${prompt}`;
}

export function sendAgentTask(
	session: AgentSession,
	prompt: string,
	context: AgentTaskContext,
	options: { deliverAs?: "followUp" | "nextTurn"; triggerTurn?: boolean } = {},
): Promise<void> {
	return session.sendCustomMessage(
		{
			customType: SUBAGENT_TASK_MESSAGE_TYPE,
			content: taskContent(prompt, context),
			display: false,
			details: { version: 1, target: context.agentPath, sender: parentAgentPath(context.agentPath) },
		},
		options,
	);
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

function collectResponseText(session: AgentSession, onUserMessage?: (message: AgentMessage) => void) {
	let response = "";
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start" && event.message.role === "user") onUserMessage?.(event.message);
		if (event.type === "message_start") response = "";
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			response += event.assistantMessageEvent.delta;
		}
	});
	return { getText: () => response, unsubscribe };
}

function getLastAssistantText(session: AgentSession): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message.role !== "assistant") continue;
		const text = extractText(message.content).trim();
		if (text) return text;
	}
	return "";
}

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
	if (!signal) return () => {};
	const onAbort = () => void session.abort();
	if (signal.aborted) {
		onAbort();
		return () => {};
	}
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

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

type ModelRegistryRuntimeBoundary = { runtime?: ModelRuntime };

/**
 * Pi 0.84 exposes ModelRuntime only through ModelRegistry's private compatibility field.
 * Remove this adapter when the extension context exposes its runtime publicly.
 */
function modelRuntimeFor(modelRegistry: ExtensionContext["modelRegistry"]): ModelRuntime {
	// type-boundary: Pi 0.84's ModelRegistry owns this runtime; the AgentSession factory validates it immediately.
	const runtime = (modelRegistry as object as ModelRegistryRuntimeBoundary).runtime;
	if (!runtime) throw new Error("Pi model runtime is unavailable to the subagent session");
	return runtime;
}

export interface PreparedAgentRun {
	effectiveCwd: string;
	agentDir: string;
	systemPrompt: string;
	toolNames: string[];
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	modelRole: AgentModelRole | undefined;
	loader: DefaultResourceLoader;
}

export function resolveChildToolNames(active: readonly string[], lifted: readonly string[]): string[] {
	return [...new Set([...active, ...lifted])];
}

export async function prepareAgentRun(
	ctx: ExtensionContext,
	options: Pick<RunOptions, "agentConfig" | "collaboration" | "cwd" | "pi" | "onRuntimeResolved">,
	loadResources = true,
): Promise<PreparedAgentRun> {
	const effectiveCwd = options.cwd ?? ctx.cwd;
	const toolNames = resolveChildToolNames(options.pi.getActiveTools(), listCodeModeToolNames());
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

	const catalog = getModelRoleCatalog();
	const models =
		ctx.scopedModels.length > 0 ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
	const resolved = options.agentConfig.role ? resolveModelRole(options.agentConfig.role, catalog, models) : undefined;
	const model = resolved?.model ?? ctx.model;
	const thinkingLevel = resolved?.candidate.thinking ?? (model?.reasoning ? options.pi.getThinkingLevel() : undefined);
	const modelRole = resolved ? { name: resolved.role.name, color: resolved.role.color } : undefined;
	options.onRuntimeResolved?.(modelRole);

	return { effectiveCwd, agentDir, systemPrompt, toolNames, model, thinkingLevel, modelRole, loader };
}

export async function runAgent(ctx: ExtensionContext, prompt: string, options: RunOptions): Promise<RunResult> {
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
	for (const message of options.forkedHistory ?? []) {
		// type-boundary: Pi's AgentMessage union includes summary variants accepted by the runtime but omitted from appendMessage's public parameter.
		sessionManager.appendMessage(message as object as Parameters<SessionManager["appendMessage"]>[0]);
	}
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
		const result = await createAgentSession({
			cwd,
			agentDir: runtimeAgentDir,
			sessionManager: runtimeSessionManager,
			settingsManager,
			modelRuntime: modelRuntimeFor(ctx.modelRegistry),
			model,
			thinkingLevel,
			tools: toolNames,
			resourceLoader,
			sessionStartEvent,
		});
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
	if (options.agentConfig.role) seedChildModelRole(sessionManager, options.agentConfig.role);
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: effectiveCwd, agentDir, sessionManager });
	options.onRuntimeCreated?.(runtime);

	const session = runtime.session;
	options.onSessionCreated?.(session);
	await session.bindExtensions({
		onError: (error) => {
			options.onToolActivity?.({ type: "end", toolName: `extension-error:${error.extensionPath}` });
		},
	});

	const unsubscribeTools = subscribeToolActivity(session, options.onToolActivity);
	const collector = collectResponseText(session, options.onUserMessage);
	const cleanupAbort = forwardAbortSignal(session, options.signal);
	try {
		if (options.collaboration) await sendAgentTask(session, prompt, options.collaboration, { triggerTurn: true });
		else await session.prompt(prompt);
	} finally {
		unsubscribeTools();
		collector.unsubscribe();
		cleanupAbort();
	}

	const activeSession = runtime.session;
	return {
		responseText: collector.getText().trim() || getLastAssistantText(activeSession),
		session: activeSession,
		runtime,
		error: getActiveTurnError(activeSession),
	};
}

export async function resumeAgent(
	session: AgentSession,
	prompt: string,
	options: {
		collaboration?: AgentTaskContext;
		onToolActivity?: (activity: ToolActivity) => void;
		onUserMessage?: (message: AgentMessage) => void;
		signal?: AbortSignal;
	} = {},
): Promise<AgentTurnResult> {
	const collector = collectResponseText(session, options.onUserMessage);
	const cleanupAbort = forwardAbortSignal(session, options.signal);
	const unsubscribeTools = subscribeToolActivity(session, options.onToolActivity);
	try {
		if (options.collaboration) await sendAgentTask(session, prompt, options.collaboration, { triggerTurn: true });
		else await session.prompt(prompt);
	} finally {
		collector.unsubscribe();
		unsubscribeTools();
		cleanupAbort();
	}
	return {
		responseText: collector.getText().trim() || getLastAssistantText(session),
		error: getActiveTurnError(session),
	};
}
