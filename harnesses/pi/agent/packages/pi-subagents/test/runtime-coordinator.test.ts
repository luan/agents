import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_HIERARCHY, type SessionHierarchyEntry } from "../src/protocol/session-hierarchy.ts";
import {
	type CoordinatorOptions,
	createRootCoordinator,
	removeRootCoordinator,
	SubagentCoordinator,
	type SubagentTreeCheckpoint,
	subagentSessionDir,
} from "../src/runtime/coordinator.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
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
		sendCustomMessage: (message: { content: string }, options?: { triggerTurn?: boolean }) => {
			prompts.push(message.content);
			if (!options?.triggerTurn) return Promise.resolve();
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
	expect(() => coordinator.spawn(undefined, request("side"))).toThrow("reserved");
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

test("can retain a successful session without delivering its final response", async () => {
	const session = fakeSession([], []);
	const runtime = { session, dispose: async () => {} } as never;
	const run: CoordinatorOptions["run"] = ((_ctx: object, _message: string, options: object) => {
		const callbacks = options as {
			onRuntimeCreated(runtime: never): void;
			onSessionCreated(session: never): void;
		};
		callbacks.onRuntimeCreated(runtime);
		callbacks.onSessionCreated(session);
		return Promise.resolve({ responseText: "side result", session, runtime });
	}) as never;
	const coordinator = createRootCoordinator("retained-root", { maxConcurrency: 2, run });
	coordinator.spawn(undefined, { ...request("retained"), completionDelivery: "none" });
	await flushPromises();

	expect(coordinator.snapshot().find(({ id }) => id === "/root/retained")?.status).toBe("idle");
	expect(coordinator.drainMailbox("/root")).toEqual([]);
	expect(coordinator.persistedAgent("/root/retained")?.completionDelivery).toBe("none");
	const restored = new SubagentCoordinator("restored-retained");
	restored.restore({ version: 1, agents: coordinator.checkpoint().agents });
	expect(restored.persistedAgent("/root/retained")?.completionDelivery).toBe("none");
	restored.dispose();
	coordinator.dispose();
	removeRootCoordinator("retained-root");
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

test.each([
	["resolve", "resolve"],
	["resolve", "reject"],
	["reject", "resolve"],
	["reject", "reject"],
] as const)(
	"serializes post-interrupt follow-ups when initial turn %ss and resumed turn %ss",
	async (initialResult, resumedResult) => {
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

		if (initialResult === "resolve") initial.resolve({ responseText: "partial", session, runtime } as never);
		else initial.reject(new Error("interrupted startup"));
		await flushPromises();
		expect(prompts).toEqual([
			"Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\ncontinue initial",
		]);

		await coordinator.interrupt(undefined, "/root/worker");
		await coordinator.followUp(undefined, "/root/worker", "continue resumed");
		expect(prompts).toEqual([
			"Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\ncontinue initial",
		]);

		if (resumedResult === "resolve") turns[0]?.resolve();
		else turns[0]?.reject(new Error("interrupted resume"));
		await flushPromises();
		expect(prompts).toEqual([
			"Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\ncontinue initial",
			"Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\ncontinue resumed",
		]);
		removeRootCoordinator(rootId);
	},
);

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

test("persists model and thinking-level overrides and requests them after restore", async () => {
	const session = fakeSession([], []);
	const runtime = { session, dispose: async () => {} } as never;
	const firstRun: CoordinatorOptions["run"] = ((_ctx: object, _message: string, options: object) => {
		const callbacks = options as {
			onRuntimeCreated(runtime: never): void;
			onSessionCreated(session: never): void;
		};
		callbacks.onRuntimeCreated(runtime);
		callbacks.onSessionCreated(session);
		return Promise.resolve({ responseText: "done", session, runtime });
	}) as never;
	const rootId = "requested-model-root";
	const coordinator = createRootCoordinator(rootId, { run: firstRun });
	coordinator.spawn(undefined, {
		...request("worker"),
		agentConfig: {
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		},
	});
	await flushPromises();
	const saved = coordinator.persistedAgent("/root/worker");
	expect(saved?.model).toEqual({ provider: "openai", id: "gpt-5" });
	expect(saved?.thinkingLevel).toBe("high");

	let restoredConfig: object | undefined;
	const restoredRun: CoordinatorOptions["run"] = ((_ctx: object, _message: string, options: object) => {
		restoredConfig = (options as { agentConfig: object }).agentConfig;
		return new Promise(() => undefined);
	}) as never;
	const restored = new SubagentCoordinator("restored-model", { run: restoredRun });
	restored.restore({ version: 1, agents: [saved!] }, { ctx: request("worker").ctx, pi: {} as never });
	await restored.followUp(undefined, "/root/worker", "try again");
	expect(restoredConfig).toEqual({
		model: { provider: "openai", id: "gpt-5" },
		thinkingLevel: "high",
	});
	restored.dispose();
	removeRootCoordinator(rootId);
});

test("ignores obsolete role fields when restoring old checkpoints", () => {
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
		requestedRole: "tiny",
		modelRole: { name: "tiny", color: "cyan" },
		transcriptGeneration: 0,
	};
	const coordinator = new SubagentCoordinator("old-checkpoint");
	coordinator.restore({ version: 1, agents: [saved] } as never);
	expect(coordinator.persistedAgent("/root/worker")).not.toHaveProperty("requestedRole");
	expect(coordinator.persistedAgent("/root/worker")).not.toHaveProperty("modelRole");
	coordinator.dispose();
});

test("late callbacks cannot change a settled turn", async () => {
	const session = fakeSession([], []);
	const runtime = { session, dispose: async () => {} } as never;
	let callbacks: Parameters<NonNullable<CoordinatorOptions["run"]>>[2] | undefined;
	const coordinator = createRootCoordinator("late-callbacks", {
		run: async (_ctx, _message, options) => {
			callbacks = options;
			options.onRuntimeCreated?.(runtime);
			options.onSessionCreated?.(session);
			return { responseText: "done", session, runtime };
		},
	});
	try {
		coordinator.spawn(undefined, request("worker"));
		await flushPromises();
		const settled = coordinator.snapshot();
		callbacks?.onToolActivity?.({ type: "start", toolName: "late-tool" });
		callbacks?.onRuntimeResolved?.({ model: { provider: "late", id: "model" } });
		expect(coordinator.snapshot()).toEqual(settled);
	} finally {
		removeRootCoordinator("late-callbacks");
	}
});

test("disposes a runtime once when creation finishes after coordinator shutdown", async () => {
	const session = fakeSession([], []);
	let disposals = 0;
	const runtime = {
		session,
		dispose: async () => {
			disposals++;
		},
	} as never;
	const created = deferred<void>();
	const finished = deferred<void>();
	const coordinator = new SubagentCoordinator("late-runtime", {
		run: async (_ctx, _message, options) => {
			await created.promise;
			expect(options.signal?.aborted).toBe(true);
			options.onRuntimeCreated?.(runtime);
			options.onSessionCreated?.(session);
			await finished.promise;
			return { responseText: "late result", session, runtime };
		},
	});
	coordinator.spawn(undefined, request("worker"));
	coordinator.dispose();
	created.resolve();
	await flushPromises();
	expect(disposals).toBe(1);
	finished.resolve();
	await flushPromises();
	expect(disposals).toBe(1);
	expect(coordinator.snapshot()).toEqual([]);
	expect(coordinator.drainMailbox("/root")).toEqual([]);
});

test("retry after failed startup creates a runtime instead of resuming a disposed session", async () => {
	const prompts: string[] = [];
	const session = fakeSession(prompts, []);
	let starts = 0;
	let disposals = 0;
	const runtime = {
		session,
		dispose: async () => {
			disposals++;
		},
	} as never;
	const coordinator = createRootCoordinator("retry-startup", {
		run: async (_ctx, _message, options) => {
			starts++;
			if (starts === 1) {
				options.onRuntimeCreated?.(runtime);
				options.onSessionCreated?.(session);
				throw new Error("startup failed");
			}
			return new Promise(() => undefined);
		},
	});
	try {
		coordinator.spawn(undefined, request("worker"));
		await flushPromises();
		expect(coordinator.snapshot()[0]?.status).toBe("failed");
		expect(disposals).toBe(1);
		await coordinator.followUp(undefined, "/root/worker", "retry");
		expect(starts).toBe(2);
		expect(prompts).toEqual([]);
	} finally {
		removeRootCoordinator("retry-startup");
	}
});

test.each(["before", "during"] as const)(
	"coordinator disposal %s a mailbox wait settles it immediately",
	async (when) => {
		const coordinator = new SubagentCoordinator("wait-shutdown");
		const cancellation = new AbortController();
		if (when === "before") coordinator.dispose();
		let settled = false;
		const waiting = coordinator.waitForUpdate(cancellation.signal).then((event) => {
			settled = true;
			return event;
		});
		try {
			if (when === "during") coordinator.dispose();
			await flushPromises();
			expect(settled).toBe(true);
			expect(await waiting).toBeUndefined();
		} finally {
			cancellation.abort();
			await waiting;
			coordinator.dispose();
		}
	},
);

test("a disposed coordinator rejects new work", async () => {
	const coordinator = new SubagentCoordinator("disposed", { maxConcurrency: 1 });
	coordinator.dispose();
	expect(() => coordinator.spawn(undefined, request("worker"))).toThrow("disposed");
	await expect(coordinator.sendMessage(undefined, "/root", "late")).rejects.toThrow("disposed");
	expect(() => coordinator.restore({ version: 1, agents: [] })).toThrow("disposed");
	expect(coordinator.snapshot()).toEqual([]);
	expect(coordinator.drainMailbox("/root")).toEqual([]);
});

test("a cancelled spawn request does not register queued work", () => {
	const coordinator = new SubagentCoordinator("cancel-spawn", { maxConcurrency: 1 });
	const signal = AbortSignal.abort(new Error("spawn cancelled"));
	try {
		expect(() => coordinator.spawn(undefined, { ...request("worker"), signal })).toThrow("spawn cancelled");
		expect(coordinator.snapshot()).toEqual([]);
	} finally {
		coordinator.dispose();
	}
});
