import { parse as partialParse } from "partial-json";
import { calculateCost, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendGrammarToolInputJsonDelta, type GrammarToolInputJsonBuffer } from "../constrained-sampling.ts";
import { NonRetryableProviderError } from "../provider/errors.ts";
import { encodeTextSignatureV1 } from "./signatures.ts";
import { sanitizeWebSearchCallItem, type WebSearchCallBlock } from "./native-items.ts";
import type { OpenAIResponsesStreamOptions } from "./shared.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type ResponseServiceTier = "auto" | "default" | "flex" | "priority";
type CustomToolCallItem = {
	type: "custom_tool_call";
	id?: string;
	call_id: string;
	name: string;
	input?: string;
	namespace?: string;
};
type ReasoningItem = {
	type: "reasoning";
	summary?: Array<{ text?: string }>;
};
type MessageItem = {
	type: "message";
	id: string;
	phase?: string | null;
	content: Array<{ type?: string; text?: string; refusal?: string }>;
};
type FunctionCallItem = {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	arguments: string;
	namespace?: string;
};
type WebSearchItem = { type: "web_search_call"; [key: string]: JsonValue };
type ResponseOutputItem = CustomToolCallItem | ReasoningItem | MessageItem | FunctionCallItem | WebSearchItem;
type ResponseUsage = {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	output_tokens_details?: { reasoning_tokens?: number };
};
type ResponseResult = {
	id?: string;
	status?: string;
	service_tier?: ResponseServiceTier;
	usage?: ResponseUsage;
	incomplete_details?: { reason?: string } | null;
	error?: { code?: string; message?: string };
};
type ResponseStreamEvent =
	| { type: "response.custom_tool_call_input.delta"; output_index: number; delta: string }
	| { type: "response.custom_tool_call_input.done"; output_index: number; input: string }
	| { type: "response.created"; response: { id: string } }
	| { type: "response.output_item.added" | "response.output_item.done"; output_index: number; item: ResponseOutputItem }
	| {
			type: "response.reasoning_summary_part.added" | "response.reasoning_summary_part.done";
			output_index: number;
			summary_index: number;
			part: { text: string };
	  }
	| { type: "response.reasoning_summary_text.delta"; output_index: number; summary_index: number; delta: string }
	| {
			type: "response.content_part.added";
			output_index: number;
			content_index: number;
			part: { type: "output_text"; text: string } | { type: "refusal"; refusal: string };
	  }
	| {
			type: "response.output_text.delta" | "response.refusal.delta";
			output_index: number;
			content_index: number;
			delta: string;
	  }
	| { type: "response.function_call_arguments.delta"; output_index: number; delta: string }
	| { type: "response.function_call_arguments.done"; output_index: number; arguments: string }
	| { type: "response.completed" | "response.incomplete" | "response.failed"; response: ResponseResult }
	| { type: "error"; code?: string; message?: string };

type InternalAssistantContent = AssistantMessage["content"][number] | WebSearchCallBlock;

function parseStreamingJson(partialJson: string): JsonObject {
	try {
		const parsed = partialParse(partialJson) as JsonValue;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function parseFinalArguments(argumentsJson: string): JsonObject {
	try {
		const parsed: JsonValue = JSON.parse(argumentsJson);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {
		// A completed call must not execute a repaired partial argument object.
	}
	throw new NonRetryableProviderError("Invalid function call arguments: expected a complete JSON object");
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	const blocks = output.content;
	type ThinkingBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
	type TextBlock = Extract<AssistantMessage["content"][number], { type: "text" }>;
	type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

	type ReasoningState = {
		kind: "reasoning";
		blockIndex: number;
		block: ThinkingBlock;
		summaryParts: Map<number, { text: string }>;
	};
	type MessageState = {
		kind: "message";
		blockIndex: number;
		block: TextBlock;
		parts: Map<number, { type: "output_text" | "refusal"; text: string }>;
	};
	type FunctionCallState = {
		kind: "function_call";
		blockIndex: number;
		block: ToolCallBlock;
		partialJson: string;
	};
	type CustomToolCallState = {
		kind: "custom_tool_call";
		blockIndex: number;
		block: ToolCallBlock;
		input: string;
		property: string;
		jsonBuffer: GrammarToolInputJsonBuffer;
	};
	type OutputState = ReasoningState | MessageState | FunctionCallState | CustomToolCallState;

	const outputStates = new Map<number, OutputState>();
	const appendCustomInput = (state: CustomToolCallState, nextInput: string, close: boolean): string | undefined => {
		const delta = appendGrammarToolInputJsonDelta(state.jsonBuffer, state.property, nextInput, close);
		state.input = nextInput;
		state.block.arguments = { [state.property]: nextInput };
		return delta;
	};

	const renderParts = (parts: ReadonlyMap<number, { text: string }>, separator: string): string =>
		Array.from(parts.entries())
			.sort(([a], [b]) => a - b)
			.map(([, part]) => part.text)
			.join(separator);

	const startOutputItem = (outputIndex: number, item: ResponseOutputItem): void => {
		let state: OutputState;
		const blockIndex = blocks.length;
		if (item.type === "reasoning") {
			state = { kind: item.type, blockIndex, block: { type: "thinking", thinking: "" }, summaryParts: new Map() };
		} else if (item.type === "message") {
			state = { kind: item.type, blockIndex, block: { type: "text", text: "" }, parts: new Map() };
		} else if (item.type === "function_call" || item.type === "custom_tool_call") {
			const block: ToolCallBlock = {
				type: "toolCall",
				id: `${item.call_id}|${item.id ?? ""}`,
				name: item.name,
				arguments: {},
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
			};
			if (item.type === "function_call") {
				state = { kind: item.type, blockIndex, block, partialJson: item.arguments || "" };
			} else {
				const property = options?.grammarToolInputProperties?.get(item.name) ?? "input";
				const input = item.input ?? "";
				block.arguments = { [property]: input };
				state = {
					kind: item.type,
					blockIndex,
					block,
					input,
					property,
					jsonBuffer: { input: "", started: false, closed: false },
				};
			}
		} else return;
		blocks.push(state.block);
		outputStates.set(outputIndex, state);
		stream.push({
			type: state.kind === "reasoning" ? "thinking_start" : state.kind === "message" ? "text_start" : "toolcall_start",
			contentIndex: blockIndex,
			partial: output,
		});
	};

	const emitAppendedDelta = (
		eventType: "thinking_delta" | "text_delta" | "toolcall_delta",
		contentIndex: number,
		previous: string,
		next: string,
	) => {
		if (next.startsWith(previous)) {
			const delta = next.slice(previous.length);
			if (delta.length > 0) {
				stream.push({ type: eventType, contentIndex, delta, partial: output });
			}
		}
	};

	const cleanedStream = (async function* () {
		try {
			yield* openaiStream;
		} finally {
			const incompleteToolCallIndexes = [...outputStates.values()]
				.filter((state) => state.kind === "function_call" || state.kind === "custom_tool_call")
				.map((state) => state.blockIndex)
				.sort((left, right) => right - left);
			for (const index of incompleteToolCallIndexes) output.content.splice(index, 1);
		}
	})();

	for await (const event of cleanedStream) {
		if (
			event.type === "response.custom_tool_call_input.delta" ||
			event.type === "response.custom_tool_call_input.done"
		) {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "custom_tool_call") {
				const done = event.type === "response.custom_tool_call_input.done";
				const delta = appendCustomInput(state, done ? event.input : state.input + event.delta, done);
				if (delta !== undefined)
					stream.push({ type: "toolcall_delta", contentIndex: state.blockIndex, delta, partial: output });
			}
			continue;
		}
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			startOutputItem(event.output_index, event.item);
		} else if (event.type === "response.reasoning_summary_part.added") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "reasoning") {
				state.summaryParts.set(event.summary_index, { text: event.part.text });
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "reasoning") {
				const summaryPart = state.summaryParts.get(event.summary_index) ?? { text: "" };
				summaryPart.text += event.delta;
				state.summaryParts.set(event.summary_index, summaryPart);
				const previousThinking = state.block.thinking;
				const nextThinking = renderParts(state.summaryParts, "\n\n");
				state.block.thinking = nextThinking;
				emitAppendedDelta("thinking_delta", state.blockIndex, previousThinking, nextThinking);
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "reasoning") {
				state.summaryParts.set(event.summary_index, { text: event.part.text });
				state.block.thinking = renderParts(state.summaryParts, "\n\n");
			}
		} else if (event.type === "response.content_part.added") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "message" && (event.part.type === "output_text" || event.part.type === "refusal")) {
				state.parts.set(event.content_index, {
					type: event.part.type,
					text: event.part.type === "output_text" ? event.part.text : event.part.refusal,
				});
			}
		} else if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "message") {
				const type = event.type === "response.output_text.delta" ? "output_text" : "refusal";
				const part = state.parts.get(event.content_index) ?? { type, text: "" };
				if (part.type === type) {
					part.text += event.delta;
					state.parts.set(event.content_index, part);
					const previous = state.block.text;
					state.block.text = renderParts(state.parts, "");
					emitAppendedDelta("text_delta", state.blockIndex, previous, state.block.text);
				}
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "function_call") {
				state.partialJson = state.partialJson + event.delta;
				state.block.arguments = parseStreamingJson(state.partialJson);
				stream.push({ type: "toolcall_delta", contentIndex: state.blockIndex, delta: event.delta, partial: output });
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "function_call") {
				const previousPartialJson = state.partialJson;
				state.partialJson = event.arguments;
				state.block.arguments = parseStreamingJson(state.partialJson);
				emitAppendedDelta("toolcall_delta", state.blockIndex, previousPartialJson, event.arguments);
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			const previousState = outputStates.get(event.output_index);
			if (previousState?.kind !== item.type) startOutputItem(event.output_index, item);
			const state = outputStates.get(event.output_index);
			if (item.type === "custom_tool_call" && state?.kind === "custom_tool_call") {
				const input = item.input ?? state.input;
				if (previousState?.kind === "custom_tool_call") {
					const delta = appendCustomInput(state, input, true);
					if (delta !== undefined)
						stream.push({ type: "toolcall_delta", contentIndex: state.blockIndex, delta, partial: output });
				}
				state.block.arguments = { [state.property]: input };
				if (item.namespace !== undefined) state.block.namespace = item.namespace;
				stream.push({ type: "toolcall_end", contentIndex: state.blockIndex, toolCall: state.block, partial: output });
				options?.onOutputItemDone?.({ ...item, input });
			} else if (item.type === "reasoning" && state?.kind === "reasoning") {
				state.block.thinking = item.summary?.map((summary) => summary.text ?? "").join("\n\n") ?? "";
				state.block.thinkingSignature = JSON.stringify(item);
				stream.push({
					type: "thinking_end",
					contentIndex: state.blockIndex,
					content: state.block.thinking,
					partial: output,
				});
			} else if (item.type === "message" && state?.kind === "message") {
				state.block.text = item.content
					.map((content) => (content.type === "output_text" ? (content.text ?? "") : (content.refusal ?? "")))
					.join("");
				state.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({ type: "text_end", contentIndex: state.blockIndex, content: state.block.text, partial: output });
			} else if (item.type === "function_call" && state?.kind === "function_call") {
				state.block.arguments = parseFinalArguments(item.arguments);
				if (item.namespace !== undefined) state.block.namespace = item.namespace;
				stream.push({ type: "toolcall_end", contentIndex: state.blockIndex, toolCall: state.block, partial: output });
			} else if (item.type === "web_search_call") {
				const webSearchCall = sanitizeWebSearchCallItem(item);
				if (webSearchCall)
					(output.content as InternalAssistantContent[]).push({ type: "web_search_call", item: webSearchCall });
			}
			if (item.type !== "custom_tool_call") options?.onOutputItemDone?.(item);
			outputStates.delete(event.output_index);
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			const response = event.response;
			if (response?.id) output.responseId = response.id;
			if (response?.usage) {
				const inputDetails = response.usage.input_tokens_details;
				const cachedTokens = inputDetails?.cached_tokens || 0;
				const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
				output.usage = {
					input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
					output: response.usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: cacheWriteTokens,
					totalTokens: response.usage.total_tokens || 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				(output.usage as { reasoning?: number }).reasoning =
					response.usage.output_tokens_details?.reasoning_tokens || 0;
			}
			calculateCost(model, output.usage);
			if (options?.applyServiceTierPricing) {
				const serviceTier = options.resolveServiceTier
					? options.resolveServiceTier(response?.service_tier, options.serviceTier)
					: (response?.service_tier ?? options.serviceTier);
				options.applyServiceTierPricing(output.usage, serviceTier);
			}
			const incompleteReason = response?.incomplete_details?.reason;
			const rawStopReason = incompleteReason ? `${response?.status}.${incompleteReason}` : response?.status;
			if (rawStopReason !== undefined) output.rawStopReason = rawStopReason;
			const mappedStop = mapStopReason(response?.status, incompleteReason);
			output.stopReason = mappedStop.stopReason;
			if (mappedStop.errorMessage !== undefined) output.errorMessage = mappedStop.errorMessage;
			if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
		} else if (event.type === "error") {
			const details = [event.code, event.message].filter(Boolean).join(": ");
			throw new Error(details || "Unknown error");
		} else if (event.type === "response.failed") {
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
}

function mapStopReason(
	status: string | undefined,
	incompleteReason?: string,
): { stopReason: AssistantMessage["stopReason"]; errorMessage?: string } {
	if (!status) return { stopReason: "pending" };
	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			if (incompleteReason === "max_output_tokens") return { stopReason: "length" };
			return {
				stopReason: "error",
				errorMessage: incompleteReason
					? `Response incomplete: ${incompleteReason}`
					: "Response incomplete without a provider reason",
			};
		case "failed":
		case "cancelled":
			return { stopReason: "error" };
		case "in_progress":
		case "queued":
			return { stopReason: "pending" };
		default:
			throw new Error(`Unhandled stop reason: ${status}`);
	}
}
