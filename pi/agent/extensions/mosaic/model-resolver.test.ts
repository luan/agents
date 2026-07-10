import { describe, expect, test } from "bun:test";
import { resolveDefaultModel } from "./model-resolver";

const parentModel = { provider: "openai", id: "gpt-5", name: "GPT-5" };
const haikuModel = {
	provider: "anthropic",
	id: "claude-haiku-4-5-20251001",
	name: "Claude Haiku 4.5",
};

function registry(available: Array<{ provider: string; id: string; name: string }>) {
	return {
		find(provider: string, modelId: string) {
			return [parentModel, haikuModel].find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return [parentModel, haikuModel];
		},
		getAvailable() {
			return available;
		},
	};
}

describe("resolveDefaultModel", () => {
	test("uses configured agent model when it is available", () => {
		expect(
			resolveDefaultModel(parentModel, registry([parentModel, haikuModel]), "anthropic/claude-haiku-4-5-20251001"),
		).toBe(haikuModel);
	});

	test("falls back to the parent session model when configured model is unavailable", () => {
		expect(resolveDefaultModel(parentModel, registry([parentModel]), "anthropic/claude-haiku-4-5-20251001")).toBe(
			parentModel,
		);
	});
});
