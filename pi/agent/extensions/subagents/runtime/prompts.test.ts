import { describe, expect, test } from "bun:test";
import { buildCavemanPrompt } from "../../system-prompt/caveman";
import { buildAgentPrompt } from "./prompts";
import type { AgentConfig, EnvInfo } from "./types";

const env: EnvInfo = {
	isGitRepo: true,
	branch: "test",
	platform: "darwin",
};

const replaceAgent: AgentConfig = {
	name: "reviewer",
	description: "review",
	skills: false,
	systemPrompt: "Review the change.",
	promptMode: "replace",
};

describe("subagent prompt construction", () => {
	test("replace agents inherit the active Caveman style", () => {
		const cavemanPrompt = buildCavemanPrompt("ultra");
		const prompt = buildAgentPrompt(
			replaceAgent,
			"/tmp/no-caveman-config",
			env,
			`${cavemanPrompt}\n\n# Project Context`,
		);

		expect(prompt).toContain(cavemanPrompt);
	});
});
