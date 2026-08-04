import { expect, test } from "bun:test";
import { parseAgentMarkdown } from "./custom-agents";
import { DEFAULT_MODEL_CATEGORIES, resolveModelCategory } from "./model-categories";

test("resolves a category model and thinking level", () => {
	const model = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
	const registry = {
		getAvailable: () => [model],
		getAll: () => [model],
		find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
	};

	expect(resolveModelCategory("smart", registry, DEFAULT_MODEL_CATEGORIES)).toEqual({
		model,
		thinking: "high",
	});
});

test("custom agents select a model category", () => {
	const agent = parseAgentMarkdown(
		"worker",
		"---\nmodel_category: smol\nextensions: false\nskills: false\n---\nDo the work.",
		"project",
	);

	expect(agent.modelCategory).toBe("smol");
});
