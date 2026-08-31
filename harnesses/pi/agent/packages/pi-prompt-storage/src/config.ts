import { readFileSync } from "node:fs";
import type { PromptStorageConfig } from "./core/model.ts";

export const defaultConfig: PromptStorageConfig = {
	shortcuts: { stash: "ctrl+s" },
	history: { includeSlashCommands: true, maxResults: 120 },
	picker: { maxVisible: 10, enterAction: "pop" },
};

export function loadConfig(): PromptStorageConfig {
	try {
		const parsed = JSON.parse(
			readFileSync(new URL("../config.json", import.meta.url), "utf8"),
		) as Partial<PromptStorageConfig>;
		return {
			...defaultConfig,
			...parsed,
			shortcuts: { ...defaultConfig.shortcuts, ...(parsed.shortcuts ?? {}) },
			history: { ...defaultConfig.history, ...(parsed.history ?? {}) },
			picker: { ...defaultConfig.picker, ...(parsed.picker ?? {}) },
		};
	} catch {
		return defaultConfig;
	}
}
