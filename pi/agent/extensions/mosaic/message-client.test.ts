import { describe, expect, test } from "bun:test";
import { deliverMosaicMailboxMessages, MosaicMessageClient } from "./message-client";
import { MosaicMessageServer, startMosaicMessageTransport } from "./message-server";

describe("MosaicMessageClient", () => {
	test("connects, drains messages, sends updates, and disconnects over the transport", async () => {
		const server = new MosaicMessageServer({ now: () => 1000, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		const transport = await startMosaicMessageTransport(server, { host: "127.0.0.1", port: 0 });
		const client = new MosaicMessageClient({ endpoint: transport.endpoint, agentId: "agent-1", token });
		try {
			await expect(client.connect()).resolves.toMatchObject({ connected: true });
			server.enqueueMessage("reviewer", { body: "Queued note", triggerTurn: false });
			server.enqueueMessage("reviewer", { body: "Do this now", triggerTurn: true });

			await expect(client.drainMessages()).resolves.toMatchObject([
				{ body: "Queued note", triggerTurn: false },
				{ body: "Do this now", triggerTurn: true },
			]);
			const drained = await client.drainMessages();
			await expect(client.ackMessages(drained.map((message) => message.id))).resolves.toEqual({ acknowledged: 2 });
			await expect(client.drainMessages()).resolves.toEqual([]);
			await expect(client.recordUpdate({ status: "running", activity: "working" })).resolves.toMatchObject({
				status: "running",
				activity: "working",
			});
			await expect(client.sendLeaderMessage("please clean up")).resolves.toMatchObject({
				type: "agent_message",
				from: "agent-1",
				to: "leader",
				body: "please clean up",
			});
			await expect(client.disconnect()).resolves.toMatchObject({ status: "disconnected" });
		} finally {
			await transport.close();
		}
	});

	test("delivers queued and trigger-turn messages without terminal key-sending", async () => {
		const sent: { message: string; options: unknown }[] = [];
		const client = {
			drainMessages: async () => [
				{ id: "1", body: "Remember this", triggerTurn: false },
				{ id: "2", body: "Run this", triggerTurn: true },
			],
			ackMessages: async (ids: string[]) => {
				expect(ids).toEqual(["1", "2"]);
			},
		};

		await deliverMosaicMailboxMessages(client, {
			sendUserMessage: (message: string, options?: unknown) => {
				sent.push({ message, options });
			},
		});

		expect(sent).toEqual([
			{ message: "Remember this", options: { deliverAs: "followUp" } },
			{ message: "Run this", options: { deliverAs: "followUp", triggerTurn: true } },
		]);
	});
});
