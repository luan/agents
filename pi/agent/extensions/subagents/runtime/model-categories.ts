import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ModelRegistry, resolveConfiguredModel } from "./model-resolver.js";
import type { ModelCategory, ThinkingLevel } from "./types.js";

export const DEFAULT_MODEL_CATEGORIES: Record<string, ModelCategory> = {
	smol: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
	fast: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
	default: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
	smart: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function readCategories(path: string): Record<string, ModelCategory> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { modelCategories?: Record<string, unknown> };
		const categories: Record<string, ModelCategory> = {};
		for (const [name, value] of Object.entries(raw.modelCategories ?? {})) {
			if (!value || typeof value !== "object") continue;
			const entry = value as Record<string, unknown>;
			if (typeof entry.model !== "string" || !entry.model.trim()) continue;
			const thinking = THINKING_LEVELS.has(entry.thinking as ThinkingLevel)
				? (entry.thinking as ThinkingLevel)
				: undefined;
			categories[name] = thinking ? { model: entry.model.trim(), thinking } : { model: entry.model.trim() };
		}
		return categories;
	} catch (error) {
		console.warn(
			`[subagents] Ignoring malformed settings at ${path}: ${error instanceof Error ? error.message : error}`,
		);
		return {};
	}
}

export function loadModelCategories(cwd: string): Record<string, ModelCategory> {
	return {
		...DEFAULT_MODEL_CATEGORIES,
		...readCategories(join(getAgentDir(), "subagents.json")),
		...readCategories(join(cwd, ".pi", "subagents.json")),
	};
}

export function resolveModelCategory(
	name: string | undefined,
	registry: ModelRegistry,
	categories: Record<string, ModelCategory>,
): { model?: any; thinking?: ThinkingLevel } {
	const category = name ? categories[name] : undefined;
	if (!category) return {};
	const model = resolveConfiguredModel(category.model, registry);
	return model ? { model, thinking: category.thinking } : {};
}
