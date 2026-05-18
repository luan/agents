import { type ModelRegistry, resolveConfiguredModel } from "./model-resolver.js";
import type { ModelPresetCandidate, ThinkingLevel } from "./types.js";

export const DEFAULT_MODEL_PRESET_ORDER = ["fast", "small", "efficient", "smart", "oracle"] as const;

export const DEFAULT_MODEL_PRESETS: Record<string, ModelPresetCandidate[]> = {
	fast: [
		{ model: "gpt-5.3-codex-spark" },
		{ model: "gpt-5.4-mini" },
		{ model: "anthropic/claude-haiku-4-5-20251001" },
	],
	small: [{ model: "gpt-5.4-mini" }, { model: "anthropic/claude-haiku-4-5-20251001" }],
	efficient: [
		{ model: "gpt-5.5", thinking: "low" },
		{ model: "anthropic/claude-sonnet-4-6", thinking: "medium" },
	],
	smart: [
		{ model: "gpt-5.5", thinking: "medium" },
		{ model: "anthropic/claude-opus-4-6", thinking: "medium" },
	],
	oracle: [
		{ model: "gpt-5.5", thinking: "high" },
		{ model: "anthropic/claude-opus-4-6", thinking: "xhigh" },
	],
};

export function mergeModelPresets(
	customPresets?: Record<string, ModelPresetCandidate[]>,
): Record<string, ModelPresetCandidate[]> {
	return { ...DEFAULT_MODEL_PRESETS, ...(customPresets ?? {}) };
}

export function orderedModelPresetNames(customPresets?: Record<string, ModelPresetCandidate[]>): string[] {
	const merged = mergeModelPresets(customPresets);
	const defaults = DEFAULT_MODEL_PRESET_ORDER.filter((name) => merged[name]);
	const custom = Object.keys(merged)
		.filter((name) => !DEFAULT_MODEL_PRESET_ORDER.includes(name as (typeof DEFAULT_MODEL_PRESET_ORDER)[number]))
		.sort((a, b) => a.localeCompare(b));
	return [...defaults, ...custom];
}

export function isDefaultModelPreset(name: string): boolean {
	return Object.hasOwn(DEFAULT_MODEL_PRESETS, name);
}

function thinkingSuffix(thinking: ThinkingLevel | undefined): string {
	return thinking ? `:${thinking}` : "";
}

export function formatModelPresetCandidates(candidates: ModelPresetCandidate[]): string {
	return candidates.map((candidate) => `${candidate.model}${thinkingSuffix(candidate.thinking)}`).join(" | ");
}

export function parseModelPresetCandidates(input: string): ModelPresetCandidate[] {
	const validThinking = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
	return input
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const parts = line.split(":");
			if (parts.length >= 2) {
				const thinking = parts.at(-1)?.trim() as ThinkingLevel | undefined;
				if (thinking && validThinking.has(thinking)) {
					const model = parts.slice(0, -1).join(":").trim();
					return model ? { model, thinking } : undefined;
				}
			}
			return { model: line };
		})
		.filter((candidate): candidate is ModelPresetCandidate => Boolean(candidate?.model));
}

export function resolveModelPreset(
	presetName: string | undefined,
	registry: ModelRegistry,
	presets: Record<string, ModelPresetCandidate[]>,
): { model?: any; thinking?: ThinkingLevel } {
	if (!presetName) return {};
	for (const candidate of presets[presetName] ?? []) {
		const model = resolveConfiguredModel(candidate.model, registry);
		if (model) return { model, thinking: candidate.thinking };
	}
	return {};
}
