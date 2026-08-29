import { expect, test } from "bun:test";
import { createSpawnAgentTool } from "../src/tools/spawn-agent/definition.ts";

test("keeps immediate and duplicate work out of delegated tasks", () => {
	const tool = createSpawnAgentTool({
		modelRoles: () => ({ roles: [], subagentDefaultRole: "" }),
	} as never);

	expect(tool.promptGuidelines).toEqual(
		expect.arrayContaining([
			"Do not delegate urgent blocking work when your immediate next step depends on that result. If the very next action is blocked on that task, the main rollout should usually do it locally to keep the critical path moving.",
			"Do not duplicate work between the main rollout and delegated subtasks.",
		]),
	);
});
