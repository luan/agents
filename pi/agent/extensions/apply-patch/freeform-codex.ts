import type { AssistantMessage, Context, Model, SimpleStreamOptions, Tool } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildGeneratedImageDisplayText,
	buildWebSearchActivityMessage,
	extractWebSearch,
	IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
	renderImageGenerationMessage,
	renderWebSearchMessage,
	type SavedGeneratedImage,
	type SurfacedWebSearch,
	saveOpenAICodexGeneratedImage,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
} from "../codex-native/native-tools.ts";
import { convertResponsesMessages, processResponsesStream } from "../codex-native/openai-responses-shared.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const CODEX_RESPONSE_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]);
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

type RequestBody = Record<string, any> & {
	input?: any[];
	previous_response_id?: string;
	store?: boolean;
};

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
}

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();

type ApplyPatchFreeformOptions = {
	toolName: string;
	description: string;
	grammar: string;
	getCurrentCwd?: () => string;
};

type PendingActivity =
	| {
			kind: "image";
			savedImage: SavedGeneratedImage;
			imageData: { data: string; mimeType: string };
	  }
	| { kind: "web-search"; search: SurfacedWebSearch };

export function registerApplyPatchFreeformProvider(pi: ExtensionAPI, options: ApplyPatchFreeformOptions) {
	if (typeof pi.registerProvider !== "function") return;
	const pendingActivities: PendingActivity[] = [];
	let pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;

	const flushPendingMessages = () => {
		pendingFlushTimer = undefined;
		const activities = pendingActivities.splice(0, pendingActivities.length);
		for (let index = 0; index < activities.length; index++) {
			const activity = activities[index];
			if (activity.kind === "image") {
				pi.sendMessage(
					{
						customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
						content: [
							{
								type: "text",
								text: buildGeneratedImageDisplayText(activity.savedImage),
							},
						],
						display: true,
						details: { savedImages: [activity.savedImage] },
					},
					{ triggerTurn: false },
				);
				continue;
			}

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
				onImageSaved: (savedImage, imageData) => pendingActivities.push({ kind: "image", savedImage, imageData }),
				onWebSearchCaptured: (search) => pendingActivities.push({ kind: "web-search", search }),
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
	});
	pi.on("context", async (event) => ({
		messages: event.messages.filter(
			(message) =>
				!(
					message.role === "custom" &&
					(message.customType === WEB_SEARCH_ACTIVITY_MESSAGE_TYPE ||
						message.customType === IMAGE_SAVE_DISPLAY_MESSAGE_TYPE)
				),
		),
	}));
	pi.registerMessageRenderer(IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, (message, renderOptions, theme) =>
		renderImageGenerationMessage(message as any, renderOptions, theme),
	);
	pi.registerMessageRenderer(WEB_SEARCH_ACTIVITY_MESSAGE_TYPE, (message, renderOptions, theme) =>
		renderWebSearchMessage(message as any, renderOptions, theme),
	);
}

function streamFreeformCodexResponses(
	model: Model<any>,
	context: Context,
	applyPatch: ApplyPatchFreeformOptions,
	options?: SimpleStreamOptions,
	deps: {
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
		onWebSearchCaptured?: (search: SurfacedWebSearch) => void;
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
			const transport = (options as any)?.transport || "sse";
			const requestId = options?.sessionId || createCodexRequestId();
			const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);
			const websocketHeaders = buildWebSocketHeaders(model.headers, options?.headers, accountId, apiKey, requestId);

			if (transport !== "sse") {
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
						options,
					);
					if (options?.signal?.aborted) throw new Error("Request was aborted");
					stream.push({
						type: "done",
						reason: output.stopReason as any,
						message: output,
					});
					stream.end();
					return;
				} catch (error) {
					if (transport === "websocket" || transport === "websocket-cached" || websocketStarted) throw error;
				}
			}

			const response = await fetch(resolveCodexUrl(model.baseUrl), {
				method: "POST",
				headers: sseHeaders,
				body: JSON.stringify(body),
				signal: options?.signal,
			});
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (!response.ok) throw new Error(await response.text());
			if (!response.body) throw new Error("No response body");

			stream.push({ type: "start", partial: output });
			await processResponsesStream(
				mapFreeformEvents(
					captureNativeActivities(mapCodexEvents(parseSSE(response)), {
						cwd: applyPatch.getCurrentCwd?.() ?? process.cwd(),
						requestPrompt,
						onImageSaved: (savedImage, imageData) => deps.onImageSaved?.(savedImage, imageData),
						onWebSearchCaptured: (search) => deps.onWebSearchCaptured?.(search),
					}),
					applyPatch.toolName,
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
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).partialJson;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
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
	const messages = convertFreeformResponsesMessages(model, context, applyPatch.toolName);
	const body: any = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt,
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

function convertFreeformResponsesMessages(model: Model<any>, context: Context, toolName: string) {
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, { includeSystemPrompt: false });
	const applyPatchCallIds = new Set<string>();
	return messages.map((item: any) => {
		if (item?.type === "function_call" && item.name === toolName) {
			applyPatchCallIds.add(item.call_id);
			let input = "";
			try {
				input = JSON.parse(item.arguments || "{}")?.input || "";
			} catch {}
			return {
				type: "custom_tool_call",
				id: item.id,
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
	return tools.map((tool: any) => {
		if (tool.name !== applyPatch.toolName) {
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
			name: applyPatch.toolName,
			description: applyPatch.description,
			format: {
				type: "grammar",
				syntax: "lark",
				definition: applyPatch.grammar,
			},
		};
	});
}

export async function* mapFreeformEvents(events: AsyncIterable<any>, toolName: string) {
	const customInputs = new Map<string, string>();
	const jsonStringOpen = new Set<string>();
	for await (const event of events) {
		if (
			event.type === "response.output_item.added" &&
			event.item?.type === "custom_tool_call" &&
			event.item.name === toolName
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
			event.item.name === toolName
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

async function* mapCodexEvents(events: AsyncIterable<any>) {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;
		if (type === "error") throw new Error(`Codex error: ${event.message || event.code || JSON.stringify(event)}`);
		if (type === "response.failed") throw new Error(event.response?.error?.message || "Codex response failed");
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
		return;
	}
	websocketDebugStats.clear();
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

async function connectWebSocket(url: string, headers: Headers, signal?: AbortSignal): Promise<WebSocketLike> {
	const WebSocketCtor = getWebSocketConstructor();
	if (!WebSocketCtor) throw new Error("WebSocket transport is not available in this runtime");
	const wsHeaders = headersToRecord(headers);

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let socket: WebSocketLike;
		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const cleanup = () => {
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			const error = extractWebSocketError(event);
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onClose: WebSocketListener = (event) => {
			const error = extractWebSocketCloseError(event);
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.close(1000, "aborted");
			reject(new Error("Request was aborted"));
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
	});
}

async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	signal?: AbortSignal,
): Promise<{
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal);
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
			const socket = await connectWebSocket(url, headers, signal);
			return { socket, reused: false, release: () => closeWebSocketSilently(socket) };
		}
		closeWebSocketSilently(cached.socket);
		websocketSessionCache.delete(sessionId);
	}

	const socket = await connectWebSocket(url, headers, signal);
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
	if (event && typeof event === "object" && "message" in event) {
		const message = (event as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return new Error(message);
	}
	return new Error("WebSocket connection error");
}

function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		const reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		return new Error(`WebSocket closed${codeText}${reasonText}`.trim());
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

async function* parseWebSocket(socket: WebSocketLike, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	const queue: Record<string, unknown>[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;
	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};
	const onMessage: WebSocketListener = (event) => {
		void (async () => {
			if (!event || typeof event !== "object" || !("data" in event)) return;
			const text = await decodeWebSocketData((event as { data?: unknown }).data);
			if (!text) return;
			try {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const type = typeof parsed.type === "string" ? parsed.type : "";
				if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
					sawCompletion = true;
					done = true;
				}
				queue.push(parsed);
				wake();
			} catch {}
		})();
	};
	const onError: WebSocketListener = (event) => {
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};
	const onClose: WebSocketListener = (event) => {
		if (!sawCompletion && !failed) failed = extractWebSocketCloseError(event);
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
			await new Promise<void>((resolve) => {
				pending = resolve;
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
	options?: SimpleStreamOptions,
): Promise<void> {
	const { socket, entry, reused, release } = await acquireWebSocket(url, headers, options?.sessionId, options?.signal);
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
		onStart();
		stream.push({ type: "start", partial: output });
		await processResponsesStream(
			mapFreeformEvents(
				captureNativeActivities(mapCodexEvents(parseWebSocket(socket, options?.signal)), activityOptions),
				applyPatch.toolName,
			) as AsyncIterable<never>,
			output,
			stream,
			model,
		);
		if (options?.signal?.aborted) {
			keepConnection = false;
		} else if (useCachedContext && entry && output.responseId) {
			const responseItems = convertFreeformResponsesMessages(
				model,
				{ messages: [output] } as any,
				applyPatch.toolName,
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
					} catch {}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
		const data = parseSseData(buffer.replace(/\r\n/g, "\n"));
		if (data && data !== "[DONE]") {
			try {
				yield JSON.parse(data);
			} catch {}
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
		headers.set("session_id", sessionId);
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
	headers.set("session_id", requestId);
	return headers;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}
