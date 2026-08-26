import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CoordinatorOptions,
	createRootCoordinator,
	removeRootCoordinator,
	SubagentCoordinator,
	subagentSessionDir,
	type SubagentTreeCheckpoint,
} from "../src/runtime/coordinator.ts";
import { SESSION_HIERARCHY, type SessionHierarchyEntry } from "../src/protocol/session-hierarchy.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function fakeSession(prompts: string[], turns: Array<ReturnType<typeof deferred<void>>>) {
	return {
		state: { messages: [] },
		messages: [],
		sessionManager: {
			getSessionFile: () => "/tmp/root-session/subagents/worker/session.jsonl",
			getSessionId: () => "child-session",
			getBranch: () => [],
		},
		subscribe: () => () => {},
		getToolDefinition: () => undefined,
		extensionRunner: { getMessageRenderer: () => undefined },
		getSessionStats: () => ({ tokens: { total: 0 }, contextUsage: undefined }),
		prompt: (message: string) => {
			prompts.push(message);
			const turn = deferred<void>();
			turns.push(turn);
			return turn.promise;
		},
		abort: async () => {},
	} as never;
}

function request(taskName: string) {
	return {
		taskName,
		message: `do ${taskName}`,
		pi: {} as never,
		ctx: {
			cwd: "/tmp/work",
			sessionManager: { getEntries: () => [], getLeafId: () => undefined, getSessionDir: () => "/tmp/root-session" },
		} as never,
		agentConfig: {},
	};
}

test("registers nested canonical paths and resolves exact targets", () => {
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 1 });
	expect(coordinator.spawn(undefined, request("parent"))).toBe("/root/parent");
	expect(coordinator.spawn("/root/parent", request("child"))).toBe("/root/parent/child");
	expect(coordinator.resolve("/root/parent", "child")).toBe("/root/parent/child");
	expect(coordinator.resolve(undefined, "/root/parent/ch")).toBeUndefined();
});

test("publishes only the invoking session and its descendants", async () => {
	const session = (sessionId: string) => ({
		state: { messages: [] },
		messages: [],
		sessionManager: {
			getSessionFile: () => `/tmp/${sessionId}.jsonl`,
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		subscribe: () => () => {},
		getToolDefinition: () => undefined,
		extensionRunner: { getMessageRenderer: () => undefined },
		getSessionStats: () => ({ tokens: { total: 0 }, contextUsage: undefined }),
		prompt: async () => {},
		abort: async () => {},
	});
	const run: CoordinatorOptions["run"] = ((_ctx: object, message: string, options: object) => {
		const childSession = session(`session-${message.replace("do ", "")}`);
		const runtime = { session: childSession, dispose: async () => {} };
		const callbacks = options as {
			onRuntimeCreated(runtime: never): void;
			onSessionCreated(session: never): void;
		};
		callbacks.onRuntimeCreated(runtime as never);
		callbacks.onSessionCreated(childSession as never);
		return Promise.resolve({ responseText: "done", session: childSession, runtime });
	}) as never;
	const coordinator = createRootCoordinator("hierarchy-root", { maxConcurrency: 3, run });
	coordinator.spawn(undefined, request("parent"));
	await flushPromises();
	coordinator.spawn("/root/parent", request("child"));
	await flushPromises();
	const capability = Reflect.get(globalThis, SESSION_HIERARCHY) as {
		descendants(id: string): readonly SessionHierarchyEntry[];
	};

	expect(capability.descendants("hierarchy-root").map(({ path }) => path)).toEqual([
		"/root",
		"/root/parent",
		"/root/parent/child",
	]);
	expect(capability.descendants("session-parent").map(({ path }) => path)).toEqual([
		"/root/parent",
		"/root/parent/child",
	]);
	expect(capability.descendants("session-child").map(({ path }) => path)).toEqual(["/root/parent/child"]);
	removeRootCoordinator("hierarchy-root");
});

test("uses the root session directory and rejects ambiguous task names", () => {
	expect(subagentSessionDir("/tmp/root", "/root/parent/child")).toBe("/tmp/root/subagents/parent/child");
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 1 });
	expect(() => coordinator.spawn(undefined, request("bad--name"))).toThrow("single hyphens");
});

test("returns immutable snapshots and queues explicit mailbox messages exactly once", async () => {
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 1 });
	coordinator.spawn(undefined, request("worker"));
	const snapshot = coordinator.snapshot();
	expect(Object.isFrozen(snapshot)).toBe(true);
	expect(Object.isFrozen(snapshot[0])).toBe(true);
	await coordinator.sendMessage("/root/worker", "/root", "done");
	expect(coordinator.drainMailbox("/root")).toEqual([
		{ id: 1, type: "MESSAGE", target: "/root", sender: "/root/worker", payload: "done" },
	]);
	expect(coordinator.drainMailbox("/root")).toEqual([]);
});

test("delivers successful nested finals to the direct parent without forging failures", async () => {
	const session = fakeSession([], []);
	const runtime = { session, dispose: async () => {} } as never;
	const run: CoordinatorOptions["run"] = ((_ctx: object, message: string, options: object) => {
		const callbacks = options as {
			onRuntimeCreated(runtime: never): void;
			onSessionCreated(session: never): void;
		};
		callbacks.onRuntimeCreated(runtime);
		callbacks.onSessionCreated(session);
		return Promise.resolve({
			responseText: `final:${message}`,
			error: message.includes("fail") ? "failed" : undefined,
			session,
			runtime,
		});
	}) as never;
	const coordinator = createRootCoordinator("nested-mailbox", { maxConcurrency: 3, run });
	coordinator.spawn(undefined, request("parent"));
	await flushPromises();
	expect(coordinator.drainMailbox("/root")[0]).toMatchObject({
		type: "FINAL_ANSWER",
		target: "/root",
		sender: "/root/parent",
		payload: "final:do parent",
	});

	coordinator.spawn("/root/parent", request("child"));
	await flushPromises();
	expect(coordinator.drainMailbox("/root/parent")[0]).toMatchObject({
		type: "FINAL_ANSWER",
		target: "/root/parent",
		sender: "/root/parent/child",
		payload: "final:do child",
	});

	coordinator.spawn("/root/parent", { ...request("failure"), message: "fail" });
	await flushPromises();
	expect(coordinator.drainMailbox("/root/parent")).toEqual([]);
	coordinator.dispose();
	removeRootCoordinator("nested-mailbox");
});

test("reserves one concurrency slot for the root", () => {
	const started: string[] = [];
	const run = ((_ctx: object, message: string) => {
		started.push(message);
		return new Promise(() => undefined);
	}) as never;
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 3, run });
	coordinator.spawn(undefined, request("one"));
	coordinator.spawn(undefined, request("two"));
	coordinator.spawn(undefined, request("three"));
	expect(started).toHaveLength(2);
	expect(coordinator.snapshot().find((agent) => agent.id === "/root/three")?.status).toBe("queued");
	coordinator.dispose();
});

test("rejects restored transcript paths outside the canonical child directory", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-root-"));
	const child = subagentSessionDir(root, "/root/worker");
	mkdirSync(child, { recursive: true });
	const outside = join(root, "outside.jsonl");
	writeFileSync(outside, "crafted transcript");
	const checkpoint: SubagentTreeCheckpoint = {
		version: 1,
		agents: [
			{
				id: "/root/worker",
				parentId: "/root",
				cwd: "/tmp/work",
				description: "worker",
				status: "idle",
				message: "work",
				startedAt: 1,
				completedAt: 2,
				toolUses: 0,
				cost: 0,
				tokenCount: 0,
				compactions: 0,
				transcriptFile: join(child, "..", "..", "outside.jsonl"),
				transcriptGeneration: 0,
			},
		],
	};
	const coordinator = new SubagentCoordinator("root", { rootSessionDir: root });
	coordinator.restore(checkpoint);
	expect(coordinator.snapshot()[0]?.transcriptAvailable).toBe(false);
	expect(coordinator.persistedAgent("/root/worker")?.transcriptFile).toBeUndefined();
});

test("serializes immediate post-interrupt follow-ups for initial and resumed turns", async () => {
	const initial = deferred<never>();
	const prompts: string[] = [];
	const turns: Array<ReturnType<typeof deferred<void>>> = [];
	const session = fakeSession(prompts, turns);
	const runtime = { session, dispose: async () => {} } as never;
	let starts = 0;
	const run: CoordinatorOptions["run"] = ((_ctx: object, _message: string, options: object) => {
		starts++;
		const callbacks = options as {
			onRuntimeCreated(runtime: never): void;
			onSessionCreated(session: never): void;
		};
		callbacks.onRuntimeCreated(runtime);
		callbacks.onSessionCreated(session);
		return initial.promise;
	}) as never;
	const rootId = "interrupt-restart-root";
	const coordinator = createRootCoordinator(rootId, { maxConcurrency: 3, run });
	coordinator.spawn(undefined, request("worker"));

	await coordinator.interrupt(undefined, "/root/worker");
	await coordinator.followUp(undefined, "/root/worker", "continue initial");
	expect(starts).toBe(1);
	expect(prompts).toEqual([]);

	initial.resolve({ responseText: "partial", session, runtime } as never);
	await flushPromises();
	expect(prompts).toEqual(["continue initial"]);

	await coordinator.interrupt(undefined, "/root/worker");
	await coordinator.followUp(undefined, "/root/worker", "continue resumed");
	expect(prompts).toEqual(["continue initial"]);

	turns[0]?.resolve();
	await flushPromises();
	expect(prompts).toEqual(["continue initial", "continue resumed"]);
	removeRootCoordinator(rootId);
});

test("restores persisted fields without spreading live-only keys into agent state", () => {
	const saved = {
		id: "/root/worker",
		parentId: "/root",
		cwd: "/tmp/work",
		description: "worker",
		status: "idle",
		message: "work",
		startedAt: 1,
		completedAt: 2,
		toolUses: 0,
		cost: 0,
		tokenCount: 0,
		compactions: 0,
		transcriptGeneration: 0,
		session: { state: { messages: [{ role: "user", content: "injected" }] } },
		latestInnerTool: "injected-tool",
	};
	const coordinator = new SubagentCoordinator("root");
	coordinator.restore({ version: 1, agents: [saved] } as never);
	expect(coordinator.snapshot()[0]?.transcriptAvailable).toBe(false);
	expect(coordinator.transcript("/root/worker")?.getMessages()).toEqual([]);
});

test("persists a requested role separately from its effective fallback and requests it after restore", async () => {
	const session = fakeSession([], []);
	const runtime = { session, dispose: async () => {} } as never;
	const firstRun: CoordinatorOptions["run"] = ((_ctx: object, _message: string, options: object) => {
		const callbacks = options as {
			onRuntimeResolved(role: { name: string; color: string }): void;
			onRuntimeCreated(runtime: never): void;
			onSessionCreated(session: never): void;
		};
		callbacks.onRuntimeResolved({ name: "fallback", color: "blue" });
		callbacks.onRuntimeCreated(runtime);
		callbacks.onSessionCreated(session);
		return Promise.resolve({ responseText: "done", session, runtime });
	}) as never;
	const rootId = "requested-role-root";
	const coordinator = createRootCoordinator(rootId, { run: firstRun });
	coordinator.spawn(undefined, { ...request("worker"), agentConfig: { role: "requested" } });
	await flushPromises();
	const saved = coordinator.persistedAgent("/root/worker");
	expect(saved?.requestedRole).toBe("requested");
	expect(saved?.modelRole?.name).toBe("fallback");

	let restoredRole: string | undefined;
	const restoredRun: CoordinatorOptions["run"] = ((_ctx: object, _message: string, options: object) => {
		restoredRole = (options as { agentConfig: { role?: string } }).agentConfig.role;
		return new Promise(() => undefined);
	}) as never;
	const restored = new SubagentCoordinator("restored", { run: restoredRun });
	restored.restore({ version: 1, agents: [saved!] }, { ctx: request("worker").ctx, pi: {} as never });
	await restored.followUp(undefined, "/root/worker", "try again");
	expect(restoredRole).toBe("requested");
	restored.dispose();
	removeRootCoordinator(rootId);
});
