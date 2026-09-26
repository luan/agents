import type { Api, Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";

export type CodexCompatibleFeatures = {
	/** OpenAI request-body/header and local Pi behavior, enabled by default. */
	fastMode: boolean;
	contextWindow: boolean;
	textVerbosity: boolean;
	developerMessages: boolean;
};

/**
 * Registration policy for ordinary OpenAI-compatible routes. The defaults are
 * deliberately the normal OpenAI behavior; callers only need to override a
 * capability that their route does not expose (or a premium policy such as
 * fast mode).
 */

export type CodexCompatibleProviderOptions = {
	id?: string;
	provider: string;
	model?: string | ((id: string) => boolean);
	api?: string | string[];
	features?: Partial<CodexCompatibleFeatures>;
	/** OpenAI-compatible model metadata applied before pi-ai serializes requests. */
	/** API-specific pi-ai serializer overrides. Values for another API are ignored. */
	compat?: Partial<OpenAICompletionsCompat> | Partial<OpenAIResponsesCompat>;
	/** Backwards-compatible shorthand for the premium policy. */
	fastMode?: boolean | ((modelId: string) => boolean);
};

export type CodexCompatibleProvider = Omit<CodexCompatibleProviderOptions, "fastMode"> & {
	fastMode?: boolean;
	features: CodexCompatibleFeatures;
};

type Registration = CodexCompatibleProviderOptions & { features: CodexCompatibleFeatures };
type Registry = { registrations: Registration[] };
const REGISTRY_KEY = Symbol.for("pi.codex-native.compatibility-registry");
const globalObject = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
const registry = globalObject[REGISTRY_KEY] ?? { registrations: [] };
globalObject[REGISTRY_KEY] = registry;
const generatedCompatBases = new WeakMap<object, Record<string, unknown>>();

const ordinaryDefaults: CodexCompatibleFeatures = {
	fastMode: false,
	contextWindow: true,
	textVerbosity: true,
	developerMessages: true,
};

const OPENAI_COMPLETIONS_DEFAULTS: Partial<OpenAICompletionsCompat> = {
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: true,
	supportsLongCacheRetention: true,
};

const OPENAI_RESPONSES_DEFAULTS: Partial<OpenAIResponsesCompat> = {
	supportsDeveloperRole: true,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: true,
	supportsLongCacheRetention: true,
};

export const DEFAULT_CODEX_COMPATIBLE_FEATURES: Readonly<CodexCompatibleFeatures> = Object.freeze({
	...ordinaryDefaults,
});

const native: Registration = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	fastMode: true,
	features: { ...ordinaryDefaults, fastMode: true },
};

function normalized(options: CodexCompatibleProviderOptions): Registration {
	return {
		...options,
		fastMode: options.fastMode ?? options.features?.fastMode ?? false,
		features: {
			...ordinaryDefaults,
			...options.features,
			...(typeof options.fastMode === "boolean" ? { fastMode: options.fastMode } : {}),
		},
	};
}

function matches(registration: Registration, model: Model<Api>): boolean {
	if (model.provider !== registration.provider) return false;
	if (
		registration.api &&
		!(Array.isArray(registration.api) ? registration.api : [registration.api]).includes(model.api)
	)
		return false;
	if (typeof registration.model === "function" && !registration.model(model.id)) return false;
	if (
		typeof registration.model === "string" &&
		registration.model !== model.id &&
		!(registration.model.endsWith("*") && model.id.startsWith(registration.model.slice(0, -1)))
	)
		return false;
	return true;
}

function specificity(registration: Registration): number {
	return typeof registration.model === "string"
		? registration.model.endsWith("*")
			? 40
			: 50
		: typeof registration.model === "function"
			? 30
			: 20;
}

function apiSpecificity(registration: Registration): number {
	return registration.api ? 1 : 0;
}

export function registerCodexCompatibleProvider(options: CodexCompatibleProviderOptions): () => void {
	const registration = normalized(options);
	if (registration.id) {
		const existingIndex = registry.registrations.findIndex((item) => item.id === registration.id);
		if (existingIndex >= 0) registry.registrations.splice(existingIndex, 1);
	}
	registry.registrations.unshift(registration);
	return () => {
		const index = registry.registrations.indexOf(registration);
		if (index >= 0) registry.registrations.splice(index, 1);
	};
}

export function codexCompatibility(model: Model<Api> | undefined): CodexCompatibleProvider | undefined {
	if (!model) return undefined;
	const match = registry.registrations
		.map((registration, index) => ({ registration, index }))
		.filter(({ registration }) => matches(registration, model))
		.sort(
			(a, b) =>
				specificity(b.registration) - specificity(a.registration) ||
				apiSpecificity(b.registration) - apiSpecificity(a.registration) ||
				a.index - b.index,
		)[0];
	const registration = match?.registration ?? (matches(native, model) ? native : undefined);
	if (!registration) return undefined;
	const fastMode =
		typeof registration.fastMode === "function" ? registration.fastMode(model.id) : registration.features.fastMode;
	return { ...registration, fastMode, features: { ...registration.features, fastMode } };
}

/** Return the model with the selected route's OpenAI compatibility metadata applied. */
export function applyCodexCompatibility(model: Model<Api> | undefined): Model<Api> | undefined {
	if (!model) return undefined;
	const registration = codexCompatibility(model);
	if (!registration) return model;
	const defaults =
		model.api === "openai-completions"
			? OPENAI_COMPLETIONS_DEFAULTS
			: model.api === "openai-responses" || model.api === "openai-codex-responses"
				? OPENAI_RESPONSES_DEFAULTS
				: {};
	const existing = (model.compat ?? {}) as Record<string, unknown>;
	const base = existing && generatedCompatBases.get(existing) ? generatedCompatBases.get(existing) : existing;
	const allowed =
		model.api === "openai-completions"
			? new Set(
					Object.keys(OPENAI_COMPLETIONS_DEFAULTS).concat([
						"requiresToolResultName",
						"requiresAssistantAfterToolResult",
						"requiresThinkingAsText",
						"requiresReasoningContentOnAssistantMessages",
						"thinkingFormat",
						"chatTemplateKwargs",
						"chatTemplateArgs",
						"openRouterRouting",
						"vercelGatewayRouting",
						"zaiToolStream",
						"supportsThinkingTokenBudget",
						"cacheControlFormat",
						"sendSessionAffinityHeaders",
						"deferredToolsMode",
						"sessionAffinityFormat",
					]),
				)
			: new Set(
					Object.keys(OPENAI_RESPONSES_DEFAULTS).concat([
						"sessionAffinityFormat",
						"supportsAdditionalTools",
						"supportsToolSearch",
						"supportsExplicitPromptCacheMode",
					]),
				);
	const selected = Object.fromEntries(Object.entries(registration.compat ?? {}).filter(([key]) => allowed.has(key)));
	const compat: Record<string, unknown> = { ...defaults, ...(base ?? {}), ...selected };
	const keys = new Set([...Object.keys(existing), ...Object.keys(compat)]);
	const unchanged = [...keys].every((key) => (existing?.[key] ?? undefined) === (compat[key] ?? undefined));
	if (unchanged) return model;
	generatedCompatBases.set(compat, { ...(base ?? {}) });
	return { ...model, compat } as Model<Api>;
}
