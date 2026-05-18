import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MODEL_PRESETS,
	mergeModelPresets,
	orderedModelPresetNames,
	parseModelPresetCandidates,
	resolveModelPreset,
} from "./model-presets";

const gpt = { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" };
const sonnet = { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" };

function registry(available: Array<{ provider: string; id: string; name: string }>) {
	return {
		find(provider: string, modelId: string) {
			return [gpt, sonnet].find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return [gpt, sonnet];
		},
		getAvailable() {
			return available;
		},
	};
}

describe("model presets", () => {
	test("orders built-in presets before custom ones", () => {
		expect(orderedModelPresetNames({ zebra: [{ model: "gpt-5.5" }] })).toEqual([
			"fast",
			"small",
			"efficient",
			"smart",
			"oracle",
			"zebra",
		]);
	});

	test("parses newline candidate definitions with optional thinking", () => {
		expect(parseModelPresetCandidates("gpt-5.5:medium\nclaude-sonnet-4-6:high\nhaiku\n")).toEqual([
			{ model: "gpt-5.5", thinking: "medium" },
			{ model: "claude-sonnet-4-6", thinking: "high" },
			{ model: "haiku" },
		]);
	});

	test("falls back to the next preset candidate when the first model is unavailable", () => {
		const presets = mergeModelPresets({
			efficient: [
				{ model: "gpt-5.5", thinking: "low" },
				{ model: "anthropic/claude-sonnet-4-6", thinking: "medium" },
			],
		});
		expect(resolveModelPreset("efficient", registry([sonnet]), presets)).toEqual({
			model: sonnet,
			thinking: "medium",
		});
	});

	test("keeps the shipped preset definitions available", () => {
		expect(DEFAULT_MODEL_PRESETS.fast).toEqual([
			{ model: "gpt-5.3-codex-spark" },
			{ model: "gpt-5.4-mini" },
			{ model: "anthropic/claude-haiku-4-5-20251001" },
		]);
		expect(DEFAULT_MODEL_PRESETS.oracle?.at(-1)).toEqual({
			model: "anthropic/claude-opus-4-6",
			thinking: "xhigh",
		});
	});
});
