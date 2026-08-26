import { expect, test } from "bun:test";
import type { SubagentSnapshot } from "../src/runtime/coordinator.ts";
import { normalizeTaskName } from "../src/tools/spawn-agent/definition.ts";
import { createRepeatBreaker } from "../src/tools/repeat-breaker.ts";
import { agentRecords, MAX_AGENT_RECORDS, MAX_RESULT_TEXT } from "../src/tools/result.ts";
import {
	createWaitAgentTool,
	DEFAULT_WAIT_TIMEOUT_MS,
	MAX_WAIT_TIMEOUT_MS,
	MIN_WAIT_TIMEOUT_MS,
	waitTimeout,
} from "../src/tools/wait-agent/definition.ts";

test("validates canonical task-name segments", () => {
	expect(normalizeTaskName("worker-2")).toBe("worker-2");
	expect(() => normalizeTaskName("worker--2")).toThrow("single dashes");
	expect(() => normalizeTaskName("Worker")).toThrow("lowercase");
});

test("clamps mailbox waits to the public bounds", () => {
	expect(waitTimeout(undefined)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
	expect(waitTimeout(1)).toBe(MIN_WAIT_TIMEOUT_MS);
	expect(waitTimeout(Number.NaN)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
	expect(waitTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
	expect(waitTimeout(MAX_WAIT_TIMEOUT_MS + 1)).toBe(MAX_WAIT_TIMEOUT_MS);
});

test("wait_agent reports mailbox status without exposing its payload", async () => {
	const tool = createWaitAgentTool({
		pi: {},
		callerPath: () => undefined,
		modelRoles: () => ({ roles: [] }),
		otherLiveAgents: () => [snapshot(1, "")],
		coordinator: () =>
			({
				waitForUpdate: async () => ({
					type: "mailbox",
					delivery: {
						id: 1,
						type: "FINAL_ANSWER",
						target: "/root",
						sender: "/root/worker",
						payload: "private final payload",
					},
				}),
			}) as never,
	} as never);
	const result = await tool.execute("wait", { timeout_ms: 10_000 }, undefined, undefined, {} as never);
	const rendered = JSON.stringify(result);
	expect(rendered).toContain("Mailbox update from /root/worker.");
	expect(rendered).not.toContain("private final payload");
});

test("warns only after the same tool outcome repeats three times", () => {
	const breaker = createRepeatBreaker();
	expect(breaker.observe("session", "list_agents", {}, "[]")).toBeUndefined();
	expect(breaker.observe("session", "list_agents", {}, "[]")).toBeUndefined();
	expect(breaker.observe("session", "list_agents", {}, "[]")).toContain("3 times");
	expect(breaker.observe("session", "list_agents", {}, "changed")).toBeUndefined();
	expect(breaker.observe("other", "list_agents", {}, "[]")).toBeUndefined();
});

test("bounds and serializes agent presentation details", () => {
	const oversized = "x".repeat(MAX_RESULT_TEXT + 10);
	const agents = Array.from({ length: MAX_AGENT_RECORDS + 2 }, (_, index) => snapshot(index, oversized));
	const bounded = agentRecords(agents);
	expect(bounded.records).toHaveLength(MAX_AGENT_RECORDS);
	expect(bounded.records[0]?.output?.length).toBe(MAX_RESULT_TEXT);
	expect(bounded.truncation.agentsOmitted).toBe(2);
	expect(bounded.truncation.textCharactersOmitted).toBeGreaterThan(MAX_AGENT_RECORDS * 10);
	expect(() => JSON.stringify(bounded)).not.toThrow();
});

function snapshot(index: number, result: string): SubagentSnapshot {
	return {
		id: `/root/agent-${index}`,
		rootSessionId: "root",
		parentId: "/root",
		cwd: "/tmp",
		description: `agent-${index}`,
		status: "idle",
		message: "work",
		result,
		startedAt: 1,
		completedAt: 2,
		toolUses: 0,
		cost: 0,
		tokenCount: 0,
		compactions: 0,
		transcriptAvailable: true,
	};
}
