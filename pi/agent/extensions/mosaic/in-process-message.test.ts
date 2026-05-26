import { describe, expect, test } from "bun:test";
import { deliverInProcessMessage } from "./in-process-message";

describe("deliverInProcessMessage", () => {
	test("steers a running in-process agent session", async () => {
		const steers: string[] = [];
		const result = await deliverInProcessMessage(
			{
				id: "agent-1",
				description: "review/probe",
				status: "running",
				session: {
					steer: async (message: string) => {
						steers.push(message);
					},
				},
			},
			{ message: "act now", triggerTurn: true },
		);

		expect(steers).toEqual(["act now"]);
		expect(result).toEqual({
			agentId: "agent-1",
			taskName: "review/probe",
			runtime: "in-process",
			deliveredAs: "steer",
			queued: false,
			triggerTurn: true,
		});
	});

	test("queues steers before the in-process session exists", async () => {
		const record = {
			id: "agent-1",
			description: "review/probe",
			status: "queued",
			pendingSteers: undefined as string[] | undefined,
		};

		const result = await deliverInProcessMessage(record, { message: "remember this", triggerTurn: false });

		expect(record.pendingSteers).toEqual(["remember this"]);
		expect(result).toMatchObject({
			agentId: "agent-1",
			deliveredAs: "steer",
			queued: true,
			triggerTurn: true,
			note: "in-process agents do not support mailbox-only delivery; delivered as a steer",
		});
	});

	test("rejects terminal in-process agents", async () => {
		await expect(
			deliverInProcessMessage(
				{
					id: "agent-1",
					description: "review/probe",
					status: "completed",
				},
				{ message: "again", triggerTurn: true },
			),
		).rejects.toThrow("in-process agent is not running");
	});
});
