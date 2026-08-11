import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "./agent-manager";
import {
	type PersistedAgent,
	readRetainedAgentRegistries,
	removeAgentRegistryRecord,
	toPersistedAgent,
	writeAgentRegistry,
} from "./persistence";
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
		runtime: { session: { dispose() {} } },
		attachment: {
			mode: "terminal",
			sessionName: "pi-agent-agent-1",
			socketPath: "/tmp/agent-1.sock",
			command: "rmux",
			args: ["attach-session", "-t", "pi-agent-agent-1"],
		},
		attachedRuntime: { steer() {}, run() {}, stop() {} },
		outputCleanup() {},
	} as unknown as AgentRecord;

	const persisted = toPersistedAgent(record) as Record<string, unknown>;
	expect(persisted.id).toBe("/root/agent-1");
	expect(persisted.session).toBeUndefined();
	expect(persisted.runtime).toBeUndefined();
	expect(persisted.promise).toBeUndefined();
	expect(persisted.abortController).toBeUndefined();
	expect(persisted.outputCleanup).toBeUndefined();
	expect(persisted.attachedRuntime).toBeUndefined();
	expect(persisted.attachment).toEqual({
		mode: "terminal",
		sessionName: "pi-agent-agent-1",
		socketPath: "/tmp/agent-1.sock",
		command: "rmux",
		args: ["attach-session", "-t", "pi-agent-agent-1"],
	});
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
		startedAt: Date.now(),
		completedAt: Date.now(),
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

test("restores running attached agents without reopening them in-process", () => {
	const manager = new AgentManager(undefined, 1);
	manager.restore([
		{
			id: "attached",
			type: "task",
			description: "attached",
			status: "running",
			rootSessionId: "root-session",
			parentSessionId: "root-session",
			assignment: "delegate",
			cwd: "/tmp/project",
			isBackground: true,
			events: [],
			toolUses: 0,
			startedAt: Date.now(),
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
			compactionCount: 0,
			executionMode: "attached",
			attachment: {
				mode: "terminal",
				sessionName: "attached",
				socketPath: "/tmp/attached.sock",
				command: "true",
				args: [],
			},
		},
	]);

	expect(manager.getRecord("attached")?.status).toBe("running");
	const queuedId = manager.spawn({} as never, { cwd: "/tmp/project" } as never, "task", "queued", {
		description: "queued",
		rootSessionId: "root-session",
		parentSessionId: "root-session",
		assignment: "queued",
		agentConfig: {} as never,
		isBackground: true,
	});
	expect(manager.getRecord(queuedId)?.status).toBe("queued");
	manager.abortAll();
});

test("does not retry an attached session through the in-process runner", async () => {
	const manager = new AgentManager();
	manager.restore([
		{
			id: "attached",
			type: "task",
			description: "attached",
			status: "error",
			error: "failed",
			rootSessionId: "root-session",
			parentSessionId: "root-session",
			assignment: "delegate",
			cwd: "/tmp/project",
			sessionFile: "/tmp/attached.jsonl",
			agentConfig: {} as never,
			events: [],
			toolUses: 0,
			startedAt: Date.now(),
			completedAt: Date.now(),
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
			compactionCount: 0,
			executionMode: "attached",
			attachment: {
				mode: "terminal",
				sessionName: "attached",
				socketPath: "/tmp/attached.sock",
				command: "true",
				args: [],
			},
		},
	]);

	expect(await manager.retry({} as never, {} as never, "attached")).toBeUndefined();
});

test("retains only the newest terminal agents per root session", () => {
	const removed: string[] = [];
	const manager = new AgentManager(undefined, undefined, undefined, undefined, (record) => removed.push(record.id), 2);
	const now = Date.now();
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
				startedAt: now + index,
				completedAt: now + index,
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
				compactionCount: 0,
			}) satisfies PersistedAgent,
	);

	manager.restore(records);

	expect(manager.listAgents("root-session").map((record) => record.id)).toEqual(["agent-3", "agent-2"]);
	expect(removed).toEqual(["agent-1"]);
	manager.dispose();
});

test("discovers retained agents across root sessions", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-registries-"));
	try {
		const now = Date.now();
		for (const session of ["root-a", "root-b"]) {
			const dir = join(root, session);
			mkdirSync(dir);
			writeFileSync(
				join(dir, "registry.json"),
				JSON.stringify({
					version: 1,
					agents: [
						{
							id: `agent-${session}`,
							rootSessionId: session,
							status: "completed",
							startedAt: now,
							completedAt: now,
						},
					],
				}),
			);
		}
		expect(
			readRetainedAgentRegistries(root, 100, now)
				.map((agent) => agent.id)
				.sort(),
		).toEqual(["agent-root-a", "agent-root-b"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("prunes stale agents from unopened root registries", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-retention-"));
	try {
		const now = Date.now();
		const dir = join(root, "unopened-root");
		mkdirSync(dir);
		const base = {
			type: "task",
			description: "agent",
			rootSessionId: "unopened-root",
			parentSessionId: "unopened-root",
			assignment: "delegate",
			cwd: "/tmp/project",
			events: [],
			toolUses: 0,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
			compactionCount: 0,
		};
		const agents = [
			{ ...base, id: "stale", status: "completed", startedAt: now - 11 * 60_000, completedAt: now - 11 * 60_000 },
			{ ...base, id: "fresh", status: "completed", startedAt: now, completedAt: now },
			{ ...base, id: "running", status: "running", startedAt: now - 60 * 60_000 },
		] satisfies PersistedAgent[];
		const path = join(dir, "registry.json");
		writeFileSync(path, JSON.stringify({ version: 1, agents }));

		expect(
			readRetainedAgentRegistries(root, 100, now)
				.map((agent) => agent.id)
				.sort(),
		).toEqual(["fresh", "running"]);
		expect(
			(JSON.parse(readFileSync(path, "utf8")) as { agents: PersistedAgent[] }).agents
				.map((agent) => agent.id)
				.sort(),
		).toEqual(["fresh", "running"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("merges stale registry snapshots without dropping sibling agents", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-registry-merge-"));
	try {
		const now = Date.now();
		const base = {
			type: "task",
			description: "agent",
			status: "completed" as const,
			rootSessionId: "shared-root",
			parentSessionId: "shared-root",
			assignment: "delegate",
			cwd: "/tmp/project",
			events: [],
			toolUses: 0,
			startedAt: now,
			completedAt: now,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
			compactionCount: 0,
		};
		const first = { ...base, id: "first" } satisfies AgentRecord;
		const second = { ...base, id: "second" } satisfies AgentRecord;

		writeAgentRegistry("shared-root", [first], root);
		writeAgentRegistry("shared-root", [second], root);
		writeAgentRegistry("shared-root", [{ ...first, result: "updated" }], root);

		expect(readRetainedAgentRegistries(root, 100, now).map((agent) => [agent.id, agent.result])).toEqual([
			["first", "updated"],
			["second", undefined],
		]);

		removeAgentRegistryRecord("shared-root", "first", root);
		expect(readRetainedAgentRegistries(root, 100, now).map((agent) => agent.id)).toEqual(["second"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("retains old terminal agents only when claiming them from the Hub", () => {
	const oldAgent = {
		id: "old-agent",
		type: "task",
		description: "old agent",
		status: "completed" as const,
		rootSessionId: "root-session",
		parentSessionId: "root-session",
		assignment: "delegate",
		cwd: "/tmp/project",
		events: [],
		toolUses: 0,
		startedAt: Date.now() - 11 * 60_000,
		completedAt: Date.now() - 11 * 60_000,
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
		compactionCount: 0,
	};
	const restored = new AgentManager();
	restored.restore([oldAgent]);
	expect(restored.listAgents("root-session")).toEqual([]);
	restored.dispose();

	const claimed = new AgentManager();
	claimed.restore([oldAgent], false);
	expect(claimed.listAgents("root-session").map((record) => record.id)).toEqual(["old-agent"]);
	claimed.dispose();
});

test("keeps colliding agent ids addressable by root session", () => {
	const manager = new AgentManager();
	const base = {
		id: "shared-id",
		type: "task",
		description: "agent",
		status: "completed" as const,
		parentSessionId: "parent",
		assignment: "delegate",
		cwd: "/tmp/project",
		events: [],
		toolUses: 0,
		startedAt: Date.now(),
		completedAt: Date.now(),
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
		compactionCount: 0,
	};
	manager.restore(
		[
			{ ...base, rootSessionId: "root-a" },
			{ ...base, rootSessionId: "root-b" },
		],
		false,
	);

	expect(
		manager
			.listAgents()
			.map((record) => record.rootSessionId)
			.sort(),
	).toEqual(["root-a", "root-b"]);
	const rootA = manager.getRecord("shared-id", "root-a")!;
	const rootB = manager.getRecord("shared-id", "root-b")!;
	rootA.status = "running";
	rootB.status = "running";
	rootA.abortController = new AbortController();
	rootB.abortController = new AbortController();

	expect(manager.abort("shared-id", "root-b")).toBe(true);
	expect(rootA.status).toBe("running");
	expect(rootB.status).toBe("stopped");
	manager.dispose();
});

test("spawns the same explicit id in different root sessions", () => {
	const manager = new AgentManager(undefined, 0);
	const agentConfig = {
		name: "task",
		description: "Task",
		skills: false,
		systemPrompt: "Work.",
		promptMode: "replace",
	} as const;
	for (const rootSessionId of ["root-a", "root-b"]) {
		manager.spawn({} as never, { cwd: "/tmp/project" } as never, "task", "work", {
			id: "shared-id",
			description: "shared",
			rootSessionId,
			parentSessionId: rootSessionId,
			assignment: "work",
			agentConfig,
			isBackground: true,
		});
	}

	expect(
		manager
			.listAgents()
			.map((record) => record.rootSessionId)
			.sort(),
	).toEqual(["root-a", "root-b"]);
	manager.dispose();
});

test("suffixes duplicate explicit ids in one root session", () => {
	const manager = new AgentManager(undefined, 0);
	const agentConfig = {
		name: "task",
		description: "Task",
		skills: false,
		systemPrompt: "Work.",
		promptMode: "replace",
	} as const;
	const spawn = () =>
		manager.spawn({} as never, { cwd: "/tmp/project" } as never, "task", "work", {
			id: "shared-id",
			description: "shared",
			rootSessionId: "root",
			parentSessionId: "root",
			assignment: "work",
			agentConfig,
			isBackground: true,
		});

	expect([spawn(), spawn()]).toEqual(["shared-id", "shared-id-2"]);
	manager.dispose();
});
