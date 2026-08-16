import { expect, test } from "bun:test";
import { buildAgentPrompt } from "./prompts";

test("a child preserves the inherited prompt and adds one child instruction layer", () => {
	const prompt = buildAgentPrompt("# Parent", { agentPath: "/root/child", maxConcurrency: 8, maxDepth: 2 });
	expect(prompt.startsWith("# Parent\n\n")).toBe(true);
	expect(prompt.split("<sub_agent_context>").length - 1).toBe(1);
	expect(prompt).toContain("/root/child");
});

test("a nested child replaces its parent identity instead of accumulating layers", () => {
	const first = buildAgentPrompt("# Parent", { agentPath: "/root/parent", maxConcurrency: 8, maxDepth: 2 });
	const nested = buildAgentPrompt(first, { agentPath: "/root/parent/child", maxConcurrency: 8, maxDepth: 2 });
	expect(nested.split("<sub_agent_context>").length - 1).toBe(1);
	expect(nested).not.toContain("`/root/parent`,");
	expect(nested).toContain("`/root/parent/child`,");
});
