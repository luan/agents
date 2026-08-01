import { expect, test } from "bun:test";
import { AgentManager } from "./agent-manager";
import { type PersistedAgent, toPersistedAgent } from "./persistence";
import type { AgentRecord } from "./types";

test("removes live runtime handles from persisted agents", () => {
	const record = {
		id: "/root/agent-1",
		type: "explore",
		description: "Inspect persistence",
		status: "completed",
		rootSessionId: "parent-1",
		parentSessionId: "parent-1",
		assignment: "Inspect persistence",
		cwd: "/tmp/project",
		events: [],
		toolUses: 1,
		startedAt: 1,
		completedAt: 2,
		lifetimeUsage: { input: 1, output: 2, cacheWrite: 0, cost: 0 },
		compactionCount: 0,
		abortController: new AbortController(),
		promise: Promise.resolve("done"),
		session: { dispose() {} },
		outputCleanup() {},
	} as unknown as AgentRecord;

	const persisted = toPersistedAgent(record) as Record<string, unknown>;
	expect(persisted.id).toBe("/root/agent-1");
	expect(persisted.session).toBeUndefined();
	expect(persisted.promise).toBeUndefined();
	expect(persisted.abortController).toBeUndefined();
	expect(persisted.outputCleanup).toBeUndefined();
});

test("restores one root-owned recursive agent tree", () => {
	const base = {
		type: "task",
		description: "delegated",
		status: "completed" as const,
		rootSessionId: "root-session",
		assignment: "delegate",
		cwd: "/tmp/project",
		events: [],
		toolUses: 0,
		startedAt: 1,
		completedAt: 2,
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
		compactionCount: 0,
	};
	const records: PersistedAgent[] = [
		{ ...base, id: "/root/parent", parentSessionId: "root-session", childSessionId: "child-session" },
		{
			...base,
			id: "/root/parent/reviewer",
			parentSessionId: "child-session",
			parentAgentId: "/root/parent",
		},
	];
	const manager = new AgentManager();
	manager.restore(records);

	expect(
		manager
			.listAgents("root-session")
			.map((record) => record.id)
			.sort(),
	).toEqual(["parent", "parent/reviewer"]);
	expect(manager.findByChildSessionId("child-session")?.id).toBe("parent");
	expect(manager.getRootSessionId("child-session")).toBe("root-session");
});

test("retains only the newest terminal agents per root session", () => {
	const removed: string[] = [];
	const manager = new AgentManager(undefined, undefined, undefined, undefined, (record) => removed.push(record.id), 2);
	const records = [1, 2, 3].map(
		(index) =>
			({
				id: `agent-${index}`,
				type: "task",
				description: `agent ${index}`,
				status: "completed",
				rootSessionId: "root-session",
				parentSessionId: "root-session",
				assignment: "delegate",
				cwd: "/tmp/project",
				events: [],
				toolUses: 0,
				startedAt: index,
				completedAt: index,
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
				compactionCount: 0,
			}) satisfies PersistedAgent,
	);

	manager.restore(records);

	expect(manager.listAgents("root-session").map((record) => record.id)).toEqual(["agent-3", "agent-2"]);
	expect(removed).toEqual(["agent-1"]);
	manager.dispose();
});
