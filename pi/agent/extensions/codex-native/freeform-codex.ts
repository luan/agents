import type { AssistantMessage, Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildGeneratedImageArtifactResult,
	buildWebSearchActivityMessage,
	extractWebSearch,
	markGeneratedImageDisplayed,
	type SavedGeneratedImage,
	type SurfacedWebSearch,
	saveOpenAICodexGeneratedImage,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
} from "./native-tools";
import { convertResponsesMessages, processResponsesStream } from "./openai-responses-shared";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex"]);
const CODEX_RESPONSE_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]);
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const WEBSOCKET_FAILURE_FALLBACK_THRESHOLD = 3;
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const HTTP_ERROR_BODY_MAX_CHARS = 1000;
const DEFAULT_MAX_RETRIES = 0;
const BASE_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_SSE_HEADER_TIMEOUT_MS = 10_000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

type RequestBody = Record<string, any> & {
	input?: any[];
	previous_response_id?: string;
	store?: boolean;
};

interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: Record<string, unknown>;
}

interface CombinedAbortSignal {
	signal?: AbortSignal;
	cleanup: () => void;
}

function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}

function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
	const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (activeSignals.length === 0) return { cleanup: () => {} };
	if (activeSignals.length === 1) return { signal: activeSignals[0], cleanup: () => {} };

	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) controller.abort(signal.reason);
	};

	for (const signal of activeSignals) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		const listener = () => abort(signal);
		signal.addEventListener("abort", listener, { once: true });
		listeners.push({ signal, listener });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
		},
	};
}

function createSSEHeaderTimeout(): { signal: AbortSignal; clear: () => void; error: () => Error | undefined } {
	const controller = new AbortController();
	let error: Error | undefined;
	const timeout = setTimeout(() => {
		error = new Error(`Codex SSE response headers timed out after ${DEFAULT_SSE_HEADER_TIMEOUT_MS}ms`);
		controller.abort(error);
	}, DEFAULT_SSE_HEADER_TIMEOUT_MS);
	return {
		signal: controller.signal,
		clear: () => clearTimeout(timeout),
		error: () => error,
	};
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid timeoutMs: ${String(value)}`);
	return Math.floor(value);
}

function isTerminalRateLimitError(errorText: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		errorText,
	);
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 && isTerminalRateLimitError(errorText)) return false;
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function getRetryAfterDelayMs(headers: Headers): number | undefined {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) return Math.max(0, millis);
	}

	const retryAfter = headers.get("retry-after");
	if (!retryAfter) return undefined;

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

	return undefined;
}

function capRetryDelayMs(delayMs: number, options?: SimpleStreamOptions): number {
	const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	return maxRetryDelayMs > 0 ? Math.min(delayMs, maxRetryDelayMs) : delayMs;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

interface CachedWebSocketContinuationState {
	lastRequestBody: RequestBody;
	lastResponseId: string;
	lastResponseItems: any[];
}

interface CachedWebSocketConnection {
	socket: WebSocketLike;
	busy: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

export interface OpenAICodexWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
const websocketSseFallbackSessions = new Set<string>();

type CodexFreeformOptions = {
	toolName: string;
	toolNames?: string[];
	description: string;
	grammar: string;
	toolConfigs?: Record<
		string,
		{ description: string; grammar: string } | (() => { description: string; grammar: string } | undefined)
	>;
	getCurrentCwd?: () => string;
};

function resolveFreeformToolConfig(
	value:
		| { description: string; grammar: string }
		| (() => { description: string; grammar: string } | undefined)
		| undefined,
): { description: string; grammar: string } | undefined {
	return typeof value === "function" ? value() : value;
}

function freeformToolNames(options: CodexFreeformOptions): Set<string> {
	return new Set([
		options.toolName,
		...(options.toolNames ?? []),
		...Object.entries(options.toolConfigs ?? {})
			.filter(([, config]) => resolveFreeformToolConfig(config) !== undefined)
			.map(([name]) => name),
	]);
}

function freeformToolConfig(options: CodexFreeformOptions, toolName: string): { description: string; grammar: string } {
	return (
		resolveFreeformToolConfig(options.toolConfigs?.[toolName]) ?? {
			description: options.description,
			grammar: options.grammar,
		}
	);
}

type PendingActivity = { kind: "web-search"; search: SurfacedWebSearch };

export function registerCodexFreeformProvider(pi: ExtensionAPI, options: CodexFreeformOptions) {
	if (typeof pi.registerProvider !== "function") return;
	const pendingActivities: PendingActivity[] = [];
	let pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;
	let consecutiveWebSocketFailures = 0;
	let forceSseForSession = false;

	const flushPendingMessages = () => {
		pendingFlushTimer = undefined;
		const activities = pendingActivities.splice(0, pendingActivities.length);
		for (let index = 0; index < activities.length; index++) {
			const activity = activities[index];

			const searches = [activity.search];
			while (index + 1 < activities.length && activities[index + 1]?.kind === "web-search") {
				searches.push((activities[++index] as Extract<PendingActivity, { kind: "web-search" }>).search);
			}
			pi.sendMessage(
				{
					customType: WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
					content: buildWebSearchActivityMessage(searches),
					display: true,
					details: { searches },
				},
				{ triggerTurn: false },
			);
		}
	};

	const schedulePendingMessageFlush = () => {
		if (pendingFlushTimer || pendingActivities.length === 0) return;
		pendingFlushTimer = setTimeout(flushPendingMessages, 0);
	};

	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: (model, context, streamOptions) =>
			streamFreeformCodexResponses(model, context, options, streamOptions, {
				forceSse: forceSseForSession,
				onWebSearchCaptured: (search) => pendingActivities.push({ kind: "web-search", search }),
				onStreamSuccess: () => {
					consecutiveWebSocketFailures = 0;
				},
				onWebSocketFailure: () => {
					consecutiveWebSocketFailures++;
					if (consecutiveWebSocketFailures >= WEBSOCKET_FAILURE_FALLBACK_THRESHOLD) {
						forceSseForSession = true;
					}
				},
			}),
	});

	pi.on("agent_end", async () => {
		schedulePendingMessageFlush();
	});
	pi.on("session_shutdown", async () => {
		if (pendingActivities.length > 0) flushPendingMessages();
		if (pendingFlushTimer) clearTimeout(pendingFlushTimer);
		pendingFlushTimer = undefined;
		pendingActivities.length = 0;
		consecutiveWebSocketFailures = 0;
		forceSseForSession = false;
		closeOpenAICodexWebSocketSessions();
	});
	pi.on("context", async (event) => ({
		messages: event.messages.filter(
			(message) => !(message.role === "custom" && message.customType === WEB_SEARCH_ACTIVITY_MESSAGE_TYPE),
		),
	}));
	// Rendering is registered once by the owning codex-native extension.
}

function streamFreeformCodexResponses(
	model: Model<any>,
	context: Context,
	applyPatch: ApplyPatchFreeformOptions,
	options?: SimpleStreamOptions,
	deps: {
		forceSse?: boolean;
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
		onWebSearchCaptured?: (search: SurfacedWebSearch) => void;
		onStreamSuccess?: () => void;
		onWebSocketFailure?: (error: Error) => void;
	} = {},
) {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const output = emptyAssistantMessage(model);
		const requestPrompt = getLatestUserText(context);
		try {
			const apiKey = options?.apiKey || "";
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

			let body: any = buildRequestBody(model, context, applyPatch, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) body = nextBody;
			const accountId = extractAccountId(apiKey);
			const requestedTransport = (options as any)?.transport || "sse";
			const transport = deps.forceSse && requestedTransport !== "sse" ? "sse" : requestedTransport;
			const effectiveOptions =
				transport === requestedTransport ? options : ({ ...options, transport } as SimpleStreamOptions | undefined);
			const idleTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
			const websocketConnectTimeoutMs = normalizeTimeoutMs((options as any)?.websocketConnectTimeoutMs);
			const requestId = options?.sessionId || createCodexRequestId();
			const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);
			const websocketHeaders = buildWebSocketHeaders(model.headers, options?.headers, accountId, apiKey, requestId);
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(options?.sessionId);
			if (websocketDisabledForSession) recordWebSocketSseFallback(options?.sessionId);

			if (transport !== "sse" && !websocketDisabledForSession) {
				let websocketStarted = false;
				try {
					await processWebSocketStream(
						resolveCodexWebSocketUrl(model.baseUrl),
						body,
						websocketHeaders,
						output,
						stream,
						model,
						applyPatch,
						{
							cwd: applyPatch.getCurrentCwd?.() ?? process.cwd(),
							requestPrompt,
							onImageSaved: (savedImage, imageData) => deps.onImageSaved?.(savedImage, imageData),
							onWebSearchCaptured: (search) => deps.onWebSearchCaptured?.(search),
						},
						() => {
							websocketStarted = true;
						},
						idleTimeoutMs,
						websocketConnectTimeoutMs,
						effectiveOptions,
					);
					if (options?.signal?.aborted) throw new Error("Request was aborted");
					stream.push({
						type: "done",
						reason: output.stopReason as any,
						message: output,
					});
					deps.onStreamSuccess?.();
					stream.end();
					return;
				} catch (error) {
					if (options?.signal?.aborted || isCodexNonTransportError(error)) throw error;
					appendAssistantMessageDiagnostic(
						output,
						createAssistantMessageDiagnostic("provider_transport_failure", error, {
							configuredTransport: transport,
							fallbackTransport: websocketStarted ? undefined : "sse",
							eventsEmitted: websocketStarted,
							phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
							requestBytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
						}),
					);
					recordWebSocketFailure(options?.sessionId, error);
					if (websocketStarted) throw error;
					recordWebSocketSseFallback(options?.sessionId);
				}
			}

			const response = await fetchCodexSSEWithRetries(resolveCodexUrl(model.baseUrl), sseHeaders, body, options);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (!response.ok) throw await createCodexHttpError(response);
			if (!response.body) throw new Error("No response body");

			stream.push({ type: "start", partial: output });
			await processResponsesStream(
				mapFreeformEventsForTools(
					captureNativeActivities(mapCodexEvents(parseSSE(response)), {
						cwd: applyPatch.getCurrentCwd?.() ?? process.cwd(),
						requestPrompt,
						onImageSaved: (savedImage, imageData) => deps.onImageSaved?.(savedImage, imageData),
						onWebSearchCaptured: (search) => deps.onWebSearchCaptured?.(search),
					}),
					freeformToolNames(applyPatch),
				) as AsyncIterable<never>,
				output,
				stream,
				model,
			);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			stream.push({
				type: "done",
				reason: output.stopReason as any,
				message: output,
			});
			deps.onStreamSuccess?.();
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).partialJson;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			if (output.stopReason === "error" && output.errorMessage.startsWith("WebSocket")) {
				deps.onWebSocketFailure?.(error instanceof Error ? error : new Error(String(error)));
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

function emptyAssistantMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function buildRequestBody(
	model: Model<any>,
	context: Context,
	applyPatch: ApplyPatchFreeformOptions,
	options?: SimpleStreamOptions,
) {
	const messages = convertFreeformResponsesMessagesForTools(model, context, freeformToolNames(applyPatch));
	const body: any = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt || "You are a helpful assistant.",
		input: messages,
		text: { verbosity: (options as any)?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: true,
	};
	if (options?.temperature !== undefined) body.temperature = options.temperature;
	if (context.tools?.length) body.tools = convertTools(context.tools, applyPatch);
	if (context.tools?.some((tool) => tool.name === "web_search")) {
		body.include.push("web_search_call.action.sources", "web_search_call.results");
	}
	if (options?.reasoning !== undefined)
		body.reasoning = {
			effort: options.reasoning === "minimal" ? "low" : options.reasoning,
			summary: "auto",
		};
	return body;
}

function normalizeCustomToolCallItemId(id: string | undefined): string | undefined {
	if (!id) return undefined;
	const withoutFunctionPrefix = id.startsWith("fc_ctc_") ? id.slice("fc_".length) : id;
	const sanitized = withoutFunctionPrefix.replace(/[^a-zA-Z0-9_-]/g, "_");
	const normalized = (sanitized.startsWith("ctc_") ? sanitized : `ctc_${sanitized}`).replace(/_+$/, "");
	return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
}

export function convertFreeformResponsesMessages(model: Model<any>, context: Context, toolName: string) {
	return convertFreeformResponsesMessagesForTools(model, context, new Set([toolName]));
}

function convertFreeformResponsesMessagesForTools(model: Model<any>, context: Context, toolNames: Set<string>) {
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, { includeSystemPrompt: false });
	const applyPatchCallIds = new Set<string>();
	return messages.map((item: any) => {
		if (item?.type === "function_call" && toolNames.has(item.name)) {
			applyPatchCallIds.add(item.call_id);
			let input = "";
			try {
				input = JSON.parse(item.arguments || "{}")?.input || "";
			} catch {}
			return {
				type: "custom_tool_call",
				id: normalizeCustomToolCallItemId(item.id),
				call_id: item.call_id,
				name: item.name,
				input,
				status: "completed",
			};
		}
		if (item?.type === "function_call_output" && applyPatchCallIds.has(item.call_id)) {
			return {
				type: "custom_tool_call_output",
				call_id: item.call_id,
				output: item.output,
			};
		}
		return item;
	});
}

export function convertTools(tools: Tool[], applyPatch: ApplyPatchFreeformOptions) {
	const toolNames = freeformToolNames(applyPatch);
	return tools.map((tool: any) => {
		if (!toolNames.has(tool.name)) {
			return {
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				strict: null,
			};
		}
		return {
			type: "custom",
			name: tool.name,
			description: freeformToolConfig(applyPatch, tool.name).description,
			format: {
				type: "grammar",
				syntax: "lark",
				definition: freeformToolConfig(applyPatch, tool.name).grammar,
			},
		};
	});
}

export async function* mapFreeformEvents(events: AsyncIterable<any>, toolName: string) {
	yield* mapFreeformEventsForTools(events, new Set([toolName]));
}

async function* mapFreeformEventsForTools(events: AsyncIterable<any>, toolNames: Set<string>) {
	const customInputs = new Map<string, string>();
	const jsonStringOpen = new Set<string>();
	for await (const event of events) {
		if (
			event.type === "response.output_item.added" &&
			event.item?.type === "custom_tool_call" &&
			toolNames.has(event.item.name)
		) {
			customInputs.set(event.item.id, event.item.input || "");
			yield {
				...event,
				item: { ...event.item, type: "function_call", arguments: "" },
			};
			continue;
		}
		if (event.type === "response.custom_tool_call_input.delta") {
			const itemId = event.item_id || event.output_item_id;
			if (!itemId || !customInputs.has(itemId)) {
				yield event;
				continue;
			}
			const delta = event.delta || "";
			customInputs.set(itemId, `${customInputs.get(itemId) || ""}${delta}`);
			const prefix = jsonStringOpen.has(itemId) ? "" : '{"input":"';
			jsonStringOpen.add(itemId);
			yield {
				type: "response.function_call_arguments.delta",
				output_index: event.output_index,
				delta: `${prefix}${escapeJsonStringFragment(delta)}`,
			};
			continue;
		}
		if (event.type === "response.custom_tool_call_input.done") {
			const itemId = event.item_id || event.output_item_id;
			if (!itemId || !customInputs.has(itemId)) {
				yield event;
				continue;
			}
			customInputs.set(itemId, event.input ?? customInputs.get(itemId) ?? "");
			if (jsonStringOpen.has(itemId)) {
				yield {
					type: "response.function_call_arguments.delta",
					output_index: event.output_index,
					delta: '"}',
				};
				jsonStringOpen.delete(itemId);
			}
			continue;
		}
		if (
			event.type === "response.output_item.done" &&
			event.item?.type === "custom_tool_call" &&
			toolNames.has(event.item.name)
		) {
			const raw = event.item.input ?? customInputs.get(event.item.id) ?? "";
			if (jsonStringOpen.has(event.item.id)) {
				yield {
					type: "response.function_call_arguments.delta",
					output_index: event.output_index,
					delta: '"}',
				};
				jsonStringOpen.delete(event.item.id);
			}
			customInputs.delete(event.item.id);
			yield {
				type: "response.function_call_arguments.done",
				output_index: event.output_index,
				arguments: JSON.stringify({ input: raw }),
			};
			yield {
				...event,
				item: {
					...event.item,
					type: "function_call",
					arguments: JSON.stringify({ input: raw }),
				},
			};
			continue;
		}
		yield event;
	}
}

function escapeJsonStringFragment(value: string) {
	return JSON.stringify(value).slice(1, -1);
}

class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(message: string, options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

async function createCodexHttpError(response: Response): Promise<CodexApiError> {
	const status = [response.status, response.statusText].filter(Boolean).join(" ");
	let body: string;
	try {
		body = (await response.text()).trim();
	} catch (error) {
		const detail = formatThrownValue(error);
		return new CodexApiError(`Codex SSE request failed: HTTP ${status}: failed to read error body: ${detail}`, {
			code: String(response.status),
			payload: { status: response.status, statusText: response.statusText },
			cause: error,
		});
	}

	const truncatedBody =
		body.length > HTTP_ERROR_BODY_MAX_CHARS ? `${body.slice(0, HTTP_ERROR_BODY_MAX_CHARS)}...` : body;
	const detail = truncatedBody || "empty response body";
	return new CodexApiError(`Codex SSE request failed: HTTP ${status}: ${detail}`, {
		code: String(response.status),
		payload: { status: response.status, statusText: response.statusText },
	});
}

async function fetchCodexSSEWithRetries(
	url: string,
	headers: Headers,
	body: RequestBody,
	options?: SimpleStreamOptions,
): Promise<Response> {
	let lastError: Error | undefined;
	const bodyJson = JSON.stringify(body);
	const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (options?.signal?.aborted) throw new Error("Request was aborted");
		try {
			const headerTimeout = createSSEHeaderTimeout();
			const combinedSignal = combineAbortSignals([options?.signal, headerTimeout.signal]);
			let response: Response;
			try {
				response = await fetch(url, {
					method: "POST",
					headers,
					body: bodyJson,
					signal: combinedSignal.signal,
				});
			} catch (error) {
				const timeoutError = headerTimeout.error();
				throw timeoutError && !options?.signal?.aborted ? timeoutError : error;
			} finally {
				combinedSignal.cleanup();
				headerTimeout.clear();
			}

			if (response.ok) return response;

			const errorText = await response.clone().text();
			if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
				const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
				const delayMs =
					retryAfterDelayMs === undefined
						? BASE_RETRY_DELAY_MS * 2 ** attempt
						: response.status === 429
							? capRetryDelayMs(retryAfterDelayMs, options)
							: retryAfterDelayMs;
				await sleep(delayMs, options?.signal);
				continue;
			}

			return response;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < maxRetries && !lastError.message.includes("usage limit")) {
				const delayMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
				await sleep(delayMs, options?.signal);
				continue;
			}
			break;
		}
	}

	throw lastError ?? new Error("Codex SSE request failed");
}

class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

function isCodexNonTransportError(error: unknown): boolean {
	return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

async function* mapCodexEvents(events: AsyncIterable<any>) {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;
		if (type === "error") {
			const code = typeof event.code === "string" ? event.code : undefined;
			const message = typeof event.message === "string" ? event.message : "";
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				code,
				payload: event,
			});
		}
		if (type === "response.failed") {
			const code = typeof event.response?.error?.code === "string" ? event.response.error.code : undefined;
			const message = typeof event.response?.error?.message === "string" ? event.response.error.message : "";
			throw new CodexApiError(message || "Codex response failed", { code, payload: event });
		}
		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = event.response
				? {
						...event.response,
						status: normalizeCodexStatus(event.response.status),
					}
				: event.response;
			yield { ...event, type: "response.completed", response };
			return;
		}
		yield event;
	}
}

function getLatestUserText(context: Context): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content.trim() || undefined;
		const text = message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

async function* captureNativeActivities(
	events: AsyncIterable<any>,
	options: {
		cwd: string;
		requestPrompt?: string;
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
		onWebSearchCaptured?: (search: SurfacedWebSearch) => void;
	},
) {
	let responseId: string | undefined;
	for await (const event of events) {
		if (event.type === "response.created" && event.response?.id) {
			responseId = event.response.id;
		}
		if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call") {
			const callId = typeof event.item.id === "string" ? event.item.id : undefined;
			const result = typeof event.item.result === "string" ? event.item.result : undefined;
			if (callId && result) {
				const outputFormat = typeof event.item.output_format === "string" ? event.item.output_format : undefined;
				try {
					const savedImage = await saveOpenAICodexGeneratedImage(options.cwd, {
						responseId,
						callId,
						result,
						outputFormat,
						revisedPrompt:
							typeof event.item.revised_prompt === "string" ? event.item.revised_prompt : options.requestPrompt,
					});
					Object.assign(event.item, {
						artifact_result: buildGeneratedImageArtifactResult([savedImage]),
					});
					markGeneratedImageDisplayed(responseId, callId);
					options.onImageSaved?.(savedImage, {
						data: result,
						mimeType: `image/${savedImage.outputFormat}`,
					});
				} catch {
					// Saving generated images is best-effort; keep provider streaming fail-open.
				}
			}
		}
		if (event.type === "response.output_item.done" && event.item?.type === "web_search_call") {
			const search = extractWebSearch(event.item);
			if (search) options.onWebSearchCaptured?.(search);
		}
		yield event;
	}
}

function normalizeCodexStatus(status: unknown) {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
	let stats = websocketDebugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		websocketDebugStats.set(sessionId, stats);
	}
	return stats;
}

export function getOpenAICodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	websocketDebugStats.clear();
	websocketSseFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	const closeEntry = (entry: CachedWebSocketConnection) => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeWebSocketSilently(entry.socket, 1000, "debug_close");
	};
	if (sessionId) {
		const entry = websocketSessionCache.get(sessionId);
		if (entry) closeEntry(entry);
		websocketSessionCache.delete(sessionId);
		return;
	}
	for (const entry of websocketSessionCache.values()) closeEntry(entry);
	websocketSessionCache.clear();
}

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	if (!sessionId) return;
	websocketSseFallbackSessions.add(sessionId);

	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = true;
}

type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

function getWebSocketConstructor(): WebSocketConstructor | null {
	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	return typeof ctor === "function" ? (ctor as unknown as WebSocketConstructor) : null;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = (socket as { readyState?: unknown }).readyState;
	return typeof readyState !== "number" || readyState === 1;
}

class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

function scheduleSessionWebSocketExpiry(sessionId: string, entry: CachedWebSocketConnection): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		websocketSessionCache.delete(sessionId);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

async function connectWebSocket(
	url: string,
	headers: Headers,
	signal?: AbortSignal,
	connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
): Promise<WebSocketLike> {
	const WebSocketCtor = getWebSocketConstructor();
	if (!WebSocketCtor) throw new Error("WebSocket transport is not available in this runtime");
	const wsHeaders = headersToRecord(headers);

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: WebSocketLike;
		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error, closeReason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (closeReason) closeWebSocketSilently(socket, 1000, closeReason);
			reject(error);
		};
		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => fail(extractWebSocketError(event));
		const onClose: WebSocketListener = (event) => fail(extractWebSocketCloseError(event));
		const onAbort = () => {
			fail(new Error("Request was aborted"), "aborted");
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
		if (connectTimeoutMs > 0) {
			timeout = setTimeout(() => {
				fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
			}, connectTimeoutMs);
		}
		if (signal?.aborted) onAbort();
	});
}

async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	signal?: AbortSignal,
	connectTimeoutMs?: number,
): Promise<{
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
		return { socket, reused: false, release: () => closeWebSocketSilently(socket) };
	}

	const cached = websocketSessionCache.get(sessionId);
	if (cached) {
		if (cached.idleTimer) clearTimeout(cached.idleTimer);
		cached.idleTimer = undefined;
		if (!cached.busy && isWebSocketReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				entry: cached,
				reused: true,
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						websocketSessionCache.delete(sessionId);
						return;
					}
					cached.busy = false;
					scheduleSessionWebSocketExpiry(sessionId, cached);
				},
			};
		}
		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
			return { socket, reused: false, release: () => closeWebSocketSilently(socket) };
		}
		closeWebSocketSilently(cached.socket);
		websocketSessionCache.delete(sessionId);
	}

	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
	const entry: CachedWebSocketConnection = { socket, busy: true };
	websocketSessionCache.set(sessionId, entry);
	return {
		socket,
		entry,
		reused: false,
		release: ({ keep } = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				if (websocketSessionCache.get(sessionId) === entry) websocketSessionCache.delete(sessionId);
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, entry);
		},
	};
}

function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) return new Error(message);

		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) return nestedError;
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) return new Error(nestedMessage);
		}
	}
	return new Error("WebSocket connection error");
}

function annotateWebSocketError(error: Error, startMs: number, lastEventMs: number, messageCount: number): Error {
	const elapsedSeconds = Math.round((Date.now() - startMs) / 1000);
	const idleSeconds = Math.round((Date.now() - lastEventMs) / 1000);
	return new Error(
		`${error.message} after ${elapsedSeconds}s (${idleSeconds}s since last event, ${messageCount} events)`,
	);
}

function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) reasonText = " message too big";
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : undefined,
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	return new Error("WebSocket closed");
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const arrayBuffer = await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

async function* parseWebSocket(
	socket: WebSocketLike,
	signal?: AbortSignal,
	idleTimeoutMs?: number,
): AsyncGenerator<Record<string, unknown>> {
	const queue: Record<string, unknown>[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;
	const startMs = Date.now();
	let lastEventMs = startMs;
	let messageCount = 0;
	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};
	const onMessage: WebSocketListener = (event) => {
		void (async () => {
			let text: string | null = null;
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				text = await decodeWebSocketData((event as { data?: unknown }).data);
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const type = typeof parsed.type === "string" ? parsed.type : "";
				if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
					sawCompletion = true;
					done = true;
				}
				lastEventMs = Date.now();
				messageCount++;
				queue.push(parsed);
				wake();
			} catch (cause) {
				failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
					cause,
					payload: text,
				});
				done = true;
				wake();
			}
		})();
	};
	const onError: WebSocketListener = (event) => {
		failed = annotateWebSocketError(extractWebSocketError(event), startMs, lastEventMs, messageCount);
		done = true;
		wake();
	};
	const onClose: WebSocketListener = (event) => {
		if (!sawCompletion && !failed) {
			failed = annotateWebSocketError(extractWebSocketCloseError(event), startMs, lastEventMs, messageCount);
		}
		done = true;
		wake();
	};
	const onAbort = () => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			if (queue.length > 0) {
				yield queue.shift()!;
				continue;
			}
			if (done) break;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve, reject) => {
				pending = resolve;
				if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
					timeout = setTimeout(() => {
						const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
						failed = error;
						done = true;
						pending = null;
						closeWebSocketSilently(socket, 1000, "idle_timeout");
						reject(error);
					}, idleTimeoutMs);
				}
			}).finally(() => {
				if (timeout) clearTimeout(timeout);
			});
		}
		if (failed) throw failed;
		if (!sawCompletion) throw new Error("WebSocket stream closed before response.completed");
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}

function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function responseInputsEqual(a: any[] | undefined, b: any[] | undefined): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(
	body: RequestBody,
	continuation: CachedWebSocketContinuationState,
): any[] | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) return undefined;
	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length) return undefined;
	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) return undefined;
	return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
	const continuation = entry.continuation;
	if (!continuation) return body;
	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}
	return { ...body, previous_response_id: continuation.lastResponseId, input: delta };
}

async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<any>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onStart: () => void,
): AsyncGenerator<any> {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onStart();
			stream.push({ type: "start", partial: output });
		}
		yield event;
	}
}

async function processWebSocketStream(
	url: string,
	body: RequestBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<any>,
	applyPatch: ApplyPatchFreeformOptions,
	activityOptions: Parameters<typeof captureNativeActivities>[1],
	onStart: () => void,
	idleTimeoutMs: number | undefined,
	websocketConnectTimeoutMs: number | undefined,
	options?: SimpleStreamOptions,
): Promise<void> {
	const { socket, entry, reused, release } = await acquireWebSocket(
		url,
		headers,
		options?.sessionId,
		options?.signal,
		websocketConnectTimeoutMs,
	);
	let keepConnection = true;
	const useCachedContext = (options as any)?.transport === "websocket-cached";
	const fullBody = body;
	const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	const stats = options?.sessionId ? getOrCreateWebSocketDebugStats(options.sessionId) : undefined;
	if (stats) {
		stats.requests++;
		if (reused) stats.connectionsReused++;
		else stats.connectionsCreated++;
		if (useCachedContext) stats.cachedContextRequests++;
		if (requestBody.store === true) stats.storeTrueRequests++;
		stats.lastInputItems = requestBody.input?.length ?? 0;
		if (requestBody.previous_response_id) {
			stats.deltaRequests++;
			stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
			stats.lastPreviousResponseId = requestBody.previous_response_id;
		} else {
			stats.fullContextRequests++;
			stats.lastDeltaInputItems = undefined;
			stats.lastPreviousResponseId = undefined;
		}
	}
	try {
		socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
		await processResponsesStream(
			startWebSocketOutputOnFirstEvent(
				mapFreeformEventsForTools(
					captureNativeActivities(
						mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs)),
						activityOptions,
					),
					freeformToolNames(applyPatch),
				) as AsyncIterable<never>,
				output,
				stream,
				onStart,
			) as AsyncIterable<never>,
			output,
			stream,
			model,
		);
		if (options?.signal?.aborted) {
			keepConnection = false;
		} else if (useCachedContext && entry && output.responseId) {
			const responseItems = convertFreeformResponsesMessagesForTools(
				model,
				{ messages: [output] } as any,
				freeformToolNames(applyPatch),
			).filter((item: any) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
			entry.continuation = {
				lastRequestBody: fullBody,
				lastResponseId: output.responseId,
				lastResponseItems: responseItems,
			};
		}
	} catch (error) {
		if (entry) entry.continuation = undefined;
		keepConnection = false;
		throw error;
	} finally {
		release({ keep: keepConnection });
	}
}

export async function* parseSSE(response: Response) {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const data = parseSseData(chunk);
				if (data && data !== "[DONE]") {
					try {
						yield JSON.parse(data);
					} catch (cause) {
						throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
							cause,
							payload: data,
						});
					}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
		const data = parseSseData(buffer.replace(/\r\n/g, "\n"));
		if (data && data !== "[DONE]") {
			try {
				yield JSON.parse(data);
			} catch (cause) {
				throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
					cause,
					payload: data,
				});
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

function parseSseData(chunk: string) {
	return chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
}

function resolveCodexUrl(baseUrl: string | undefined) {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function resolveCodexWebSocketUrl(baseUrl: string | undefined) {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

function extractAccountId(token: string) {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function createCodexRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
	return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildBaseCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
) {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders || {})) headers.set(key, value);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("User-Agent", "pi (apply-patch)");
	return headers;
}

function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	sessionId: string | undefined,
) {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	return headers;
}

function buildWebSocketHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	requestId: string,
) {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session-id", requestId);
	return headers;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}
