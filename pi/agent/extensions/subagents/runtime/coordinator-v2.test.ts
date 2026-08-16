import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createRootCoordinator,
	getCoordinatorForSession,
	latestSubagentTreeCheckpoint,
	loadSubagentConfig,
	removeRootCoordinator,
	SUBAGENT_STATE_ENTRY_TYPE,
	SubagentCoordinator,
} from "./coordinator";

const request = (taskName: string) => ({
	taskName,
	message: `do ${taskName}`,
	pi: {} as never,
	ctx: {
		sessionManager: {
			getEntries: () => [],
			getLeafId: () => undefined,
			getSessionDir: () => "/tmp/root-session",
		},
	} as never,
	agentConfig: {},
});

test("registers nested canonical paths and resolves exact targets", () => {
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 1 });
	expect(coordinator.spawn(undefined, request("parent"))).toBe("/root/parent");
	expect(coordinator.spawn("/root/parent", request("child"))).toBe("/root/parent/child");
	expect(coordinator.resolve("/root/parent", "child")).toBe("/root/parent/child");
	expect(coordinator.resolve(undefined, "/root/parent/child")).toBe("/root/parent/child");
	expect(coordinator.resolve(undefined, "/root/parent/ch")).toBeUndefined();
});

test("returns immutable snapshots and publishes lifecycle events", () => {
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 1 });
	const events: string[] = [];
	coordinator.subscribe((event) => events.push(event.type));
	coordinator.spawn(undefined, request("worker"));
	const snapshot = coordinator.snapshot();
	expect(Object.isFrozen(snapshot)).toBe(true);
	expect(Object.isFrozen(snapshot[0])).toBe(true);
	expect(events).toEqual(["spawned"]);
});

test("queues root messages without starting a turn", async () => {
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 1 });
	expect(await coordinator.sendMessage("/root/child", "/root", "result")).toBe(true);
	expect(coordinator.drainRootMessages()).toEqual([{ sender: "/root/child", message: "result" }]);
	expect(coordinator.drainRootMessages()).toEqual([]);
});

test("mailbox wait wakes for messages", async () => {
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 1 });
	coordinator.spawn(undefined, request("worker"));
	const waiting = coordinator.waitForUpdate(undefined, 1_000);
	await coordinator.sendMessage("/root/worker", "/root", "result");
	expect(await waiting).toEqual({ type: "message", target: "/root", sender: "/root/worker" });
});

test("enforces caller depth", () => {
	const depth = new SubagentCoordinator("root", { maxConcurrency: 1, maxDepth: 2 });
	expect(() => depth.spawn("/root/a/b", request("too-deep"))).toThrow("Agent depth limit 2");
});

test("root directory does not leak coordinators after removal", () => {
	const coordinator = createRootCoordinator("directory-root", { maxConcurrency: 1 });
	expect(coordinator.rootSessionId).toBe("directory-root");
	removeRootCoordinator("directory-root");
	expect(getCoordinatorForSession("directory-root")).toBeUndefined();
});

test("runs seven subagents beside the root and queues the eighth", () => {
	const started: string[] = [];
	const run = ((_ctx: unknown, message: string) => {
		started.push(message);
		return new Promise(() => undefined);
	}) as never;
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 8, run });
	for (let index = 1; index <= 8; index++) coordinator.spawn(undefined, request(`worker-${index}`));
	expect(started).toHaveLength(7);
	expect(coordinator.snapshot().find((agent) => agent.id === "/root/worker-8")?.status).toBe("queued");
	coordinator.dispose();
});

test("interrupts a queued turn and keeps the agent address", async () => {
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 1 });
	coordinator.spawn(undefined, request("worker"));
	expect(await coordinator.interrupt(undefined, "worker")).toBe("queued");
	expect(coordinator.snapshot()[0]?.status).toBe("interrupted");
});

test("follow-up restarts an interrupted queued agent without a session", async () => {
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 1 });
	coordinator.spawn(undefined, request("worker"));
	await coordinator.interrupt(undefined, "worker");

	await coordinator.followUp(undefined, "worker", "retry");

	expect(coordinator.snapshot()[0]?.status).toBe("queued");
	coordinator.dispose();
});

test("waits for an interrupted turn to settle before restarting it", async () => {
	const pending: Array<(result: unknown) => void> = [];
	const run = (() => new Promise((resolve) => pending.push(resolve))) as never;
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 2, run });
	coordinator.spawn(undefined, request("worker"));
	await coordinator.interrupt(undefined, "worker");
	await coordinator.followUp(undefined, "worker", "retry");
	const session = {
		state: { messages: [] },
		sessionManager: { getSessionId: () => "child-session" },
		subscribe: () => () => {},
		getSessionStats: () => ({ tokens: { total: 0 } }),
	};
	let staleDisposals = 0;

	expect(pending).toHaveLength(1);
	expect(coordinator.snapshot()[0]?.status).toBe("queued");
	pending[0]?.({
		responseText: "stale",
		session,
		runtime: { dispose: async () => staleDisposals++ },
	});
	await Promise.resolve();
	expect(pending).toHaveLength(2);
	expect(coordinator.snapshot()[0]?.status).toBe("running");
	expect(staleDisposals).toBe(1);

	pending[1]?.({ responseText: "fresh", session, runtime: { dispose: async () => undefined } });
	await Promise.resolve();
	expect(coordinator.snapshot()[0]).toMatchObject({ status: "idle", result: "fresh" });
});

test("disposes a completed child runtime with the coordinator", async () => {
	let disposals = 0;
	const session = {
		state: { messages: [] },
		sessionManager: { getSessionId: () => "child-session" },
		subscribe: () => () => {},
		getSessionStats: () => ({ tokens: { total: 0 } }),
	};
	const run = (() =>
		Promise.resolve({
			responseText: "done",
			session,
			runtime: { dispose: async () => disposals++ },
		})) as never;
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 2, run });
	coordinator.spawn(undefined, request("worker"));
	await Promise.resolve();
	await Promise.resolve();

	coordinator.dispose();

	expect(disposals).toBe(1);
});

test("disposes a child runtime when its initial turn rejects", async () => {
	let disposals = 0;
	const run = ((_ctx: unknown, _message: string, options: { onRuntimeCreated(runtime: unknown): void }) => {
		options.onRuntimeCreated({ dispose: async () => disposals++ });
		return Promise.reject(new Error("turn failed"));
	}) as never;
	const coordinator = new SubagentCoordinator("root", { maxConcurrency: 2, run });
	coordinator.spawn(undefined, request("worker"));
	await Promise.resolve();
	await Promise.resolve();

	expect(coordinator.snapshot()[0]?.status).toBe("failed");
	expect(disposals).toBe(1);
});

test("builds nested session paths from the root session directory", () => {
	const sessionDirs: string[] = [];
	const run = ((_ctx: unknown, _message: string, options: { sessionDir: string }) => {
		sessionDirs.push(options.sessionDir);
		return new Promise(() => undefined);
	}) as never;
	const coordinator = new SubagentCoordinator("root", {
		maxConcurrency: 3,
		rootSessionDir: "/tmp/root-session",
		run,
	});
	coordinator.spawn(undefined, request("parent"));
	coordinator.spawn("/root/parent", {
		...request("child"),
		ctx: {
			sessionManager: {
				getEntries: () => [],
				getLeafId: () => undefined,
				getSessionDir: () => "/tmp/root-session/subagents/parent",
			},
		} as never,
	});

	expect(sessionDirs).toEqual(["/tmp/root-session/subagents/parent", "/tmp/root-session/subagents/parent/child"]);
	coordinator.dispose();
});
test("keeps a completed in-process transcript available", async () => {
	const session = {
		state: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		sessionManager: { getSessionId: () => "child-session" },
		subscribe: () => () => {},
		getSessionStats: () => ({ tokens: { total: 0 } }),
	};
	const run = (() => Promise.resolve({ responseText: "done", session, runtime: {} })) as never;
	const coordinator = createRootCoordinator("transcript-root", { maxConcurrency: 2, run });
	const id = coordinator.spawn(undefined, request("worker"));
	await Promise.resolve();
	await Promise.resolve();
	expect(coordinator.snapshot()[0]?.transcriptAvailable).toBe(true);
	expect(coordinator.transcript(id)?.getMessages()).toEqual(session.state.messages);
	removeRootCoordinator("transcript-root");
});

test("restores branch-scoped agent history and exact transcripts", () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "subagent-history-"));
	const transcript = SessionManager.create(process.cwd(), sessionDir);
	transcript.appendMessage({ role: "user", content: "restored message", timestamp: 1 });
	transcript.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "restored result" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const checkpoint = {
		version: 1 as const,
		agents: [
			{
				id: "/root/worker",
				cwd: process.cwd(),
				description: "worker",
				status: "running" as const,
				message: "work",
				startedAt: 1,
				toolUses: 2,
				cost: 0.01,
				tokenCount: 50,
				compactions: 0,
				transcriptFile: transcript.getSessionFile()!,
				transcriptGeneration: 0,
			},
		],
	};
	transcript.appendCustomEntry(SUBAGENT_STATE_ENTRY_TYPE, { version: 1, agent: checkpoint.agents[0] });
	const clonedFile = transcript.createBranchedSession(transcript.getLeafId()!)!;
	const cloned = SessionManager.open(clonedFile);
	const restored = latestSubagentTreeCheckpoint(cloned.getBranch());
	expect(restored).toEqual(checkpoint);

	const coordinator = new SubagentCoordinator("resumed-root", { maxConcurrency: 1 });
	coordinator.restore(restored!);
	expect(coordinator.snapshot()[0]).toMatchObject({
		id: "/root/worker",
		rootSessionId: "resumed-root",
		status: "interrupted",
	});
	expect(coordinator.checkpoint().agents[0]?.status).toBe("interrupted");
	expect(coordinator.transcript("/root/worker")?.getMessages()[0]).toEqual({
		role: "user",
		content: "restored message",
		timestamp: 1,
	});
});

test("continues restored history in a copy-on-write child session", async () => {
	let prompt = "";
	let forkedHistory: readonly unknown[] = [];
	const sessionDir = mkdtempSync(join(tmpdir(), "subagent-followup-"));
	const transcript = SessionManager.create(process.cwd(), sessionDir);
	transcript.appendMessage({ role: "user", content: "original task", timestamp: 1 });
	transcript.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "original result" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const run = ((_ctx: unknown, nextPrompt: string, options: { forkedHistory?: readonly unknown[] }) => {
		prompt = nextPrompt;
		forkedHistory = options.forkedHistory ?? [];
		return new Promise(() => undefined);
	}) as never;
	const runtime = request("worker");
	const coordinator = new SubagentCoordinator("resumed-root", { maxConcurrency: 2, run });
	coordinator.restore(
		{
			version: 1,
			agents: [
				{
					id: "/root/worker",
					cwd: process.cwd(),
					description: "worker",
					status: "idle",
					message: "original task",
					startedAt: 1,
					toolUses: 0,
					cost: 0,
					tokenCount: 0,
					compactions: 0,
					transcriptFile: transcript.getSessionFile()!,
					transcriptGeneration: 0,
				},
			],
		},
		{ pi: runtime.pi, ctx: runtime.ctx },
	);
	await coordinator.followUp(undefined, "worker", "continue here");
	expect(prompt).toBe("continue here");
	expect(forkedHistory[0]).toEqual({ role: "user", content: "original task", timestamp: 1 });
	expect(coordinator.snapshot()[0]?.status).toBe("running");
	coordinator.dispose();
});

test("reports provider cost and the latest transcript item", async () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "Work is complete.\nThe result is ready." }],
		usage: { cost: { total: 0.0042 } },
	};
	const session = {
		state: { messages: [assistant] },
		sessionManager: { getSessionId: () => "summary-session" },
		subscribe: (listener: (event: unknown) => void) => {
			listener({ type: "message_end", message: assistant });
			return () => {};
		},
		getSessionStats: () => ({ tokens: { total: 0 } }),
	};
	const run = ((_ctx: unknown, _message: string, options: { onSessionCreated(session: unknown): void }) => {
		options.onSessionCreated(session);
		return Promise.resolve({ responseText: "done", session, runtime: {} });
	}) as never;
	const coordinator = createRootCoordinator("summary-root", { maxConcurrency: 2, run });
	const id = coordinator.spawn(undefined, request("worker"));
	await Promise.resolve();
	await Promise.resolve();
	expect(coordinator.snapshot()[0]?.cost).toBe(0.0042);
	expect(coordinator.transcript(id)?.preview()).toEqual({
		kind: "assistant",
		text: "Work is complete. The result is ready.",
	});
	removeRootCoordinator("summary-root");
});

test("loads and validates subagents.json", () => {
	const directory = mkdtempSync(join(tmpdir(), "subagents-config-"));
	writeFileSync(join(directory, "subagents.json"), JSON.stringify({ maxConcurrency: 6, maxDepth: 3 }));
	expect(loadSubagentConfig(directory)).toEqual({ maxConcurrency: 6, maxDepth: 3 });
	writeFileSync(join(directory, "subagents.json"), JSON.stringify({ maxConcurrency: 0 }));
	expect(() => loadSubagentConfig(directory)).toThrow("maxConcurrency must be an integer >= 1");
});
