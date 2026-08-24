import type { NativeCompactionRequestBody, ResponsesInputItem } from "./serializer.ts";

export const COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE = "Output exceeded the available model context and was truncated";
const CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

export type NativeCompactionShrinkResult = {
	request: NativeCompactionRequestBody;
	rewrittenOutputs: number;
};

export type ShrinkNativeCompactionRequestOptions = {
	budgetTokens?: number | null;
	tokensBefore: number;
};

export type NativeCompactionBudgetOptions = {
	contextWindow?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function estimateTokenCount(value: unknown): number {
	const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	return Math.ceil(Buffer.byteLength(serialized, "utf8") / 4);
}

function rewriteToolOutputItem(item: ResponsesInputItem): { recognized: boolean; item: ResponsesInputItem } {
	if (!isRecord(item)) return { recognized: false, item };
	const candidate = item as Record<string, unknown>;
	if (candidate.type === "function_call_output" || candidate.type === "custom_tool_call_output") {
		if (candidate.output === COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE) return { recognized: true, item };
		return {
			recognized: true,
			item: { ...candidate, output: COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE } as ResponsesInputItem,
		};
	}
	if (candidate.type === "tool_search_output") {
		if (Array.isArray(candidate.tools) && candidate.tools.length === 0) return { recognized: true, item };
		return { recognized: true, item: { ...candidate, tools: [] } as unknown as ResponsesInputItem };
	}
	return { recognized: false, item };
}

export function resolveNativeCompactionRequestBudget(options: NativeCompactionBudgetOptions): number | undefined {
	const contextWindow = options.contextWindow;
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	return Math.floor((contextWindow * CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100);
}

export async function shrinkNativeCompactionRequestForEndpoint(
	request: NativeCompactionRequestBody,
	options: ShrinkNativeCompactionRequestOptions,
): Promise<NativeCompactionShrinkResult> {
	const budgetTokens = options.budgetTokens;
	if (
		typeof budgetTokens !== "number" ||
		!Number.isFinite(budgetTokens) ||
		budgetTokens <= 0 ||
		!Number.isFinite(options.tokensBefore) ||
		options.tokensBefore <= budgetTokens
	) {
		return { request, rewrittenOutputs: 0 };
	}
	const estimateRequest = (input: readonly ResponsesInputItem[]) =>
		estimateTokenCount(request.instructions) + estimateTokenCount(input);
	let estimatedTokens = estimateRequest(request.input);
	if (estimatedTokens <= budgetTokens) return { request, rewrittenOutputs: 0 };
	let rewrittenOutputs = 0;
	let input: ResponsesInputItem[] | undefined;
	for (let index = request.input.length - 1; index >= 0 && estimatedTokens > budgetTokens; index--) {
		const item = (input ?? request.input)[index]!;
		const rewrite = rewriteToolOutputItem(item);
		if (!rewrite.recognized) break;
		if (rewrite.item === item) continue;
		input ??= [...request.input];
		input[index] = rewrite.item;
		rewrittenOutputs++;
		estimatedTokens += estimateTokenCount(rewrite.item) - estimateTokenCount(item);
	}
	return { request: input ? { ...request, input } : request, rewrittenOutputs };
}
