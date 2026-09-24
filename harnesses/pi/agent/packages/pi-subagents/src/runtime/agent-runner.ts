import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
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
import { listCodeModeToolNames } from "@luan.sh/pi-code-mode/sdk";
import { appendAgentIdentity } from "../contributions/session-identity.ts";
import { SUBAGENT_TASK_MESSAGE_TYPE } from "../core/fork-history.ts";
import { buildAgentPrompt } from "../core/prompts.ts";
import type { AgentConfig, AgentModelReference } from "../core/types.ts";
import { primePromptEnvelope } from "../protocol/prompt-envelope.ts";
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
	onRuntimeResolved?: (selection: { model?: AgentModelReference; thinkingLevel?: ThinkingLevel }) => void;
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
	loader: DefaultResourceLoader;
}

export function parseModelSelector(value: string): string {
	const selector = value.trim();
	if (!selector || /\s/u.test(selector)) {
		throw new Error("model must use a model id, alias, or provider/model-id");
	}
	return selector;
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

	const model = resolveModel(ctx, options.agentConfig.model);
	const thinkingLevel = resolveThinkingLevel(
		model,
		options.agentConfig.thinkingLevel,
		ctx.thinkingLevel ?? options.pi.getThinkingLevel(),
	);
	options.onRuntimeResolved?.({
		model: model ? { provider: model.provider, id: model.id } : undefined,
		thinkingLevel,
	});

	return { effectiveCwd, agentDir, systemPrompt, toolNames, model, thinkingLevel, loader };
}

export function resolveModel(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels">,
	reference: AgentModelReference | string | undefined,
): Model<Api> | undefined {
	if (!reference) return ctx.model;
	const models =
		ctx.scopedModels.length > 0 ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
	const selector =
		typeof reference === "string" ? parseModelSelector(reference) : `${reference.provider}/${reference.id}`;
	const normalizedSelector = selector.toLowerCase();
	const exactMatches = models.filter(
		(candidate) =>
			`${candidate.provider}/${candidate.id}`.toLowerCase() === normalizedSelector ||
			candidate.id.toLowerCase() === normalizedSelector,
	);
	if (exactMatches.length === 1) return exactMatches[0];
	if (exactMatches.length > 1) {
		throw new Error(`Model "${selector}" is ambiguous; use provider/model-id`);
	}

	if (typeof reference === "string" && !selector.includes("/")) {
		const partialMatches = models.filter(
			(candidate) =>
				candidate.id.toLowerCase().includes(normalizedSelector) ||
				candidate.name.toLowerCase().includes(normalizedSelector),
		);
		if (partialMatches.length === 1) return partialMatches[0];
		if (partialMatches.length > 1) {
			throw new Error(`Model "${selector}" is ambiguous; use provider/model-id`);
		}
	}

	throw new Error(`Unknown model: ${selector}`);
}

export function resolveThinkingLevel(
	model: Model<Api> | undefined,
	requested: ThinkingLevel | undefined,
	inheritedLevel: ThinkingLevel,
): ThinkingLevel | undefined {
	if (requested !== undefined) {
		if (!model) throw new Error("thinking_level requires a model");
		if (!getSupportedThinkingLevels(model).includes(requested)) {
			throw new Error(`Thinking level "${requested}" is unavailable for model ${model.provider}/${model.id}`);
		}
		return requested;
	}
	return model ? clampThinkingLevel(model, inheritedLevel) : undefined;
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
	if (options.collaboration)
		appendAgentIdentity(
			sessionManager,
			ctx,
			options.collaboration.agentPath,
			options.collaboration.completionDelivery === "none",
		);
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
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: effectiveCwd, agentDir, sessionManager });
	options.onRuntimeCreated?.(runtime);

	const session = runtime.session;
	options.onSessionCreated?.(session);
	await session.bindExtensions({
		onError: (error) => {
			options.onToolActivity?.({ type: "end", toolName: `extension-error:${error.extensionPath}` });
		},
	});
	const availableTools = new Set(session.getAllTools().map((tool) => tool.name));
	const activeTools = toolNames.filter((toolName) => availableTools.has(toolName));
	session.setActiveToolsByName(activeTools);
	primePromptEnvelope({
		provider: model?.provider,
		activeTools,
		sessionId: session.sessionManager.getSessionId(),
		prompt,
		cwd: effectiveCwd,
		piSystemPrompt: session.systemPrompt,
		systemPromptOptions: {
			cwd: effectiveCwd,
			customPrompt: session.systemPrompt,
			selectedTools: activeTools,
			skills: loader.getSkills().skills,
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
