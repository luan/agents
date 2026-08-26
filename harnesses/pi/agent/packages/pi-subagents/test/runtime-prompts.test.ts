import { expect, test } from "bun:test";
import { buildAgentPrompt } from "../src/core/prompts.ts";

test("replaces inherited collaboration identity with one child context", () => {
	const prompt = buildAgentPrompt(
		"Base\n<root_agent_context>old root</root_agent_context>\n<sub_agent_context>old child</sub_agent_context>",
		{ agentPath: "/root/reviewer", maxConcurrency: 8, maxDepth: 2 },
	);
	expect(prompt).toContain("Base");
	expect(prompt).toContain("You are `/root/reviewer`");
	expect(prompt.match(/<sub_agent_context>/g)).toHaveLength(1);
	expect(prompt).not.toContain("old root");
	expect(prompt).not.toContain("old child");
});

test("uses the generic role only when no parent prompt exists", () => {
	expect(buildAgentPrompt()).toContain("general-purpose coding agent");
	expect(buildAgentPrompt("parent role")).toBe("parent role");
});
