import { expect, test } from "bun:test";
import modelRolesExtension from "./index";

test("attached subagent keeps its requested model role", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const luna = {
		provider: "openai-codex",
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		reasoning: true,
	};
	const sol = { ...luna, id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
	const selectedModels: string[] = [];
	let thinkingLevel: string | undefined;
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerCommand() {},
		registerShortcut() {},
		setModel: async (model: typeof luna) => {
			selectedModels.push(model.id);
			return true;
		},
		setThinkingLevel: (level: string) => {
			thinkingLevel = level;
		},
	} as any;
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		model: luna,
		modelRegistry: {
			getAvailable: () => [sol, luna],
			find: (provider: string, id: string) =>
				[sol, luna].find((model) => model.provider === provider && model.id === id),
		},
		sessionManager: {
			getBranch: () => [],
			getSessionFile: () => "/tmp/attached-tiny.jsonl",
		},
		ui: { notify() {} },
	} as any;

	process.env.PI_ATTACHED_AGENT_MODEL_ROLE = "tiny";
	modelRolesExtension(pi);
	await handlers.get("session_start")?.({}, ctx);

	expect(selectedModels).toEqual([]);
	expect(thinkingLevel).toBe("low");
	expect(process.env.PI_ATTACHED_AGENT_MODEL_ROLE).toBeUndefined();
});
