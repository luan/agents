export const SYSTEM_PROMPT_PAYLOAD_ADAPTERS_KEY = "pi-developer-messages/provider-payload-adapters/v1";
export const SYSTEM_PROMPT_PAYLOAD_ADAPTERS = Symbol.for(SYSTEM_PROMPT_PAYLOAD_ADAPTERS_KEY);

export interface ProviderDeveloperMessage {
	id: string;
	content: string;
}

export interface SystemPromptPayloadAdapter {
	provider: string;
	api?: string | string[];
	model?: string | ((id: string) => boolean);
	enabled?: (provider: string, api: string | undefined, model: string | undefined) => boolean;
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

let adapterSequence = 0;

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
	const modelKey = typeof adapter.model === "string" ? adapter.model : adapter.model ? "<predicate>" : undefined;
	const key = `${adapter.provider}:${Array.isArray(adapter.api) ? adapter.api.join(",") : (adapter.api ?? "*")}${modelKey ? `:${modelKey}` : ""}:${++adapterSequence}`;
	registry.set(key, adapter);
	return () => {
		if (registry.get(key) === adapter) registry.delete(key);
	};
}

export function findSystemPromptPayloadAdapter(
	provider: string | undefined,
	api: string | undefined,
	model: string | undefined = undefined,
): SystemPromptPayloadAdapter | undefined {
	if (!provider) return undefined;
	return [...getSystemPromptPayloadAdapterRegistry().values()]
		.map((adapter, index) => ({ adapter, index }))
		.filter(
			({ adapter }) =>
				adapter.provider === provider &&
				(!adapter.model ||
					(typeof adapter.model === "string"
						? adapter.model === model
						: model !== undefined && adapter.model(model))) &&
				(!adapter.api ||
					(api !== undefined && (Array.isArray(adapter.api) ? adapter.api.includes(api) : adapter.api === api))),
		)
		.sort((a, b) => {
			const apiSpecificity = (adapter: SystemPromptPayloadAdapter) => (adapter.api ? 1 : 0);
			const modelSpecificity = (adapter: SystemPromptPayloadAdapter) => (adapter.model ? 1 : 0);
			return (
				modelSpecificity(b.adapter) - modelSpecificity(a.adapter) ||
				apiSpecificity(b.adapter) - apiSpecificity(a.adapter) ||
				b.index - a.index
			);
		})
		.at(0)?.adapter;
}
