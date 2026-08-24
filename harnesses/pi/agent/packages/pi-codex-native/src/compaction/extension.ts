import { clampThinkingLevel, type Api, type Context, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	type BeforeProviderRequestEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveLatestNativeCompactionEntry } from "./details-store.ts";
import {
	filterNativeCompactionContextMessages,
	rewriteResponsesPayloadWithNativeReplay,
	serializeLiveTailToResponsesInput,
} from "./payload-rewrite.ts";
import { executeRemoteCompactionV2 } from "./remote-v2-client.ts";
import {
	resolveNativeCompactionEnvironment,
	type NativeCompactionRuntime,
	type NativeCompactionRuntimeHooks,
	type ResponsesCompatibleRequestPayload,
} from "./runtime.ts";
import {
	serializeMessagesToCompactRequest,
	type NativeCompactionRequestBody,
	type NativeCompactionRequestOptions,
	type ResponsesInputItem,
} from "./serializer.ts";
import {
	createNativeCompactionDetails,
	createNativeCompactionShimResult,
	NATIVE_COMPACTION_SHIM_SUMMARY,
} from "./types.ts";
import { resolveCurrentPromptEnvelope, type PromptEnvelope } from "../prompt-envelope.ts";
import { serializeDeveloperMessage } from "../prompt-payload-adapter.ts";
import { getCodexNativeSettings, type CodexNativeSettings } from "../contributions/xsettings.ts";

type PendingFallback = {
	window: ResponsesInputItem[];
	provider: string;
	api: string;
	baseUrl: string;
	sessionId: string;
};

const pendingFallbacks = new WeakMap<object, PendingFallback>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function notify(ctx: ExtensionContext, message: string, level: "warning" | "error" = "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function cloneWindow(window: readonly unknown[]): ResponsesInputItem[] | undefined {
	if (!window.every(isRecord)) return undefined;
	return window.map((item) => structuredClone(item) as ResponsesInputItem);
}

function matchesRuntime(
	pending: Pick<PendingFallback, "provider" | "api" | "baseUrl">,
	runtime: Pick<NativeCompactionRuntime, "provider" | "api" | "baseUrl">,
): boolean {
	return pending.provider === runtime.provider && pending.api === runtime.api && pending.baseUrl === runtime.baseUrl;
}

function stashFallback(
	ctx: ExtensionContext,
	runtime: NativeCompactionRuntime,
	latest: ReturnType<typeof resolveLatestNativeCompactionEntry>,
	signal?: AbortSignal,
): boolean {
	pendingFallbacks.delete(ctx.sessionManager);
	if (!latest.ok) return false;
	const window = cloneWindow(latest.entry.details?.compactedWindow ?? []);
	if (!window?.length) return false;
	const pending: PendingFallback = {
		window,
		provider: runtime.provider,
		api: runtime.api,
		baseUrl: runtime.baseUrl,
		sessionId: ctx.sessionManager.getSessionId(),
	};
	pendingFallbacks.set(ctx.sessionManager, pending);
	signal?.addEventListener(
		"abort",
		() => {
			if (pendingFallbacks.get(ctx.sessionManager) === pending) pendingFallbacks.delete(ctx.sessionManager);
		},
		{ once: true },
	);
	return true;
}

function handleNativeFailure(
	ctx: ExtensionContext,
	message: string,
	fallbackCompaction: boolean,
	runtime: NativeCompactionRuntime,
	latest: ReturnType<typeof resolveLatestNativeCompactionEntry>,
	signal?: AbortSignal,
): { cancel: true } | undefined {
	if (!fallbackCompaction) {
		pendingFallbacks.delete(ctx.sessionManager);
		notify(ctx, `${message} Pi fallback compaction is disabled.`);
		return { cancel: true };
	}
	const preserved = stashFallback(ctx, runtime, latest, signal);
	notify(ctx, `${message} Pi compaction will run.${preserved ? " The prior remote checkpoint will be included." : ""}`);
	return undefined;
}

function responseText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (isRecord(item) && item.type === "input_text" && typeof item.text === "string" ? item.text : ""))
		.join("\n");
}

function withoutStalePromptEnvelope(input: readonly ResponsesInputItem[]): ResponsesInputItem[] {
	return input.filter((item) => {
		if (!isRecord(item)) return true;
		const record = item as Record<string, unknown>;
		const text = responseText(record.content);
		if (record.role === "developer" && text.startsWith('<pi_system_prompt_developer_message id="')) return false;
		return record.role !== "user" || !text.startsWith("# AGENTS.md instructions for ");
	});
}

function isPiCompactionRequest(payload: ResponsesCompatibleRequestPayload): boolean {
	return (
		typeof payload.instructions === "string" &&
		payload.instructions.startsWith("You are a context summarization assistant.")
	);
}

async function injectPendingFallback(
	payload: unknown,
	ctx: ExtensionContext,
	hooks?: NativeCompactionRuntimeHooks,
): Promise<ResponsesCompatibleRequestPayload | undefined> {
	const pending = pendingFallbacks.get(ctx.sessionManager);
	if (!pending || !isRecord(payload) || typeof payload.model !== "string" || !Array.isArray(payload.input))
		return undefined;
	const request = payload as ResponsesCompatibleRequestPayload;
	if (pending.sessionId !== ctx.sessionManager.getSessionId()) {
		pendingFallbacks.delete(ctx.sessionManager);
		return undefined;
	}
	if (!isPiCompactionRequest(request)) return undefined;
	const resolution = await resolveNativeCompactionEnvironment(ctx, hooks, request);
	if (!resolution.ok || !matchesRuntime(pending, resolution.runtime)) return undefined;

	let insertAt = 0;
	while (insertAt < request.input.length) {
		const item = request.input[insertAt];
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break;
		insertAt++;
	}
	pendingFallbacks.delete(ctx.sessionManager);
	return {
		...request,
		input: [
			...request.input.slice(0, insertAt),
			...pending.window.map((item) => structuredClone(item)),
			...request.input.slice(insertAt),
		],
	};
}

function reasoningOptions(pi: ExtensionAPI, model: Model<Api>): NativeCompactionRequestOptions["reasoning"] {
	const requested = pi.getThinkingLevel?.();
	if (!requested || requested === "off" || !model.reasoning) return undefined;
	const clamped = clampThinkingLevel(model, requested as ModelThinkingLevel);
	const effort = model.thinkingLevelMap?.[clamped] ?? clamped;
	return effort === null ? undefined : { effort, summary: "auto" };
}

function activeTools(pi: ExtensionAPI) {
	const active = new Set(pi.getActiveTools?.() ?? []);
	return (pi.getAllTools?.() ?? []).filter((tool) => active.has(tool.name));
}

function compactionRequestOptions(pi: ExtensionAPI, model: Model<Api>): NativeCompactionRequestOptions {
	const reasoning = reasoningOptions(pi, model);
	return {
		...(reasoning ? { reasoning } : {}),
	};
}

function compactionInput(
	ctx: ExtensionContext,
	runtime: NativeCompactionRuntime,
	latest: ReturnType<typeof resolveLatestNativeCompactionEntry>,
	envelope: PromptEnvelope | undefined,
): { request: NativeCompactionRequestBody; compactedKeptWindow: boolean } | undefined {
	const instructions = envelope?.systemPrompt ?? ctx.getSystemPrompt();
	const promptEnvelope: ResponsesInputItem[] = envelope
		? [
				...envelope.developerMessages.map((message) => ({
					role: "developer",
					content: serializeDeveloperMessage(message),
				})),
				...envelope.contextualUserMessages.map((message) => ({
					role: "user",
					content: [{ type: "input_text", text: message.content }],
				})),
			]
		: [];
	if (latest.ok) {
		const compactedWindow = cloneWindow(latest.entry.details?.compactedWindow ?? []);
		if (!compactedWindow) return undefined;
		return {
			request: {
				model: runtime.model,
				instructions,
				input: [
					...promptEnvelope,
					...withoutStalePromptEnvelope(compactedWindow),
					...serializeLiveTailToResponsesInput({
						model: runtime.currentModel,
						entries: ctx.sessionManager.getBranch().slice(latest.index + 1),
					}),
				],
			},
			compactedKeptWindow: false,
		};
	}

	if (latest.reason === "latest-native-compaction-mismatch") return undefined;
	const session = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const request = serializeMessagesToCompactRequest({
		model: runtime.currentModel,
		messages: filterNativeCompactionContextMessages(session.messages),
		instructions,
	});
	return {
		request: { ...request, input: [...promptEnvelope, ...request.input] },
		compactedKeptWindow: true,
	};
}

async function handleBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	hooks?: NativeCompactionRuntimeHooks,
	getSettings: () => CodexNativeSettings = getCodexNativeSettings,
) {
	if (ctx.model?.provider !== "openai-codex" || ctx.model.api !== "openai-codex-responses") return undefined;
	if (event.signal.aborted) return { cancel: true };
	const { fallbackCompaction } = getSettings();
	const resolution = await resolveNativeCompactionEnvironment(ctx, hooks);
	if (!resolution.ok) {
		notify(ctx, `Remote compaction is unavailable (${resolution.reason}); compaction was cancelled.`);
		return { cancel: true };
	}
	const runtime = resolution.runtime;
	const latest = resolveLatestNativeCompactionEntry(ctx.sessionManager.getBranch(), {
		provider: runtime.provider,
		api: runtime.api,
		baseUrl: runtime.baseUrl,
	});
	if (!latest.ok && latest.reason === "latest-native-compaction-mismatch") {
		notify(
			ctx,
			"Remote compaction cannot reuse the latest checkpoint with this provider endpoint; compaction was cancelled.",
		);
		return { cancel: true };
	}
	let envelope: PromptEnvelope | undefined;
	try {
		const currentEnvelope = resolveCurrentPromptEnvelope(ctx.sessionManager.getSessionId(), {
			provider: ctx.model?.provider,
			activeTools: pi.getActiveTools(),
			cwd: ctx.cwd,
		});
		if (currentEnvelope.serviceAvailable && !currentEnvelope.envelope) {
			return handleNativeFailure(
				ctx,
				"The current prompt envelope is not available yet.",
				fallbackCompaction,
				runtime,
				latest,
				event.signal,
			);
		}
		envelope = currentEnvelope.envelope;
	} catch (error) {
		notify(
			ctx,
			`Current prompt envelope could not be built (${error instanceof Error ? error.message : String(error)}); compaction was cancelled.`,
		);
		return { cancel: true };
	}
	const built = compactionInput(ctx, runtime, latest, envelope);
	if (!built || built.request.input.length === 0) {
		notify(ctx, "Remote compaction had no replayable conversation input; compaction was cancelled.");
		return { cancel: true };
	}
	if (event.customInstructions?.trim()) {
		notify(ctx, "Remote compaction uses the active system prompt and ignores custom /compact guidance.", "warning");
	}
	const tools = activeTools(pi);
	const context: Context = {
		systemPrompt: built.request.instructions,
		messages: [],
		...(tools.length ? { tools: tools as Context["tools"] } : {}),
	};
	let result: Awaited<ReturnType<typeof executeRemoteCompactionV2>>;
	try {
		result = await executeRemoteCompactionV2({
			runtime,
			modelRegistry: ctx.modelRegistry,
			context,
			promptInput: built.request.input,
			requestOptions: compactionRequestOptions(pi, runtime.currentModel),
			tokensBefore: event.preparation.tokensBefore,
			sessionId: ctx.sessionManager.getSessionId(),
			signal: event.signal,
		});
	} catch (error) {
		if (event.signal.aborted) return { cancel: true };
		const message = error instanceof Error ? error.message : String(error);
		return handleNativeFailure(
			ctx,
			`Remote compaction failed (${message}).`,
			fallbackCompaction,
			runtime,
			latest,
			event.signal,
		);
	}
	if (!result.ok) {
		if (result.reason === "aborted") return { cancel: true };
		return handleNativeFailure(
			ctx,
			`Remote compaction failed (${result.reason}).`,
			fallbackCompaction,
			runtime,
			latest,
			event.signal,
		);
	}
	try {
		const details = createNativeCompactionDetails({
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactedWindow: result.replayBody.input,
			compactResponseId: result.responseId,
			createdAt: result.createdAt,
			usage: result.usage,
			requestMeta: {
				tokensBefore: event.preparation.tokensBefore,
				previousSummaryPresent: Boolean(event.preparation.previousSummary),
				compactedKeptWindow: built.compactedKeptWindow,
			},
		});
		return {
			compaction: createNativeCompactionShimResult({
				summary: NATIVE_COMPACTION_SHIM_SUMMARY,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details,
			}),
		};
	} catch {
		return handleNativeFailure(
			ctx,
			"Remote compaction returned an invalid replay window.",
			fallbackCompaction,
			runtime,
			latest,
			event.signal,
		);
	}
}

async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	hooks?: NativeCompactionRuntimeHooks,
) {
	const fallback = await injectPendingFallback(event.payload, ctx, hooks);
	if (fallback) return fallback;
	if (ctx.model?.provider !== "openai-codex" || ctx.model.api !== "openai-codex-responses") return undefined;
	const latest = resolveLatestNativeCompactionEntry(ctx.sessionManager.getBranch());
	if (!latest.ok) return undefined;
	const resolution = await resolveNativeCompactionEnvironment(ctx, hooks, event.payload);
	if (!resolution.ok) return undefined;
	const runtime = resolution.runtime;
	const matching = resolveLatestNativeCompactionEntry(ctx.sessionManager.getBranch(), {
		provider: runtime.provider,
		api: runtime.api,
		baseUrl: runtime.baseUrl,
	});
	if (!matching.ok) {
		const message = "Remote compaction replay cannot use the latest checkpoint with this provider endpoint.";
		notify(ctx, message);
		throw new Error(message);
	}
	if (!runtime.payload) return undefined;
	const rewrite = rewriteResponsesPayloadWithNativeReplay({
		model: runtime.currentModel,
		payload: runtime.payload,
		branchEntries: ctx.sessionManager.getBranch(),
		compactionEntry: matching.entry,
	});
	if (rewrite.ok) return rewrite.rewrittenPayload;
	const detail = rewrite.parity?.mismatches.slice(0, 3).join("; ");
	const message = `Remote compaction replay failed (${rewrite.reason})${detail ? `: ${detail}` : ""}.`;
	notify(ctx, message);
	throw new Error(message);
}

export default function registerNativeCompaction(
	pi: ExtensionAPI,
	hooks?: NativeCompactionRuntimeHooks,
	getSettings: () => CodexNativeSettings = getCodexNativeSettings,
): void {
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			return await handleBeforeCompact(event, ctx, pi, hooks, getSettings);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Remote compaction failed unexpectedly: ${message}`);
			return { cancel: true };
		}
	});
	pi.on("before_provider_request", (event, ctx) => handleBeforeProviderRequest(event, ctx, hooks));
	pi.on("session_compact", (_event, ctx) => {
		pendingFallbacks.delete(ctx.sessionManager);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		pendingFallbacks.delete(ctx.sessionManager);
	});
}
