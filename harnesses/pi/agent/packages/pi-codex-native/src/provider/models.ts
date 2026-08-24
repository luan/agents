import type { Model, ModelCost } from "@earendil-works/pi-ai";

type CodexResponsesModel = Model<"openai-codex-responses">;
type CodexResponsesCompat = NonNullable<CodexResponsesModel["compat"]> & {
	supportsImageDetailOriginal?: boolean;
};
export type CodexModel = Omit<CodexResponsesModel, "compat"> & { compat?: CodexResponsesCompat };

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const LARGE_CONTEXT_WINDOW = 272_000;
const MAX_OUTPUT_TOKENS = 128_000;

function codexModel(input: {
	id: string;
	name: string;
	input: CodexModel["input"];
	cost: ModelCost;
	contextWindow?: number;
	thinkingLevelMap?: CodexModel["thinkingLevelMap"];
	additionalTools?: boolean;
	toolSearch?: boolean;
	imageDetailOriginal?: boolean;
}): CodexModel {
	return {
		id: input.id,
		name: input.name,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: CODEX_BASE_URL,
		reasoning: true,
		input: input.input,
		cost: input.cost,
		contextWindow: input.contextWindow ?? LARGE_CONTEXT_WINDOW,
		maxTokens: MAX_OUTPUT_TOKENS,
		thinkingLevelMap: input.thinkingLevelMap ?? { xhigh: "xhigh", minimal: "low" },
		compat: {
			supportsOpenAIGrammarTools: true,
			...(input.additionalTools ? { supportsAdditionalTools: true } : {}),
			...(input.toolSearch ? { supportsToolSearch: true } : {}),
			...(input.imageDetailOriginal ? { supportsImageDetailOriginal: true } : {}),
		},
	};
}

const CODEX_MODELS: readonly CodexModel[] = [
	codexModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		input: ["text"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 128_000,
	}),
	codexModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		input: ["text", "image"],
		cost: {
			input: 2.5,
			output: 15,
			cacheRead: 0.25,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
		},
		toolSearch: true,
		imageDetailOriginal: true,
	}),
	codexModel({
		id: "gpt-5.4-mini",
		name: "GPT-5.4 mini",
		input: ["text", "image"],
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		toolSearch: true,
		imageDetailOriginal: true,
	}),
	codexModel({
		id: "gpt-5.5",
		name: "GPT-5.5",
		input: ["text", "image"],
		cost: {
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }],
		},
		toolSearch: true,
		imageDetailOriginal: true,
	}),
	codexModel({
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		input: ["text", "image"],
		cost: {
			input: 0.2,
			output: 1.2,
			cacheRead: 0.02,
			cacheWrite: 0.25,
			tiers: [{ inputTokensAbove: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }],
		},
		thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
		additionalTools: true,
		toolSearch: true,
		imageDetailOriginal: true,
	}),
	codexModel({
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		input: ["text", "image"],
		cost: {
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
			tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
		},
		thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
		additionalTools: true,
		toolSearch: true,
		imageDetailOriginal: true,
	}),
	codexModel({
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		input: ["text", "image"],
		cost: {
			input: 2,
			output: 12,
			cacheRead: 0.2,
			cacheWrite: 2.5,
			tiers: [{ inputTokensAbove: 272_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }],
		},
		thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
		additionalTools: true,
		toolSearch: true,
		imageDetailOriginal: true,
	}),
];

export function getCodexModels(): readonly CodexModel[] {
	return CODEX_MODELS.map((model) => ({
		...model,
		input: [...model.input],
		cost: {
			...model.cost,
			...(model.cost.tiers ? { tiers: model.cost.tiers.map((tier) => ({ ...tier })) } : {}),
		},
		...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
		...(model.compat ? { compat: { ...model.compat } } : {}),
	}));
}
