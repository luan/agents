import { registerSystemPromptPayloadAdapter } from "@luan.sh/pi-developer-messages";
import { codexCompatibility } from "./compatibility.ts";

const CODEX_PROVIDER = "openai-codex";
const MANAGED_DEVELOPER_MESSAGE_START = '<pi_developer_prompt_message id="';
const MANAGED_DEVELOPER_MESSAGE_END = "</pi_developer_prompt_message>";
const LEGACY_DEVELOPER_MESSAGE_START = '<pi_system_prompt_developer_message id="';
const LEGACY_DEVELOPER_MESSAGE_END = "</pi_system_prompt_developer_message>";

interface SystemPromptPayloadAdapter {
	provider: string;
	api?: string | string[];
	model?: string | ((id: string) => boolean);
	enabled?: (provider: string, api: string | undefined, model: string | undefined) => boolean;
	readSystemPrompt(payload: unknown): string | undefined;
	replaceSystemPrompt(payload: unknown, systemPrompt: string): unknown;
	replaceDeveloperMessages(payload: unknown, messages: readonly DeveloperMessage[]): unknown;
}

interface DeveloperMessage {
	id: string;
	content: string;
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
	return payload !== null && typeof payload === "object" && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: undefined;
}

export function registerCodexPromptPayloadAdapter(): () => void {
	const adapter: SystemPromptPayloadAdapter = {
		provider: CODEX_PROVIDER,
		api: "openai-codex-responses",
		enabled(provider, api, model) {
			return (
				codexCompatibility(model === undefined ? undefined : ({ provider, api, id: model } as never))?.features
					.developerMessages !== false
			);
		},
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
	return registerSystemPromptPayloadAdapter(adapter);
}

function messageContent(item: unknown): string | undefined {
	const record = payloadRecord(item);
	return typeof record?.content === "string" ? record.content : undefined;
}

function replaceBasePrompt(items: unknown[], role: string, prompt: string): unknown[] {
	let replaced = false;
	return items.map((item) => {
		const record = payloadRecord(item);
		if (!replaced && record?.role === role && typeof record.content === "string") {
			replaced = true;
			return { ...record, content: prompt };
		}
		return item;
	});
}

function chatAdapter(provider: string): SystemPromptPayloadAdapter {
	return {
		provider,
		api: "openai-completions",
		readSystemPrompt(payload) {
			const messages = payloadRecord(payload)?.messages;
			if (!Array.isArray(messages)) return undefined;
			const system = messages.find((item) => {
				const role = payloadRecord(item)?.role;
				return role === "system" || role === "developer";
			});
			return messageContent(system);
		},
		replaceSystemPrompt(payload, systemPrompt) {
			const record = payloadRecord(payload);
			if (!record || !Array.isArray(record.messages)) return payload;
			const messages = replaceBasePrompt(record.messages, "system", systemPrompt);
			if (
				messages.some((item) => payloadRecord(item)?.role === "system" && payloadRecord(item)?.content === systemPrompt)
			)
				return { ...record, messages };
			return { ...record, messages: [{ role: "system", content: systemPrompt }, ...messages] };
		},
		replaceDeveloperMessages(payload, messages) {
			const record = payloadRecord(payload);
			if (!record || !Array.isArray(record.messages)) return payload;
			const retained = record.messages.filter((item) => {
				const itemRecord = payloadRecord(item);
				const content = messageContent(item);
				return itemRecord?.role !== "developer" || content === undefined || !isManagedDeveloperMessage(content);
			});
			return {
				...record,
				messages: [
					...messages.map((message) => ({ role: "developer", content: serializeDeveloperMessage(message) })),
					...retained,
				],
			};
		},
	};
}

function responsesAdapter(provider: string): SystemPromptPayloadAdapter {
	return {
		provider,
		api: "openai-responses",
		readSystemPrompt(payload) {
			const record = payloadRecord(payload);
			if (typeof record?.instructions === "string") return record.instructions;
			const system = Array.isArray(record?.input)
				? record.input.find((item) => {
						const role = payloadRecord(item)?.role;
						return role === "system" || role === "developer";
					})
				: undefined;
			return messageContent(system);
		},
		replaceSystemPrompt(payload, systemPrompt) {
			const record = payloadRecord(payload);
			if (!record) return payload;
			if ("instructions" in record) return { ...record, instructions: systemPrompt };
			if (!Array.isArray(record.input)) return payload;
			const input = replaceBasePrompt(record.input, "system", systemPrompt);
			if (input.some((item) => payloadRecord(item)?.role === "system" && payloadRecord(item)?.content === systemPrompt))
				return { ...record, input };
			return { ...record, input: [{ role: "system", content: systemPrompt }, ...input] };
		},
		replaceDeveloperMessages(payload, messages) {
			const record = payloadRecord(payload);
			if (!record || !Array.isArray(record.input)) return payload;
			const input = record.input.filter((item) => {
				const itemRecord = payloadRecord(item);
				const content = messageContent(item);
				return itemRecord?.role !== "developer" || content === undefined || !isManagedDeveloperMessage(content);
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
}

export function registerOpenAICompatiblePromptPayloadAdapters(
	provider: string,
	model?: string | ((id: string) => boolean),
	options: { enabled?: (provider: string, api: string | undefined, model: string | undefined) => boolean } = {},
): () => void {
	const unregisterChat = registerSystemPromptPayloadAdapter({
		...chatAdapter(provider),
		model,
		enabled: options.enabled,
	});
	const unregisterResponses = registerSystemPromptPayloadAdapter({
		...responsesAdapter(provider),
		model,
		enabled: options.enabled,
	});
	return () => {
		unregisterChat();
		unregisterResponses();
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
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
