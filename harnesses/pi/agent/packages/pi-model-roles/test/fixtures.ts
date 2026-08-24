import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import type { ModelRolesContext } from "../src/runtime/roles.ts";

export function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 32_000,
	};
}

export function customEntry(customType: string, data: object): SessionEntry {
	return {
		type: "custom",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType,
		data,
	};
}

interface ContextOptions {
	model?: Model<Api>;
	entries?: SessionEntry[];
	available?: Model<Api>[];
	statuses?: Array<string | undefined>;
	notifications?: string[];
}

export function context(options: ContextOptions = {}): ModelRolesContext {
	const available = options.available ?? [];
	return {
		hasUI: true,
		model: options.model,
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => available,
		},
		sessionManager: {
			getBranch: () => options.entries ?? [],
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text } as Theme,
			setStatus: (_key: string, text: string | undefined) => options.statuses?.push(text),
			notify: (message: string) => options.notifications?.push(message),
		},
	};
}
