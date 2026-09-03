import type { Api, Context, Model, Tool, Usage } from "@earendil-works/pi-ai";

type ResponseInput = Record<string, unknown>[];
type ResponseInputItem = Record<string, unknown>;
type ResponseToolSearchOutputItemParam = Record<string, unknown>;
type OpenAITool = Record<string, unknown>;
type ServiceTier = "auto" | "default" | "flex" | "priority";

import {
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "../constrained-sampling.ts";
import { normalizeResponsesMessageHistory } from "./message-history.ts";
import {
	type ImageDetail,
	imageDetailForResponses,
	isWebSearchCallBlock,
	sanitizeWebSearchCallItem,
	type WebSearchCallBlock,
} from "./native-items.ts";
import { parseTextSignature, shortHash } from "./signatures.ts";
import { normalizeResponsesToolHistory } from "./tool-history.ts";

type Message = Context["messages"][number];

type InternalAssistantContent = Extract<Message, { role: "assistant" }>["content"][number] | WebSearchCallBlock;
type ImageContentWithDetail = { type: "image"; data: string; mimeType: string; detail?: ImageDetail | undefined };
type AudioContent = { type: "audio"; data: string; mimeType: string };
type ToolResultContent = Extract<Message, { role: "toolResult" }>["content"][number] | AudioContent;

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ServiceTier | undefined;
	grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
	resolveServiceTier?: (
		responseServiceTier: ServiceTier | undefined,
		requestServiceTier: ServiceTier | undefined,
	) => ServiceTier | undefined;
	applyServiceTierPricing?: (usage: Usage, serviceTier: ServiceTier | undefined) => void;
	onOutputItemDone?: (item: unknown) => void;
}

interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean | undefined;
	grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
	deferredTools?: ReadonlyMap<string, Tool> | undefined;
	deferredToolsMode?: "additional-tools" | "tool-search" | undefined;
	toolOptions?: ConvertResponsesToolsOptions | undefined;
}

interface ConvertResponsesToolsOptions {
	strict?: boolean | null | undefined;
	supportsStrictMode?: boolean | undefined;
	supportsOpenAIGrammarTools?: boolean | undefined;
	deferLoading?: boolean | undefined;
}

export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export function splitDeferredTools(
	context: Context,
	enabled: boolean,
): { immediate: Tool[]; deferred: Map<string, Tool> } {
	const uniqueTools = new Map<string, Tool>();
	for (const tool of context.tools ?? []) uniqueTools.set(tool.name, tool);
	if (!enabled) return { immediate: [...uniqueTools.values()], deferred: new Map() };

	const deferredNames = new Set<string>();
	const usedNames = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") usedNames.add(block.name);
			}
		} else if (message.role === "toolResult") {
			for (const name of message.addedToolNames ?? []) {
				if (!usedNames.has(name)) deferredNames.add(name);
			}
		}
	}

	const immediate: Tool[] = [];
	const deferred = new Map<string, Tool>();
	for (const [name, tool] of uniqueTools) {
		if (deferredNames.has(name)) deferred.set(name, tool);
		else immediate.push(tool);
	}
	return { immediate, deferred };
}

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function storedCustomToolInputProperty(toolName: string, arguments_: Record<string, unknown>): string {
	// Pi's public ToolInfo omits constrained sampling, so resumed sessions recover
	// the grammar input property from the provider-issued ctc item and its arguments.
	const stringProperties = Object.entries(arguments_).filter((entry): entry is [string, string] => {
		return typeof entry[1] === "string";
	});
	if (stringProperties.length === 1) return stringProperties[0]![0];
	throw new Error(`Stored custom tool call "${toolName}" does not have exactly one string input property.`);
}

function parseResponsesThinkingSignature(signature: string): ResponseInput[number] | undefined {
	try {
		return JSON.parse(signature) as ResponseInput[number];
	} catch {
		return undefined;
	}
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const loadedToolNames = new Set<string>();
	const normalizeIdPart = (part: string) => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};
	const buildForeignResponsesItemId = (itemId: string) => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};
	const normalizeToolCallId = (
		id: string,
		_targetModel: Model<TApi>,
		source: Extract<Message, { role: "assistant" }>,
	) => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|") as [string, string | undefined];
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall
			? buildForeignResponsesItemId(itemId ?? "")
			: normalizeIdPart(itemId ?? "");
		if (!normalizedItemId.startsWith("fc_")) normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = normalizeResponsesMessageHistory(
		context.messages,
		model as Model<Api>,
		normalizeToolCallId as never,
	);
	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		messages.push({
			role: model.reasoning ? "developer" : "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }] });
			} else {
				const content = msg.content.map((item) =>
					item.type === "text"
						? { type: "input_text" as const, text: sanitizeSurrogates(item.text) }
						: {
								type: "input_image" as const,
								detail: imageDetailForResponses(item),
								image_url: `data:${item.mimeType};base64,${item.data}`,
							},
				);
				if (content.length > 0) messages.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const isSameProviderAndApi = msg.provider === model.provider && msg.api === model.api;
			const isSameModel = isSameProviderAndApi && msg.model === model.id;
			const isDifferentModel = isSameProviderAndApi && msg.model !== model.id;
			let textBlockIndex = 0;
			for (const block of msg.content as InternalAssistantContent[]) {
				if (isWebSearchCallBlock(block)) {
					const webSearchCall = sanitizeWebSearchCallItem(block.item);
					if (webSearchCall) output.push(webSearchCall as unknown as ResponseInput[number]);
				} else if (block.type === "thinking") {
					const thinkingItem = block.thinkingSignature
						? parseResponsesThinkingSignature(block.thinkingSignature)
						: undefined;
					if (thinkingItem) output.push(thinkingItem);
				} else if (block.type === "text") {
					const parsedSignature = parseTextSignature(block.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					let msgId = parsedSignature?.id ?? fallbackMessageId;
					if (msgId.length > 64) msgId = `msg_${shortHash(msgId)}`;
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
						status: "completed",
						id: msgId,
						...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
					});
				} else if (block.type === "toolCall") {
					const [callId, itemIdRaw] = block.id.split("|");
					const customInputProperty =
						options?.grammarToolInputProperties?.get(block.name) ??
						(itemIdRaw?.startsWith("ctc_") ? storedCustomToolInputProperty(block.name, block.arguments) : undefined);
					let itemId: string | undefined = itemIdRaw;
					if (customInputProperty !== undefined && itemId?.startsWith("fc_")) {
						itemId = `ctc_${itemId.slice(3)}`;
					}
					if (
						(isDifferentModel && itemId?.startsWith("fc_")) ||
						(customInputProperty === undefined && !itemId?.startsWith("fc_"))
					)
						itemId = undefined;
					const canReplayNamespace = isSameModel || options?.deferredTools?.has(block.name) === true;
					output.push(
						customInputProperty === undefined
							? ({
									type: "function_call",
									...(itemId ? { id: itemId } : {}),
									call_id: callId,
									name: block.name,
									arguments: JSON.stringify(block.arguments),
									...(canReplayNamespace && block.namespace !== undefined ? { namespace: block.namespace } : {}),
								} as ResponseInput[number])
							: ({
									type: "custom_tool_call",
									...(itemId ? { id: itemId } : {}),
									call_id: callId,
									name: block.name,
									input: sanitizeSurrogates(getGrammarToolInput(block.name, block.arguments, customInputProperty)),
									...(canReplayNamespace && block.namespace !== undefined ? { namespace: block.namespace } : {}),
								} as ResponseInput[number]),
					);
				}
			}
			if (output.length > 0) messages.push(...output);
		} else if (msg.role === "toolResult") {
			// type-boundary: Pi 0.84.2 omits audio from ToolResultMessage, but Code Mode can return it.
			const toolContent = msg.content as ToolResultContent[];
			const textResult = toolContent
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = toolContent.some((c) => c.type === "image");
			const hasAudio = toolContent.some((c) => c.type === "audio");
			const hasText = textResult.length > 0;
			const [callId, itemId] = msg.toolCallId.split("|");
			const output =
				hasAudio || (hasImages && model.input.includes("image"))
					? [
							...(hasText ? [{ type: "input_text" as const, text: sanitizeSurrogates(textResult) }] : []),
							...toolContent
								.filter((block): block is ImageContentWithDetail => block.type === "image")
								.map((block) => ({
									type: "input_image" as const,
									detail: imageDetailForResponses(block),
									image_url: `data:${block.mimeType};base64,${block.data}`,
								})),
							...toolContent
								.filter((block): block is AudioContent => block.type === "audio")
								.map((block) => ({
									type: "input_audio" as const,
									audio_url: `data:${block.mimeType};base64,${block.data}`,
								})),
						]
					: sanitizeSurrogates(hasText ? textResult : "(see attached image)");
			messages.push({
				type:
					options?.grammarToolInputProperties?.has(msg.toolName) || itemId?.startsWith("ctc_")
						? "custom_tool_call_output"
						: "function_call_output",
				call_id: callId!,
				output,
			} as ResponseInput[number]);

			const deferredTools: Tool[] = [];
			for (const name of msg.addedToolNames ?? []) {
				const tool = options?.deferredTools?.get(name);
				if (!tool || loadedToolNames.has(name)) continue;
				loadedToolNames.add(name);
				deferredTools.push(tool);
			}
			if (deferredTools.length > 0 && options?.deferredToolsMode === "additional-tools") {
				messages.push({
					type: "additional_tools",
					role: "developer",
					tools: convertResponsesTools(deferredTools, options.toolOptions),
				} as unknown as ResponseInputItem);
			} else if (deferredTools.length > 0 && options?.deferredToolsMode === "tool-search") {
				const names = deferredTools.map((tool) => tool.name);
				const searchCallId = `pi_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
				messages.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: { query: names.join(" "), limit: names.length },
				} satisfies ResponseInputItem);
				messages.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: convertResponsesTools(deferredTools, {
						...options.toolOptions,
						deferLoading: true,
					}),
				} satisfies ResponseToolSearchOutputItemParam);
			}
		}
		msgIndex++;
	}

	return normalizeResponsesToolHistory(messages) as ResponseInput;
}

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;
	return tools.map((tool): OpenAITool => {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar)
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					syntax: grammar.format,
					definition: grammar.definition,
				},
				...(options?.deferLoading ? { defer_loading: true } : {}),
			} as OpenAITool;
		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const strict = constrainedStrict ?? defaultStrict;
		const functionTool = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true) as unknown as Record<string, unknown>,
			...(options?.deferLoading ? { defer_loading: true } : {}),
		} as OpenAITool & { type: "function"; strict?: boolean };
		if (supportsStrictMode && strict !== null) functionTool.strict = strict;
		return functionTool;
	});
}

export { processResponsesStream } from "./stream.ts";
