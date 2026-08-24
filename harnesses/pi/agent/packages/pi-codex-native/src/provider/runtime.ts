import { createHash } from "node:crypto";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	Provider,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listCodeModeToolNames } from "pi-code-mode/sdk";
import { createGrammarToolInputProperties } from "../constrained-sampling.ts";
import { buildRequestBody } from "./request-body.ts";
import { normalizeResponsesToolHistory } from "../responses/tool-history.ts";
import { createCodexTransportStream, type CodexTransportRecoveryDependencies } from "./transport-recovery.ts";
import { prewarmWebSocket } from "./websocket-stream.ts";
import { combineAbortSignals } from "./sse.ts";
import { closeOpenAICodexWebSocketSessions, resetOpenAICodexWebSocketSessions } from "./websocket.ts";
import { createCodexTurnState, type CodexTurnState } from "./turn-state.ts";
import {
	buildWebSocketHeaders,
	createCodexRequestId,
	extractAccountId,
	resolveCodexRequestRouting,
	resolveCodexWebSocketUrl,
} from "./headers.ts";
import { codexOAuth } from "./auth.ts";
import { getCodexModels, type CodexModel } from "./models.ts";
import type {
	CodexDiagnosticsSink,
	CodexProviderStreamOptions,
	OpenAICodexStreamOptions,
	ResponsesBody,
} from "./types.ts";

export interface CodexRuntimePlan {
	active: boolean;
	model?: string;
	transport: "auto" | "sse" | "websocket" | "websocket-cached";
	prewarm: boolean;
}

export interface CodexRuntimeState {
	sessionId: string;
	model?: string;
	turnState: CodexTurnState;
	plan: CodexRuntimePlan;
	prewarmIdentity?: string;
}

export interface CodexProviderRuntimeOptions {
	diagnostics?: CodexDiagnosticsSink;
	prewarmTransport?: typeof prewarmWebSocket;
}

export interface CodexCompactionPrewarmInput {
	sessionId: string;
	model: Model<Api>;
	body: ResponsesBody;
}

type RetainedRequestAuth = Pick<
	OpenAICodexStreamOptions,
	"apiKey" | "headers" | "env" | "websocketConnectTimeoutMs" | "timeoutMs"
>;

type PrewarmOperation = {
	controller: AbortController;
	generation: number;
};

type RuntimeApiStreamOptions = CodexProviderStreamOptions & {
	onPayload?: OpenAICodexStreamOptions["onPayload"];
};

function sessionIdFor(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionId() ?? ctx.sessionManager.getSessionFile();
}

function modelKey(model: Model<Api> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function stableJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableJsonValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, stableJsonValue(entry)]),
	);
}

function identityHeaders(headers: Headers): [string, string][] {
	const volatileHeaders = new Set(["authorization", "session-id", "thread-id", "x-client-request-id"]);
	return [...headers.entries()]
		.filter(([name]) => !volatileHeaders.has(name.toLowerCase()))
		.sort(([left], [right]) => left.localeCompare(right));
}

export function createCodexPrewarmIdentity(input: {
	url: string;
	accountId: string;
	headers: Headers;
	body: ResponsesBody;
}): string {
	const source = stableJsonValue({
		route: new URL(input.url).href,
		accountId: input.accountId,
		headers: identityHeaders(input.headers),
		body: input.body,
	});
	return createHash("sha256").update(JSON.stringify(source)).digest("base64url");
}

/**
 * Owns provider registration and all provider state that spans a request.
 * Pi lifecycle events call this object instead of reaching into transport modules.
 */
export class CodexProviderRuntime {
	private readonly sessions = new Map<string, CodexRuntimeState>();
	private readonly models: readonly CodexModel[] = getCodexModels();
	private readonly listeners = new Set<CodexDiagnosticsSink>();
	private readonly requestAuth = new Map<string, RetainedRequestAuth>();
	private readonly prewarms = new Map<string, PrewarmOperation>();
	private readonly prewarmGenerations = new Map<string, number>();
	private readonly prewarmTransport: typeof prewarmWebSocket;
	private diagnostics?: CodexDiagnosticsSink;
	private stopped = false;

	constructor(options: CodexProviderRuntimeOptions = {}) {
		this.diagnostics = options.diagnostics;
		this.prewarmTransport = options.prewarmTransport ?? prewarmWebSocket;
	}

	get provider(): Provider<"openai-codex-responses"> {
		return {
			id: "openai-codex",
			name: "OpenAI Codex",
			baseUrl: "https://chatgpt.com/backend-api",
			auth: { oauth: codexOAuth },
			getModels: () => this.models,
			stream: (model, context, options) => this.stream(model, context, options as RuntimeApiStreamOptions | undefined),
			streamSimple: (model, context, options) => this.streamSimple(model, context, options),
		};
	}

	registerDiagnostics(listener: CodexDiagnosticsSink): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setDiagnostics(listener: CodexDiagnosticsSink | undefined): void {
		this.diagnostics = listener;
	}

	getRuntimeState(sessionId: string): CodexRuntimeState | undefined {
		return this.sessions.get(sessionId);
	}

	getRuntimePlan(sessionId: string): CodexRuntimePlan | undefined {
		return this.sessions.get(sessionId)?.plan;
	}

	startSession(ctx: ExtensionContext): void {
		const sessionId = sessionIdFor(ctx);
		if (!sessionId) return;
		this.stopped = false;
		const current = this.sessions.get(sessionId);
		if (current) {
			const nextModel = modelKey(ctx.model as Model<Api> | undefined);
			if (current.model !== nextModel) this.cancelPrewarm(sessionId);
			current.model = nextModel;
			current.plan = this.planFor(ctx.model as Model<Api> | undefined, current.plan.transport, false);
			return;
		}
		this.sessions.set(sessionId, {
			sessionId,
			model: modelKey(ctx.model as Model<Api> | undefined),
			turnState: createCodexTurnState(),
			plan: this.planFor(ctx.model as Model<Api> | undefined, "auto", false),
		});
	}

	selectModel(ctx: ExtensionContext): void {
		const sessionId = sessionIdFor(ctx);
		if (!sessionId) return;
		const state = this.ensureSession(sessionId);
		const nextModel = modelKey(ctx.model as Model<Api> | undefined);
		if (state.model !== nextModel) {
			this.cancelPrewarm(sessionId);
			resetOpenAICodexWebSocketSessions(sessionId);
			state.turnState.reset();
			state.prewarmIdentity = undefined;
		}
		state.model = nextModel;
		state.plan = this.planFor(ctx.model as Model<Api> | undefined, state.plan.transport, false);
	}

	shutdownSession(ctx: ExtensionContext): void {
		const sessionId = sessionIdFor(ctx);
		if (!sessionId) return;
		this.cancelPrewarm(sessionId);
		closeOpenAICodexWebSocketSessions(sessionId);
		this.requestAuth.delete(sessionId);
		this.sessions.delete(sessionId);
	}

	shutdown(): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const sessionId of this.prewarms.keys()) this.cancelPrewarm(sessionId);
		this.prewarms.clear();
		this.prewarmGenerations.clear();
		this.requestAuth.clear();
		closeOpenAICodexWebSocketSessions();
		this.sessions.clear();
	}

	resetTransportAfterCompaction(sessionId: string): void {
		this.cancelPrewarm(sessionId);
		resetOpenAICodexWebSocketSessions(sessionId);
		const state = this.sessions.get(sessionId);
		if (!state) return;
		state.turnState.reset();
		state.prewarmIdentity = undefined;
		state.plan = { ...state.plan, active: false, prewarm: state.plan.transport !== "sse" };
	}

	async startCompactionPrewarm(input: CodexCompactionPrewarmInput): Promise<void> {
		if (input.model.provider !== "openai-codex" || input.model.api !== "openai-codex-responses") return;
		const auth = this.requestAuth.get(input.sessionId);
		if (!auth?.apiKey) return;

		const state = this.ensureSession(input.sessionId);
		const serviceTier = typeof input.body.service_tier === "string" ? input.body.service_tier : undefined;
		const text = input.body.text;
		const textVerbosity =
			text && typeof text === "object" && "verbosity" in text
				? String((text as { verbosity: unknown }).verbosity)
				: undefined;
		const accountId = extractAccountId(auth.apiKey);
		const routing = resolveCodexRequestRouting({
			model: input.model.id,
			fast: serviceTier === "priority",
			serviceTier,
			normalOriginator: "pi",
		});
		const headers = buildWebSocketHeaders(
			input.model.headers,
			auth.headers,
			accountId,
			auth.apiKey,
			createCodexRequestId(),
			routing.originator,
			routing.routingHint,
		);
		const body = input.body;
		const url = resolveCodexWebSocketUrl(input.model.baseUrl);
		const identity = createCodexPrewarmIdentity({ url, accountId, headers, body });
		if (state.prewarmIdentity === identity) return;
		const operation = this.beginPrewarm(input.sessionId);
		const options: OpenAICodexStreamOptions = {
			...auth,
			sessionId: input.sessionId,
			signal: operation.controller.signal,
			transport: "websocket-cached",
			...(serviceTier ? { serviceTier: serviceTier as OpenAICodexStreamOptions["serviceTier"] } : {}),
			...(textVerbosity ? { textVerbosity } : {}),
		};

		try {
			await this.prewarmTransport(url, body, headers, accountId, options, state.turnState, this.getDiagnostics());
			if (this.isCurrentPrewarm(input.sessionId, operation)) {
				state.model = modelKey(input.model);
				state.prewarmIdentity = identity;
				state.plan = this.planFor(input.model, "websocket-cached", false);
			}
		} finally {
			this.finishPrewarm(input.sessionId, operation);
		}
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: RuntimeApiStreamOptions,
	): AssistantMessageEventStream {
		const sessionId = options?.sessionId;
		const state = sessionId ? this.ensureSession(sessionId) : undefined;
		if (sessionId && options?.apiKey) {
			this.requestAuth.set(sessionId, {
				apiKey: options.apiKey,
				...(options.headers ? { headers: options.headers } : {}),
				...(options.env ? { env: options.env } : {}),
				...(options.websocketConnectTimeoutMs !== undefined
					? { websocketConnectTimeoutMs: options.websocketConnectTimeoutMs }
					: {}),
				...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
			});
		}
		state?.turnState.beginTurn();
		if (state) {
			state.model = modelKey(model as Model<Api>);
			state.plan = this.planFor(model as Model<Api>, options?.transport ?? "auto", true);
		}
		const diagnostics = () => this.getDiagnostics();
		const deps: CodexTransportRecoveryDependencies = {
			prepareRequestBody: async (requestModel, requestContext, requestOptions) => {
				const grammarToolInputProperties = createGrammarToolInputProperties(requestContext.tools, true);
				let body = buildRequestBody(requestModel, requestContext, {
					...requestOptions,
					codeModeToolNames: listCodeModeToolNames(),
					grammarToolInputProperties,
				});
				const nextBody = await requestOptions?.onPayload?.(body, requestModel);
				if (nextBody !== undefined) body = nextBody as ResponsesBody;
				if (!body.previous_response_id) {
					const input = normalizeResponsesToolHistory(body.input ?? []);
					if (input !== body.input) body = { ...body, input };
				}
				return body;
			},
			turnState: state?.turnState,
			getDiagnostics: diagnostics,
			prewarm:
				state && sessionId
					? async (input) => {
							const identity = createCodexPrewarmIdentity(input);
							if (state.prewarmIdentity === identity) return;
							const operation = this.beginPrewarm(sessionId);
							const combinedSignal = combineAbortSignals([input.options.signal, operation.controller.signal]);
							try {
								await this.prewarmTransport(
									input.url,
									input.body,
									input.headers,
									input.accountId,
									{ ...input.options, signal: combinedSignal.signal },
									state.turnState,
									this.getDiagnostics(),
								);
								if (this.isCurrentPrewarm(sessionId, operation)) state.prewarmIdentity = identity;
							} catch {
								// Prewarm is an optimization. The request still uses the normal retry path.
							} finally {
								combinedSignal.cleanup();
								this.finishPrewarm(sessionId, operation);
							}
						}
					: undefined,
		};
		return createCodexTransportStream(model, context, options, deps);
	}

	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		return this.stream(model, context, options as RuntimeApiStreamOptions | undefined);
	}

	private ensureSession(sessionId: string): CodexRuntimeState {
		const current = this.sessions.get(sessionId);
		if (current) return current;
		const state: CodexRuntimeState = {
			sessionId,
			turnState: createCodexTurnState(),
			plan: this.planFor(undefined, "auto", false),
		};
		this.sessions.set(sessionId, state);
		return state;
	}

	private beginPrewarm(sessionId: string): PrewarmOperation {
		this.cancelPrewarm(sessionId);
		const generation = (this.prewarmGenerations.get(sessionId) ?? 0) + 1;
		this.prewarmGenerations.set(sessionId, generation);
		const operation = { controller: new AbortController(), generation };
		this.prewarms.set(sessionId, operation);
		return operation;
	}

	private cancelPrewarm(sessionId: string): void {
		this.prewarms.get(sessionId)?.controller.abort();
		this.prewarms.delete(sessionId);
		this.prewarmGenerations.set(sessionId, (this.prewarmGenerations.get(sessionId) ?? 0) + 1);
	}

	private isCurrentPrewarm(sessionId: string, operation: PrewarmOperation): boolean {
		return (
			this.prewarms.get(sessionId) === operation &&
			this.prewarmGenerations.get(sessionId) === operation.generation &&
			!operation.controller.signal.aborted
		);
	}

	private finishPrewarm(sessionId: string, operation: PrewarmOperation): void {
		if (this.prewarms.get(sessionId) === operation) this.prewarms.delete(sessionId);
	}

	private planFor(
		model: Model<Api> | undefined,
		transport: CodexRuntimePlan["transport"],
		active: boolean,
	): CodexRuntimePlan {
		return {
			active,
			model: modelKey(model),
			transport,
			prewarm: transport !== "sse" && model?.provider === "openai-codex",
		};
	}

	private getDiagnostics(): CodexDiagnosticsSink | undefined {
		if (!this.diagnostics && this.listeners.size === 0) return undefined;
		return (event) => {
			try {
				this.diagnostics?.(event);
			} catch {
				// Diagnostics must never change provider behavior.
			}
			for (const listener of this.listeners) {
				try {
					listener(event);
				} catch {
					// Diagnostics must never change provider behavior.
				}
			}
		};
	}
}
