import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { MosaicMessageServer, startMosaicMessageTransport } from "./message-server";

describe("MosaicMessageServer", () => {
	test("registers an agent with a token and rejects stale connections", () => {
		const server = new MosaicMessageServer({ now: () => 1000, id: () => "msg-1" });
		const registration = server.registerAgent({
			agentId: "agent-1",
			taskName: "reviewer",
			type: "Explore",
			description: "Review code",
		});

		expect(registration.agentId).toBe("agent-1");
		expect(registration.token).toHaveLength(32);
		expect(server.connectAgent("agent-1", registration.token).connected).toBe(true);
		expect(() => server.connectAgent("agent-1", "bad-token")).toThrow("invalid token");
	});

	test("enqueues queue-only and trigger-turn messages as typed mailbox data", () => {
		const server = new MosaicMessageServer({ now: () => 2000, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		server.connectAgent("agent-1", token);

		const queued = server.enqueueMessage("reviewer", { body: "Read but do not act yet.", triggerTurn: false });
		const followup = server.enqueueMessage("agent-1", { body: "Stop and report.", triggerTurn: true });

		expect(queued).toMatchObject({
			id: "msg-1",
			seq: 2,
			from: "leader",
			to: "agent-1",
			kind: "message",
			body: "Read but do not act yet.",
			triggerTurn: false,
			createdAt: 2000,
		});
		expect(followup).toMatchObject({
			seq: 3,
			kind: "followup_task",
			triggerTurn: true,
		});
		expect(server.drainMessages("agent-1", token).map((message) => message.body)).toEqual([
			"Read but do not act yet.",
			"Stop and report.",
		]);
		server.ackMessages("agent-1", token, [queued.id, followup.id]);
		expect(server.drainMessages("agent-1", token)).toEqual([]);
	});

	test("allows task name reuse after close or launch rollback", () => {
		const server = new MosaicMessageServer({ now: () => 2500, id: () => "msg-1" });
		server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		server.closeAgent("reviewer");
		expect(() => server.registerAgent({ agentId: "agent-2", taskName: "reviewer" })).not.toThrow();

		server.registerAgent({ agentId: "agent-3", taskName: "writer" });
		server.removeAgent("agent-3");
		expect(() => server.registerAgent({ agentId: "agent-4", taskName: "writer" })).not.toThrow();
	});

	test("waits for monotonic mailbox or status updates", async () => {
		const server = new MosaicMessageServer({ now: () => 3000, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		server.connectAgent("agent-1", token);
		const before = server.currentSeq;

		const pending = server.waitForUpdate({ afterSeq: before, timeoutMs: 1000 });
		const status = server.recordAgentUpdate("agent-1", token, {
			status: "running",
			activity: "reading files",
		});

		await expect(pending).resolves.toMatchObject({
			seq: status.seq,
			agentId: "agent-1",
			type: "agent_update",
			status: "running",
			activity: "reading files",
		});
	});

	test("records child-to-leader messages without changing agent status", () => {
		const server = new MosaicMessageServer({ now: () => 3500, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		server.connectAgent("agent-1", token);
		server.recordAgentUpdate("agent-1", token, { status: "completed", result: "done" });
		const before = server.currentSeq;

		const message = server.recordLeaderMessage("agent-1", token, "please clean up my pane");

		expect(message).toMatchObject({
			type: "agent_message",
			seq: before + 1,
			from: "agent-1",
			to: "leader",
			body: "please clean up my pane",
		});
		expect(server.listAgents()[0]).toMatchObject({ status: "completed" });
	});

	test("ignores stale child progress updates after completion", async () => {
		const server = new MosaicMessageServer({ now: () => 3750, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		server.connectAgent("agent-1", token);

		const completed = server.recordAgentUpdate("agent-1", token, { status: "completed", result: "done" });
		const afterCompleted = server.currentSeq;
		const stale = server.recordAgentUpdate("agent-1", token, {
			status: "running",
			activity: "writing",
			result: "done",
		});
		const disconnect = server.disconnectAgent("agent-1", token);

		expect(stale).toMatchObject({ seq: completed.seq, status: "completed", result: "done" });
		expect(disconnect).toMatchObject({ seq: completed.seq, status: "completed", result: "done" });
		expect(server.currentSeq).toBe(afterCompleted);
		expect(server.listAgents()[0]).toMatchObject({
			connected: false,
			status: "completed",
			lastSeq: completed.seq,
		});
		await expect(server.waitForUpdate({ afterSeq: afterCompleted, timeoutMs: 1 })).resolves.toBeUndefined();
	});

	test("coalesces repeated writing progress while still emitting completion", async () => {
		const server = new MosaicMessageServer({ now: () => 3850, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		server.connectAgent("agent-1", token);

		const firstWriting = server.recordAgentUpdate("agent-1", token, {
			status: "running",
			activity: "writing",
			result: "M",
		});
		const afterFirstWriting = server.currentSeq;
		const secondWriting = server.recordAgentUpdate("agent-1", token, {
			status: "running",
			activity: "writing",
			result: "MOSAIC",
		});

		expect(secondWriting).toMatchObject({ seq: firstWriting.seq, status: "running", activity: "writing" });
		expect(secondWriting.result).toBe("MOSAIC");
		expect(server.currentSeq).toBe(afterFirstWriting);
		expect(server.listAgents()[0]).not.toHaveProperty("lastUpdate");
		await expect(server.waitForUpdate({ afterSeq: afterFirstWriting, timeoutMs: 1 })).resolves.toBeUndefined();

		const completed = server.recordAgentUpdate("agent-1", token, { status: "completed", result: "MOSAIC_DONE" });
		await expect(server.waitForUpdate({ afterSeq: afterFirstWriting, timeoutMs: 1 })).resolves.toMatchObject({
			seq: completed.seq,
			status: "completed",
			result: "MOSAIC_DONE",
		});
	});

	test("notifies listeners only for recorded updates", () => {
		const server = new MosaicMessageServer({ now: () => 3900, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		server.connectAgent("agent-1", token);
		const updates: unknown[] = [];
		server.onUpdate((update) => updates.push(update));

		const firstWriting = server.recordAgentUpdate("agent-1", token, {
			status: "running",
			activity: "writing",
			result: "M",
		});
		server.recordAgentUpdate("agent-1", token, {
			status: "running",
			activity: "writing",
			result: "MOSAIC",
		});
		const completed = server.recordAgentUpdate("agent-1", token, { status: "completed", result: "MOSAIC_DONE" });

		expect(updates).toEqual([firstWriting, completed]);
	});

	test("closes and disconnects agents with observable update records", () => {
		const server = new MosaicMessageServer({ now: () => 4000, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		server.connectAgent("agent-1", token);

		const disconnect = server.disconnectAgent("agent-1", token);
		const close = server.closeAgent("agent-1", "done");

		expect(disconnect).toMatchObject({ type: "agent_update", status: "disconnected" });
		expect(close).toMatchObject({ type: "agent_update", status: "closed", result: "done" });
		expect(server.listAgents()[0]).toMatchObject({
			agentId: "agent-1",
			connected: false,
			closed: true,
			status: "closed",
		});
	});

	test("serves child mailbox requests over a local JSONL pipe", async () => {
		const mailbox = new MosaicMessageServer({ now: () => 5000, id: () => "msg-1" });
		const { token } = mailbox.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		const transport = await startMosaicMessageTransport(mailbox, { host: "127.0.0.1", port: 0 });
		try {
			await expect(
				request(transport.endpoint, {
					id: "connect-1",
					method: "connect",
					agentId: "agent-1",
					token,
				}),
			).resolves.toMatchObject({ id: "connect-1", ok: true, data: { connected: true } });

			mailbox.enqueueMessage("reviewer", { body: "Native delivery", triggerTurn: true });

			await expect(
				request(transport.endpoint, {
					id: "drain-1",
					method: "drain",
					agentId: "agent-1",
					token,
				}),
			).resolves.toMatchObject({
				id: "drain-1",
				ok: true,
				data: [{ body: "Native delivery", triggerTurn: true }],
			});
			await expect(
				request(transport.endpoint, {
					id: "ack-1",
					method: "ack",
					agentId: "agent-1",
					token,
					messageIds: ["msg-1"],
				}),
			).resolves.toMatchObject({ id: "ack-1", ok: true, data: { acknowledged: 1 } });

			await expect(
				request(transport.endpoint, {
					id: "update-1",
					method: "update",
					agentId: "agent-1",
					token,
					update: { status: "running", activity: "processing native message" },
				}),
			).resolves.toMatchObject({
				id: "update-1",
				ok: true,
				data: { type: "agent_update", status: "running", activity: "processing native message" },
			});

			await expect(
				request(transport.endpoint, {
					id: "bad-1",
					method: "drain",
					agentId: "agent-1",
					token: "bad-token",
				}),
			).resolves.toMatchObject({ id: "bad-1", ok: false, error: expect.stringContaining("invalid token") });
			await expect(
				request(transport.endpoint, {
					id: "unknown-1",
					method: "unknown",
					agentId: "agent-1",
					token,
				}),
			).resolves.toMatchObject({ id: "unknown-1", ok: false, error: expect.stringContaining("unknown") });
		} finally {
			await transport.close();
		}
	});

	test("does not crash when a child socket resets", async () => {
		const mailbox = new MosaicMessageServer();
		const transport = await startMosaicMessageTransport(mailbox, { host: "127.0.0.1", port: 0 });
		try {
			await new Promise<void>((resolve, reject) => {
				const url = new URL(transport.endpoint);
				const socket = connect({ host: url.hostname, port: Number(url.port) });
				socket.on("connect", () => {
					socket.write("{");
					socket.destroy();
					resolve();
				});
				socket.on("error", reject);
			});
		} finally {
			await transport.close();
		}
	});
});

function request(endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	const url = new URL(endpoint);
	return new Promise((resolve, reject) => {
		const socket = connect({ host: url.hostname, port: Number(url.port) });
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			socket.end();
			resolve(JSON.parse(line));
		});
		socket.on("error", reject);
	});
}
