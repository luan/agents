import { expect, test } from "bun:test";
import { resolveModelRole } from "../../model-roles/catalog";
import { parseAgentMarkdown } from "./custom-agents";

test("resolves a role candidate and thinking level", () => {
	const model = {
		provider: "openai-codex",
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		reasoning: true,
		thinkingLevelMap: { max: "high" },
	};
	const registry = {
		getAvailable: () => [model],
		find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
	};
	const catalog = {
		defaultRole: "balanced",
		roles: {
			balanced: { candidates: [{ model: "openai-codex/gpt-5.6-sol", thinking: "medium" as const }] },
		},
	};

	expect(resolveModelRole("balanced", registry, catalog)).toMatchObject({
		roleName: "balanced",
		model,
		candidate: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
	});
});

test("custom agents select a current model role", () => {
	const agent = parseAgentMarkdown("worker", "---\nrole: tiny\nskills: false\n---\nDo the work.", "project");

	expect(agent.role).toBe("tiny");
});
