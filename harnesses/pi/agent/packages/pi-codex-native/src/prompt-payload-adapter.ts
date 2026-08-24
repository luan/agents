const PAYLOAD_ADAPTERS_KEY = Symbol.for("pi-developer-prompt/provider-payload-adapters/v1");
const CODEX_PROVIDER = "openai-codex";
const MANAGED_DEVELOPER_MESSAGE_START = '<pi_developer_prompt_message id="';
const MANAGED_DEVELOPER_MESSAGE_END = "</pi_developer_prompt_message>";
const LEGACY_DEVELOPER_MESSAGE_START = '<pi_system_prompt_developer_message id="';
const LEGACY_DEVELOPER_MESSAGE_END = "</pi_system_prompt_developer_message>";
const PAYLOAD_ADAPTER_PROTOCOL = "pi-developer-prompt/provider-payload-adapters/v1" as const;

interface SystemPromptPayloadAdapter {
	provider: string;
	readSystemPrompt(payload: unknown): string | undefined;
	replaceSystemPrompt(payload: unknown, systemPrompt: string): unknown;
	replaceDeveloperMessages(payload: unknown, messages: readonly DeveloperMessage[]): unknown;
}

interface DeveloperMessage {
	id: string;
	content: string;
}

interface PayloadAdapterRegistry extends Map<string, SystemPromptPayloadAdapter> {
	protocol: typeof PAYLOAD_ADAPTER_PROTOCOL;
	version: 1;
}

function payloadAdapterRegistry(host: typeof globalThis = globalThis): PayloadAdapterRegistry {
	const slots = host as typeof globalThis & Record<symbol, unknown>;
	const current = slots[PAYLOAD_ADAPTERS_KEY];
	if (isRegistry(current)) return current;

	const registry = Object.assign(new Map<string, SystemPromptPayloadAdapter>(), {
		protocol: PAYLOAD_ADAPTER_PROTOCOL,
		version: 1 as const,
	}) as PayloadAdapterRegistry;
	slots[PAYLOAD_ADAPTERS_KEY] = registry;
	return registry;
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator avoids instanceof Map.
function isRegistry(value: unknown): value is PayloadAdapterRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PayloadAdapterRegistry>;
	return (
		candidate.protocol === PAYLOAD_ADAPTER_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.get === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.delete === "function" &&
		typeof candidate.values === "function"
	);
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
	return payload !== null && typeof payload === "object" && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: undefined;
}

export function registerCodexPromptPayloadAdapter(
	registry: PayloadAdapterRegistry = payloadAdapterRegistry(),
): () => void {
	const adapter: SystemPromptPayloadAdapter = {
		provider: CODEX_PROVIDER,
		readSystemPrompt(payload) {
			const instructions = payloadRecord(payload)?.instructions;
			return typeof instructions === "string" ? instructions : undefined;
		},
		replaceSystemPrompt(payload, systemPrompt) {
			const record = payloadRecord(payload);
			return record ? { ...record, instructions: systemPrompt } : payload;
		},
		replaceDeveloperMessages(payload, messages) {
			const record = payloadRecord(payload);
			if (!record || !Array.isArray(record.input)) return payload;
			const input = record.input.filter((item) => {
				const itemRecord = payloadRecord(item);
				return (
					itemRecord?.role !== "developer" ||
					typeof itemRecord.content !== "string" ||
					!isManagedDeveloperMessage(itemRecord.content)
				);
			});
			return {
				...record,
				input: [
					...messages.map((message) => ({ role: "developer", content: serializeDeveloperMessage(message) })),
					...input,
				],
			};
		},
	};
	registry.set(CODEX_PROVIDER, adapter);
	return () => {
		if (registry.get(CODEX_PROVIDER) === adapter) registry.delete(CODEX_PROVIDER);
	};
}

export function serializeDeveloperMessage(message: DeveloperMessage): string {
	return `${MANAGED_DEVELOPER_MESSAGE_START}${escapeXmlAttribute(message.id)}">\n${message.content}\n${MANAGED_DEVELOPER_MESSAGE_END}`;
}

function isManagedDeveloperMessage(content: string): boolean {
	return (
		(content.startsWith(MANAGED_DEVELOPER_MESSAGE_START) && content.endsWith(MANAGED_DEVELOPER_MESSAGE_END)) ||
		(content.startsWith(LEGACY_DEVELOPER_MESSAGE_START) && content.endsWith(LEGACY_DEVELOPER_MESSAGE_END))
	);
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/\"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
