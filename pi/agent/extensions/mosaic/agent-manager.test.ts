import { describe, expect, test } from "bun:test";
import { AgentManager } from "./agent-manager";
import type { AgentRecord } from "./types";

function record(id: string, isBackground: boolean): AgentRecord {
	return {
		id,
		type: "general-purpose",
		description: id,
		status: "running",
		isBackground,
		toolUses: 0,
		startedAt: Date.now(),
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
		compactionCount: 0,
	};
}

describe("AgentManager running state", () => {
	test("does not count background agents as blocking work", () => {
		const manager = new AgentManager();
		(manager as unknown as { agents: Map<string, AgentRecord> }).agents.set("bg", record("bg", true));

		expect(manager.hasRunning()).toBe(true);
		expect(manager.hasBlockingRunning()).toBe(false);

		manager.dispose();
	});

	test("counts inline agents as blocking work", () => {
		const manager = new AgentManager();
		(manager as unknown as { agents: Map<string, AgentRecord> }).agents.set("inline", record("inline", false));

		expect(manager.hasBlockingRunning()).toBe(true);

		manager.dispose();
	});
});
