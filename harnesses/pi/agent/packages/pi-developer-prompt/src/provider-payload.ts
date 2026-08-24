export const SYSTEM_PROMPT_PAYLOAD_ADAPTERS_KEY = "pi-developer-prompt/provider-payload-adapters/v1";
export const SYSTEM_PROMPT_PAYLOAD_ADAPTERS = Symbol.for(SYSTEM_PROMPT_PAYLOAD_ADAPTERS_KEY);

export interface ProviderDeveloperMessage {
	id: string;
	content: string;
}

export interface SystemPromptPayloadAdapter {
	provider: string;
	readSystemPrompt(payload: unknown): string | undefined;
	replaceSystemPrompt(payload: unknown, systemPrompt: string): unknown;
	replaceDeveloperMessages?(payload: unknown, messages: readonly ProviderDeveloperMessage[]): unknown;
}

export interface SystemPromptPayloadAdapterRegistry extends Map<string, SystemPromptPayloadAdapter> {
	readonly protocol: typeof SYSTEM_PROMPT_PAYLOAD_ADAPTERS_KEY;
	readonly version: 1;
}

type PayloadAdapterGlobal = typeof globalThis & {
	[SYSTEM_PROMPT_PAYLOAD_ADAPTERS]?: SystemPromptPayloadAdapterRegistry;
};

export function getSystemPromptPayloadAdapterRegistry(): SystemPromptPayloadAdapterRegistry {
	const root = globalThis as PayloadAdapterGlobal;
	const existing = root[SYSTEM_PROMPT_PAYLOAD_ADAPTERS];
	if (isRegistry(existing)) return existing;
	const registry = Object.assign(new Map<string, SystemPromptPayloadAdapter>(), {
		protocol: SYSTEM_PROMPT_PAYLOAD_ADAPTERS_KEY,
		version: 1 as const,
	}) as SystemPromptPayloadAdapterRegistry;
	root[SYSTEM_PROMPT_PAYLOAD_ADAPTERS] = registry;
	return registry;
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator avoids instanceof Map.
function isRegistry(value: unknown): value is SystemPromptPayloadAdapterRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SystemPromptPayloadAdapterRegistry>;
	return (
		candidate.protocol === SYSTEM_PROMPT_PAYLOAD_ADAPTERS_KEY &&
		candidate.version === 1 &&
		typeof candidate.get === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.delete === "function" &&
		typeof candidate.values === "function" &&
		typeof candidate.clear === "function"
	);
}

export function registerSystemPromptPayloadAdapter(adapter: SystemPromptPayloadAdapter): () => void {
	if (!adapter.provider.trim()) throw new Error("A system prompt payload adapter needs a provider");
	const registry = getSystemPromptPayloadAdapterRegistry();
	registry.set(adapter.provider, adapter);
	return () => {
		if (registry.get(adapter.provider) === adapter) registry.delete(adapter.provider);
	};
}
