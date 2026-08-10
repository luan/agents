import { randomUUID } from "node:crypto";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction } from "./compact-client";
import { writeDebugArtifact } from "./debug";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import { rewriteResponsesPayloadWithNativeReplay, serializeLiveTailToResponsesInput } from "./payload-rewrite";
import { type NativeCompactionRuntime, resolveNativeCompactionEnvironment } from "./runtime";
import { type NativeCompactionRequestBody, serializeMessagesToCompactRequest } from "./serializer";
import { loadExtensionSettings } from "./settings";
import {
	createNativeCompactionDetails,
	createNativeCompactionShimResult,
	EXTENSION_ID,
	isNativeCompactionDetails,
	type NativeCompactionRequestMeta,
} from "./types";

const compactionPhaseSetterKey = Symbol.for("agents.pi.compaction-phases.set");
const COMPACTION_REQUEST_OPTION_KEYS = [
	"tools",
	"tool_choice",
	"parallel_tool_calls",
	"reasoning",
	"stream_options",
	"include",
	"service_tier",
	"prompt_cache_key",
	"text",
	"client_metadata",
] as const;
type RequestOptionsSnapshot = {
	identity: {
		provider: string;
		api: string;
		model: string;
		baseUrl: string;
	};
	options: Record<string, unknown>;
};

const requestOptionsBySession = new WeakMap<object, RequestOptionsSnapshot>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizedBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function rememberRequestOptions(payload: unknown, ctx: ExtensionContext): void {
	const model = ctx.model;
	if (!model || !isRecord(payload) || payload.model !== model.id) return;
	const options: Record<string, unknown> = {};
	for (const key of COMPACTION_REQUEST_OPTION_KEYS) {
		if (payload[key] !== undefined) options[key] = structuredClone(payload[key]);
	}
	requestOptionsBySession.set(ctx.sessionManager, {
		identity: {
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: normalizedBaseUrl(model.baseUrl),
		},
		options,
	});
}

function compactionMetadata(event: SessionBeforeCompactEvent): Record<string, unknown> {
	const reason = event.reason ?? "manual";
	return {
		trigger: reason === "manual" ? "manual" : "auto",
		reason: reason === "manual" ? "user_requested" : "context_limit",
		implementation: "responses_compaction_v2",
		phase: reason === "overflow" ? "mid_turn" : reason === "threshold" ? "pre_turn" : "standalone_turn",
		strategy: "memento",
	};
}

function buildCompactionClientMetadata(
	value: unknown,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Record<string, unknown> {
	const reason = event.reason ?? "manual";
	const clientMetadata = isRecord(value) ? structuredClone(value) : {};
	const sessionId = ctx.sessionManager.getSessionId();
	const threadId = typeof clientMetadata.thread_id === "string" ? clientMetadata.thread_id : sessionId;
	const windowId =
		typeof clientMetadata["x-codex-window-id"] === "string" ? clientMetadata["x-codex-window-id"] : sessionId;
	if (sessionId) clientMetadata.session_id = sessionId;
	if (threadId) clientMetadata.thread_id = threadId;
	if (windowId) clientMetadata["x-codex-window-id"] = windowId;
	const turnId =
		reason === "manual"
			? randomUUID()
			: typeof clientMetadata.turn_id === "string"
				? clientMetadata.turn_id
				: undefined;
	if (turnId) clientMetadata.turn_id = turnId;

	const rawTurnMetadata = clientMetadata["x-codex-turn-metadata"];
	let turnMetadata: Record<string, unknown> = {};
	if (typeof rawTurnMetadata === "string") {
		try {
			const parsed = JSON.parse(rawTurnMetadata);
			if (isRecord(parsed)) turnMetadata = parsed;
		} catch {
			turnMetadata = {};
		}
	} else if (isRecord(rawTurnMetadata)) {
		turnMetadata = structuredClone(rawTurnMetadata);
	}
	if (sessionId) turnMetadata.session_id = sessionId;
	if (threadId) turnMetadata.thread_id = threadId;
	if (windowId) turnMetadata.window_id = windowId;
	if (turnId) turnMetadata.turn_id = turnId;
	turnMetadata.request_kind = "compaction";
	turnMetadata.compaction = compactionMetadata(event);
	clientMetadata["x-codex-turn-metadata"] = JSON.stringify(turnMetadata);
	return clientMetadata;
}

function matchesRuntime(snapshot: RequestOptionsSnapshot | undefined, runtime: NativeCompactionRuntime): boolean {
	return (
		snapshot?.identity.provider === runtime.provider &&
		snapshot.identity.api === runtime.api &&
		snapshot.identity.model === runtime.model &&
		snapshot.identity.baseUrl === normalizedBaseUrl(runtime.baseUrl)
	);
}

function fallbackRequestOptions(pi: ExtensionAPI, runtime: NativeCompactionRuntime): Record<string, unknown> {
	const activeNames = new Set(pi.getActiveTools?.() ?? []);
	const tools = (pi.getAllTools?.() ?? [])
		.filter((tool) => activeNames.has(tool.name))
		.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: structuredClone(tool.parameters),
			strict: false,
		}));
	const requestedThinkingLevel = pi.getThinkingLevel?.();
	const clampedThinkingLevel = requestedThinkingLevel
		? clampThinkingLevel(runtime.currentModel, requestedThinkingLevel)
		: "off";
	const mappedThinkingLevel = runtime.currentModel.thinkingLevelMap?.[clampedThinkingLevel];
	const reasoningEffort = mappedThinkingLevel === null ? undefined : (mappedThinkingLevel ?? clampedThinkingLevel);
	return {
		tools,
		tool_choice: "auto",
		parallel_tool_calls: true,
		...(reasoningEffort && reasoningEffort !== "off"
			? { reasoning: { effort: reasoningEffort, summary: "auto" } }
			: {}),
	};
}

function withV2RequestOptions(
	request: NativeCompactionRequestBody,
	event: SessionBeforeCompactEvent,
	runtime: NativeCompactionRuntime,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): NativeCompactionRequestBody & Record<string, unknown> {
	const snapshot = requestOptionsBySession.get(ctx.sessionManager);
	const cachedOptions = matchesRuntime(snapshot, runtime) ? structuredClone(snapshot.options) : {};
	const options = { ...fallbackRequestOptions(pi, runtime), ...cachedOptions };
	const include = Array.isArray(options.include)
		? options.include.filter((value): value is string => typeof value === "string")
		: [];
	if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");

	return {
		...options,
		...request,
		include,
		...(runtime.provider === "openai-codex"
			? { client_metadata: buildCompactionClientMetadata(options.client_metadata, event, ctx) }
			: {}),
	};
}

function buildCompactionRequestMeta(
	event: SessionBeforeCompactEvent,
	tokensAfter?: number,
): NativeCompactionRequestMeta {
	return {
		tokensBefore: event.preparation.tokensBefore,
		tokensAfter,
		previousSummaryPresent: Boolean(event.preparation.previousSummary),
	};
}

function getCurrentModelDebugInfo(ctx: ExtensionContext) {
	return ctx.model
		? {
				provider: ctx.model.provider,
				id: ctx.model.id,
			}
		: undefined;
}

function getCompactionIdentityDebugInfo(entry: { details?: unknown } | undefined) {
	return isNativeCompactionDetails(entry?.details)
		? {
				provider: entry.details.provider,
				api: entry.details.api,
				model: entry.details.model,
				baseUrl: entry.details.baseUrl,
			}
		: undefined;
}

function cloneOpaqueWindow(window: readonly unknown[]): unknown[] {
	return window.map((item) => structuredClone(item));
}

function buildCompactionInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	if (!guidance) {
		return systemPrompt;
	}

	return `${systemPrompt}\n\nAdditional user guidance for this manual /compact request:\n${guidance}`;
}

async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	piContext: ExtensionContext,
	pi: ExtensionAPI,
) {
	const { settings } = loadExtensionSettings(piContext.cwd);
	if (!settings.enabled) {
		return undefined;
	}

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact",
			customInstructions: event.customInstructions,
			preparation: {
				tokensBefore: event.preparation.tokensBefore,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				previousSummaryPresent: Boolean(event.preparation.previousSummary),
				messagesToSummarizeCount: event.preparation.messagesToSummarize.length,
				turnPrefixMessagesCount: event.preparation.turnPrefixMessages.length,
			},
		},
		settings,
		piContext,
	);

	if (event.signal.aborted) {
		return { cancel: true };
	}

	const resolution = await resolveNativeCompactionEnvironment(piContext, {
		enabled: settings.enabled,
		supportedProviders: settings.supportedProviders,
		supportedApis: settings.supportedApis,
	});
	if (resolution.ok === false) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.skip",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
			},
			settings,
			piContext,
		);
		return undefined;
	}

	const runtime = resolution.runtime;
	const instructions = buildCompactionInstructions(piContext.getSystemPrompt(), event.customInstructions);
	const branchEntries = piContext.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});

	let requestSource: "session-context" | "latest-native-replay";
	let request = undefined as ReturnType<typeof serializeMessagesToCompactRequest> | undefined;
	if (latestNativeCompaction.ok) {
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		requestSource = "latest-native-replay";
		request = {
			model: runtime.currentModel.id,
			input: [
				...cloneOpaqueWindow(latestNativeCompaction.entry.details.compactedWindow),
				...serializeLiveTailToResponsesInput({
					model: runtime.currentModel,
					entries: liveTailEntries,
				}),
			],
			instructions,
		};
	} else if (
		latestNativeCompaction.reason === "no-compaction" ||
		latestNativeCompaction.reason === "latest-compaction-not-native"
	) {
		requestSource = "session-context";
		request = serializeMessagesToCompactRequest({
			model: runtime.currentModel,
			messages: piContext.sessionManager.buildSessionContext().messages,
			instructions,
		});
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.skip",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
			},
			settings,
			piContext,
		);
		return undefined;
	}

	request = withV2RequestOptions(request, event, runtime, piContext, pi);

	const setCompactionPhase = (
		globalThis as typeof globalThis & {
			[compactionPhaseSetterKey]?: (
				phase: "summarizing",
				tokensBefore?: number,
				reason?: "manual" | "threshold" | "overflow",
			) => void;
		}
	)[compactionPhaseSetterKey];
	setCompactionPhase?.("summarizing", event.preparation.tokensBefore, event.reason);

	const compactResult = await executeNativeCompaction({
		runtime,
		request,
		signal: event.signal,
		settings,
		context: piContext,
	});

	if (compactResult.ok === false) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.native-failure",
				reason: compactResult.reason,
				status: compactResult.status,
				errorMessage: compactResult.errorMessage,
			},
			settings,
			piContext,
		);
		return compactResult.reason === "aborted" ? { cancel: true } : undefined;
	}

	let details: ReturnType<typeof createNativeCompactionDetails>;
	try {
		details = createNativeCompactionDetails({
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactedWindow: compactResult.compactedWindow,
			compactResponseId: compactResult.compactResponseId,
			createdAt: compactResult.createdAt,
			requestMeta: buildCompactionRequestMeta(event, compactResult.estimatedTokensAfter),
		});
	} catch (error) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.invalid-native-details",
				reason: error instanceof Error ? error.message : String(error),
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
			},
			settings,
			piContext,
		);
		return undefined;
	}
	const compaction = createNativeCompactionShimResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
	});

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.native-success",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			requestSource,
			requestInputItems: request.input.length,
			compactResponseId: compactResult.compactResponseId,
			compactedItems: compactResult.compactedWindow.length,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
		},
		settings,
		piContext,
	);

	return { compaction };
}

async function handleBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext) {
	const { settings } = loadExtensionSettings(ctx.cwd);
	if (!settings.enabled) {
		return undefined;
	}
	rememberRequestOptions(event.payload, ctx);

	const branchEntries = ctx.sessionManager.getBranch();
	const latestAnyNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries);
	if (!latestAnyNativeCompaction.ok) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.no-native-compaction",
				reason: latestAnyNativeCompaction.reason,
				currentModel: getCurrentModelDebugInfo(ctx),
				branchEntries: branchEntries.length,
				latestCompactionIndex: latestAnyNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestAnyNativeCompaction.latestCompaction),
				payload: event.payload,
			},
			settings,
			ctx,
		);
		return undefined;
	}

	const resolution = await resolveNativeCompactionEnvironment(
		ctx,
		{
			enabled: settings.enabled,
			supportedProviders: settings.supportedProviders,
			supportedApis: settings.supportedApis,
		},
		event.payload,
	);
	if (resolution.ok === false) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.skip",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
				currentModel: getCurrentModelDebugInfo(ctx),
				payload: event.payload,
			},
			settings,
			ctx,
		);
		return undefined;
	}

	const runtime = resolution.runtime;
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});
	if (!latestNativeCompaction.ok) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.no-native-compaction",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				branchEntries: branchEntries.length,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
				payload: runtime.payload,
			},
			settings,
			ctx,
		);
		return undefined;
	}

	const latestNativeCompactionEntry = latestNativeCompaction.entry;
	const rewrite = rewriteResponsesPayloadWithNativeReplay({
		model: runtime.currentModel,
		payload: runtime.payload,
		branchEntries,
		compactionEntry: latestNativeCompactionEntry,
	});
	if (!rewrite.ok) {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.rewrite-failed",
				reason: rewrite.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				compactionEntryId: latestNativeCompactionEntry.id,
				parity: rewrite.parity,
				payload: runtime.payload,
			},
			settings,
			ctx,
		);
		return undefined;
	}

	writeDebugArtifact(
		"provider-request",
		{
			event: "before_provider_request.native-rewrite",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactionEntryId: latestNativeCompactionEntry.id,
			boundaryIndex: rewrite.segments.boundaryIndex,
			firstKeptEntryIndex: rewrite.segments.firstKeptEntryIndex,
			originalInputItems: runtime.payload.input.length,
			rewrittenInputItems: rewrite.rewrittenPayload.input.length,
			freshPreambleItems: rewrite.segments.freshPreamble.length,
			trailingPreambleItems: rewrite.segments.trailingPreamble.length,
			compactionSummaryItems: rewrite.segments.compactionSummary.length,
			preCompactionKeptItems: rewrite.segments.preCompactionKeptWindow.input.length,
			compactedItems: rewrite.segments.compactedWindow.length,
			postCompactionTailItems: rewrite.segments.postCompactionTail.input.length,
			payload: rewrite.rewrittenPayload,
			originalPayload: runtime.payload,
		},
		settings,
		ctx,
	);

	return rewrite.rewrittenPayload;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const { settings, warnings } = loadExtensionSettings(ctx.cwd);
		if (!settings.enabled) return;

		if (warnings.length > 0 && ctx.hasUI && settings.debug) {
			ctx.ui.notify(`${EXTENSION_ID}: ${warnings[0]}`, "warning");
		}

		const artifactPath = writeDebugArtifact(
			"lifecycle",
			{
				event: "session_start",
				settings,
				warnings,
			},
			settings,
			ctx,
		);

		if (ctx.hasUI && (settings.notifyOnLoad || settings.debug)) {
			ctx.ui.notify(
				artifactPath ? `${EXTENSION_ID} loaded • debug artifacts → ${artifactPath}` : `${EXTENSION_ID} loaded`,
				"info",
			);
		}
	});

	pi.on("session_before_compact", (event, ctx) => handleSessionBeforeCompact(event, ctx, pi));
	pi.on("before_provider_request", handleBeforeProviderRequest);
}
