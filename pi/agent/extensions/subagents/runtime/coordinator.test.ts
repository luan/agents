import { expect, test } from "bun:test";
import { buildCompletionMessage } from "./coordinator";
import type { AgentRecord } from "./types";

function record(id: string): AgentRecord {
	return {
		id,
		type: "task",
		description: id,
		status: "completed",
		rootSessionId: "root-session",
		parentSessionId: "root-session",
		assignment: "work",
		cwd: "/tmp",
		events: [],
		toolUses: 0,
		startedAt: 1,
		completedAt: 2,
		result: `result for ${id}`,
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
		compactionCount: 0,
	};
}

test("batches completions into one hidden follow-up message", () => {
	const completion = buildCompletionMessage([record("a"), record("b")]);

	expect(completion.message.customType).toBe("subagents-complete");
	expect(completion.message.display).toBe(false);
	expect(completion.message.content).toContain("## a");
	expect(completion.message.content).toContain("## b");
	expect(completion.message.details.agents).toHaveLength(2);
	expect(completion.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
});
