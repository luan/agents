import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	Transport,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { NativeCompactionRuntime } from "./runtime.ts";
import type { NativeCompactionRequestOptions, NativeCompactionRequestBody, ResponsesInputItem } from "./serializer.ts";
import { resolveNativeCompactionRequestBudget, shrinkNativeCompactionRequestForEndpoint } from "./request-shrink.ts";
import {
	buildRemoteCompactionV2Window,
	canonicalCompactionOutput,
	normalizeRemoteCompactionV2PromptInput,
} from "./remote-v2-history.ts";
import type { OpenAICodexStreamOptions, ResponsesBody } from "../provider/types.ts";
import { isWebSocketSseFallbackActive } from "../provider/websocket.ts";
import { canonicalCompactionRequestBody } from "../provider/session-continuity.ts";
import { extractAccountId, resolveCodexWebSocketUrl } from "../provider/headers.ts";

const MAX_STREAM_RETRIES = 2;
type V2Stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AsyncIterable<unknown>;

export type RemoteCompactionV2Usage = {
	inputTokens: number;
	cachedInputTokens: number;
	cacheWriteInputTokens: number;
	outputTokens: number;
};

export type RemoteCompactionV2Result =
	| {
			ok: true;
			compaction: Record<string, unknown>;
			responseId: string;
			createdAt: string;
			replayBody: ResponsesBody;
			usage?: RemoteCompactionV2Usage;
	  }
	| {
			ok: false;
			reason: "aborted" | "unavailable" | "stream-error" | "invalid-output";
			errorMessage: string;
			status?: number;
	  };

export type ExecuteRemoteCompactionV2Options = {
	runtime: NativeCompactionRuntime;
	modelRegistry: ModelRegistry;
	context: Context;
	promptInput: readonly ResponsesInputItem[];
	requestOptions: NativeCompactionRequestOptions;
	tokensBefore: number;
	sessionId: string;
	signal?: AbortSignal;
	transport?: Transport;
	promptInputSource?: "canonical" | "reconstructed";
};

function resolveStream(options: ExecuteRemoteCompactionV2Options): V2Stream | undefined {
	const nativeProvider = options.modelRegistry.getRegisteredNativeProvider(options.runtime.provider);
	return nativeProvider && options.runtime.currentModel.api === options.runtime.api
		? (model, context, streamOptions) => nativeProvider.streamSimple(model, context, streamOptions)
		: undefined;
}

function isAborted(signal: AbortSignal | undefined, message: string): boolean {
	return signal?.aborted === true || /request was aborted|\baborted\b/i.test(message);
}

function compactionUsage(message: AssistantMessage): RemoteCompactionV2Usage | undefined {
	const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
	const cachedInputTokens = message.usage.cacheRead;
	const cacheWriteInputTokens = message.usage.cacheWrite;
	const outputTokens = message.usage.output;
	if (
		![inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens].every(
			(value) => Number.isFinite(value) && value >= 0,
		)
	)
		return undefined;
	if (inputTokens + outputTokens === 0) return undefined;
	return { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens };
}

function canonicalSessionIdentity(
	options: ExecuteRemoteCompactionV2Options,
): { url: string; accountId: string } | undefined {
	if (options.promptInputSource === "reconstructed") return undefined;
	return {
		url: resolveCodexWebSocketUrl(options.runtime.baseUrl),
		accountId: extractAccountId(options.runtime.apiKey),
	};
}

function withCurrentCompactionControls(
	canonicalBody: ResponsesBody,
	currentBody: ResponsesBody,
	requestOptions: NativeCompactionRequestOptions,
): ResponsesBody {
	const {
		client_metadata: _metadata,
		reasoning: canonicalReasoning,
		service_tier: _tier,
		temperature: _temperature,
		text: _text,
		instructions: _instructions,
		tools: _tools,
		tool_choice: _toolChoice,
		parallel_tool_calls: _parallelToolCalls,
		input: _input,
		...historyBody
	} = canonicalBody;
	const currentReasoning = requestOptions.reasoning ?? currentBody.reasoning;
	const reasoningContext = canonicalReasoning?.context;
	return {
		...historyBody,
		input: structuredClone(currentBody.input),
		instructions: currentBody.instructions,
		tools: structuredClone(currentBody.tools),
		tool_choice: structuredClone(currentBody.tool_choice),
		parallel_tool_calls: currentBody.parallel_tool_calls,
		text: structuredClone(currentBody.text),
		...(reasoningContext || currentReasoning
			? {
					reasoning: {
						...(reasoningContext ? { context: reasoningContext } : {}),
						...structuredClone(currentReasoning ?? {}),
					},
				}
			: {}),
		...(currentBody.service_tier !== undefined ? { service_tier: currentBody.service_tier } : {}),
		...(currentBody.temperature !== undefined ? { temperature: currentBody.temperature } : {}),
		...(currentBody.client_metadata ? { client_metadata: structuredClone(currentBody.client_metadata) } : {}),
	};
}

export const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";

export function withRemoteCompactionV2Feature(headers: ProviderHeaders | undefined): ProviderHeaders {
	const merged: ProviderHeaders = { ...headers };
	const values: string[] = [];
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (name.toLowerCase() !== "x-codex-beta-features") continue;
		delete merged[name];
		if (typeof value === "string") values.push(value);
	}
	const features: string[] = [];
	const seen = new Set<string>();
	for (const value of values.flatMap((configured) => configured.split(","))) {
		const feature = value.trim();
		if (!feature || feature.toLowerCase() === REMOTE_COMPACTION_V2_FEATURE || seen.has(feature.toLowerCase())) continue;
		seen.add(feature.toLowerCase());
		features.push(feature);
	}
	features.push(REMOTE_COMPACTION_V2_FEATURE);
	merged["x-codex-beta-features"] = features.join(",");
	return merged;
}

async function runAttempt(
	options: ExecuteRemoteCompactionV2Options,
	streamSimple: V2Stream,
): Promise<RemoteCompactionV2Result> {
	const outputItems: unknown[] = [];
	let responseStatus: number | undefined;
	let sentRequestBody: ResponsesBody | undefined;
	const canonicalIdentity = canonicalSessionIdentity(options);
	const canonicalBody =
		options.promptInputSource !== "reconstructed" && canonicalIdentity
			? canonicalCompactionRequestBody(options.sessionId, options.runtime.model, canonicalIdentity)
			: undefined;
	const streamOptions = {
		apiKey: options.runtime.apiKey,
		headers: withRemoteCompactionV2Feature(options.runtime.headers),
		sessionId: options.sessionId,
		signal: options.signal,
		transport: options.transport ?? "websocket-cached",
		canonicalCompaction: true,
		maxRetries: MAX_STREAM_RETRIES,
		...(typeof options.requestOptions.service_tier === "string"
			? { serviceTier: options.requestOptions.service_tier }
			: {}),
		...(typeof options.requestOptions.text === "object" &&
		options.requestOptions.text &&
		"verbosity" in options.requestOptions.text
			? { textVerbosity: String((options.requestOptions.text as { verbosity: unknown }).verbosity) }
			: {}),
		onOutputItemDone: (item: unknown) => outputItems.push(item),
		onResponse: (response: { status: number }) => {
			responseStatus = response.status;
		},
		onPayload: async (payload: unknown) => {
			const body = payload as ResponsesBody;
			const requestBody = canonicalBody
				? withCurrentCompactionControls(canonicalBody, body, options.requestOptions)
				: body;
			const promptInput = normalizeRemoteCompactionV2PromptInput(options.promptInput) as ResponsesInputItem[];
			const request: NativeCompactionRequestBody = {
				model: requestBody.model,
				input: promptInput,
				instructions: typeof requestBody.instructions === "string" ? requestBody.instructions : "",
			};
			const shrunk = await shrinkNativeCompactionRequestForEndpoint(request, {
				budgetTokens: resolveNativeCompactionRequestBudget({
					contextWindow: options.runtime.currentModel.contextWindow,
				}),
				tokensBefore: options.tokensBefore,
			});
			sentRequestBody = {
				...requestBody,
				...structuredClone(options.requestOptions),
				input: [...shrunk.request.input, { type: "compaction_trigger" }],
				...(!canonicalBody && options.requestOptions.reasoning
					? { reasoning: structuredClone(options.requestOptions.reasoning) }
					: {}),
			} as ResponsesBody;
			return sentRequestBody;
		},
	} as OpenAICodexStreamOptions;

	let completed: AssistantMessage | undefined;
	let completedNormally = false;
	for await (const rawEvent of streamSimple(options.runtime.currentModel, options.context, streamOptions)) {
		const event = rawEvent as { type?: string; reason?: string; message?: AssistantMessage; error?: AssistantMessage };
		if (event.type === "done") {
			completed = event.message;
			completedNormally = event.reason === "stop" && event.message?.stopReason === "stop";
		}
		if (event.type === "error") {
			const message = event.error?.errorMessage || "Responses compaction v2 stream failed";
			return {
				ok: false,
				reason: isAborted(options.signal, message) ? "aborted" : "stream-error",
				errorMessage: message,
				...(responseStatus !== undefined ? { status: responseStatus } : {}),
			};
		}
	}
	if (!completed?.responseId || !completedNormally)
		return {
			ok: false,
			reason: "stream-error",
			errorMessage: "Responses compaction v2 stream did not complete normally",
		};
	const compactions = outputItems
		.map(canonicalCompactionOutput)
		.filter((item): item is Record<string, unknown> => item !== undefined);
	if (compactions.length !== 1)
		return {
			ok: false,
			reason: "invalid-output",
			errorMessage: `Responses compaction v2 expected exactly one compaction output item, got ${compactions.length} from ${outputItems.length} output items`,
		};
	if (!sentRequestBody)
		return {
			ok: false,
			reason: "invalid-output",
			errorMessage: "Responses compaction v2 did not expose the exact request body",
		};
	const sentPromptInput = sentRequestBody.input.slice(0, -1);
	const replayBody: ResponsesBody = {
		...structuredClone(sentRequestBody),
		input: buildRemoteCompactionV2Window(sentPromptInput, compactions[0]!),
	};
	return {
		ok: true,
		compaction: compactions[0]!,
		responseId: completed.responseId,
		createdAt: new Date().toISOString(),
		replayBody,
		usage: compactionUsage(completed),
	};
}

export async function executeRemoteCompactionV2(
	options: ExecuteRemoteCompactionV2Options,
): Promise<RemoteCompactionV2Result> {
	const streamSimple = resolveStream(options);
	if (!streamSimple)
		return {
			ok: false,
			reason: "unavailable",
			errorMessage: "No compatible Responses stream is registered for this provider",
		};
	const transport = isWebSocketSseFallbackActive(options.sessionId) ? "sse" : (options.transport ?? "websocket-cached");
	const result = await runAttempt({ ...options, transport }, streamSimple);
	if (!result.ok) return result;
	await options.runtime.hooks?.resetTransportAfterCompaction?.(options.sessionId);
	try {
		await options.runtime.hooks?.startCompactionPrewarm?.({
			sessionId: options.sessionId,
			model: options.runtime.currentModel,
			body: structuredClone(result.replayBody),
		});
	} catch {
		// Prewarm is an optimization. The next request can establish transport normally.
	}
	return result;
}
