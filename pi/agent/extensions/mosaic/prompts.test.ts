import { describe, expect, test } from "bun:test";
import { buildAgentPrompt } from "./prompts";
import type { AgentConfig, EnvInfo } from "./types";

const env: EnvInfo = {
	isGitRepo: true,
	branch: "main",
	platform: "darwin",
};

const replaceConfig: AgentConfig = {
	name: "Explore",
	description: "explore",
	toolNames: ["read"],
	extensions: true,
	skills: false,
	systemPrompt: "Explore files.",
	promptMode: "replace",
};

describe("buildAgentPrompt", () => {
	test("pins the delegated task in replace-mode system prompts", () => {
		const prompt = buildAgentPrompt(replaceConfig, "/repo", env, undefined, {
			delegatedTask: {
				taskName: "research-mux-parity-evidence",
				message: "Inspect mux/sidebar parity and report factual gaps.",
			},
		});

		expect(prompt).toContain("<delegated_task>");
		expect(prompt).toContain("research-mux-parity-evidence");
		expect(prompt).toContain("Inspect mux/sidebar parity and report factual gaps.");
		expect(prompt).toContain("authoritative even after conversation compaction");
	});

	test("pins the delegated task in append-mode system prompts", () => {
		const prompt = buildAgentPrompt(
			{ ...replaceConfig, promptMode: "append" },
			"/repo",
			env,
			"Parent system prompt.",
			{
				delegatedTask: {
					taskName: "audit",
					message: "Audit the implementation.",
				},
			},
		);

		expect(prompt).toContain("<inherited_system_prompt>");
		expect(prompt).toContain("<delegated_task>");
		expect(prompt).toContain("Audit the implementation.");
	});
});
