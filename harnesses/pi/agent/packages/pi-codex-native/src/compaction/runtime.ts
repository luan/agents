import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResponsesBody } from "../provider/types.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";

export type ResponsesCompatibleRequestPayload = {
	model: string;
	input: unknown[];
	instructions?: unknown;
	[key: string]: unknown;
};

export type NativeCompactionRuntimeHooks = {
	resetTransportAfterCompaction?: (sessionId: string) => void | Promise<void>;
	startCompactionPrewarm?: (input: {
		sessionId: string;
		model: Model<Api>;
		body: ResponsesBody;
	}) => void | Promise<void>;
};

export type NativeCompactionRuntime = {
	provider: typeof CODEX_PROVIDER;
	api: typeof CODEX_API;
	hooks?: NativeCompactionRuntimeHooks;
	model: string;
	baseUrl: string;
	apiKey: string;
	headers?: ProviderHeaders;
	payload?: ResponsesCompatibleRequestPayload;
	currentModel: Model<Api>;
};

type NativeCompactionEnvironmentResolution =
	| { ok: true; runtime: NativeCompactionRuntime }
	| {
			ok: false;
			reason:
				| "missing-model"
				| "unsupported-provider"
				| "unsupported-api"
				| "missing-base-url"
				| "missing-api-key"
				| "unsupported-payload"
				| "payload-model-mismatch";
	  };

function normalizeBaseUrl(baseUrl: string | undefined | null): string | undefined {
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	return normalized || undefined;
}

function isResponsesPayload(payload: unknown): payload is ResponsesCompatibleRequestPayload {
	return (
		!!payload &&
		typeof payload === "object" &&
		!Array.isArray(payload) &&
		typeof (payload as Record<string, unknown>).model === "string" &&
		Array.isArray((payload as Record<string, unknown>).input)
	);
}

async function resolveRequestAuth(
	ctx: ExtensionContext,
	model: Model<Api>,
): Promise<{ apiKey?: string; headers?: ProviderHeaders }> {
	const registry = ctx.modelRegistry as {
		getApiKeyAndHeaders?: (
			currentModel: Model<Api>,
		) => Promise<{ ok: true; apiKey?: string; headers?: ProviderHeaders } | { ok: false; error: string }>;
	};
	if (typeof registry.getApiKeyAndHeaders !== "function") return {};
	const auth = await registry.getApiKeyAndHeaders(model);
	return auth.ok ? { apiKey: auth.apiKey, headers: auth.headers } : {};
}

export async function resolveNativeCompactionEnvironment(
	ctx: ExtensionContext,
	hooks?: NativeCompactionRuntimeHooks,
	payload?: unknown,
): Promise<NativeCompactionEnvironmentResolution> {
	const model = ctx.model as Model<Api> | undefined;
	if (!model) return { ok: false, reason: "missing-model" };
	if (model.provider !== CODEX_PROVIDER) return { ok: false, reason: "unsupported-provider" };
	if (model.api !== CODEX_API) return { ok: false, reason: "unsupported-api" };
	const baseUrl = normalizeBaseUrl(model.baseUrl);
	if (!baseUrl) return { ok: false, reason: "missing-base-url" };

	let requestPayload: ResponsesCompatibleRequestPayload | undefined;
	if (payload !== undefined) {
		if (!isResponsesPayload(payload)) return { ok: false, reason: "unsupported-payload" };
		if (payload.model !== model.id) return { ok: false, reason: "payload-model-mismatch" };
		requestPayload = payload;
	}

	const { apiKey, headers } = await resolveRequestAuth(ctx, model);
	if (!apiKey) return { ok: false, reason: "missing-api-key" };
	return {
		ok: true,
		runtime: {
			provider: CODEX_PROVIDER,
			api: CODEX_API,
			hooks,
			model: model.id,
			baseUrl,
			apiKey,
			headers,
			payload: requestPayload,
			currentModel: model,
		},
	};
}
