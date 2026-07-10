import type { AgentRecord } from "./types.js";

export interface InProcessMessageInput {
	message: string;
	triggerTurn: boolean;
}

export interface InProcessMessageResult {
	agentId: string;
	taskName: string;
	runtime: "in-process";
	deliveredAs: "steer";
	queued: boolean;
	triggerTurn: true;
	note?: string;
}

/**
 * In-process agents do not have a mailbox. The only control primitive is
 * `session.steer()`, so both queue-only and trigger-turn requests degrade to a
 * steer. When the session is not ready yet, the message is queued in
 * `pendingSteers` and flushed by AgentManager once the session is created.
 */
export async function deliverInProcessMessage(
	record: Pick<AgentRecord, "id" | "description" | "status" | "session" | "pendingSteers">,
	input: InProcessMessageInput,
): Promise<InProcessMessageResult> {
	if (record.status !== "running" && record.status !== "queued") {
		throw new Error(`in-process agent is not running: ${record.id} (${record.status})`);
	}

	const note = input.triggerTurn
		? undefined
		: "in-process agents do not support mailbox-only delivery; delivered as a steer";

	if (!record.session) {
		record.pendingSteers ??= [];
		record.pendingSteers.push(input.message);
		return {
			agentId: record.id,
			taskName: record.description,
			runtime: "in-process",
			deliveredAs: "steer",
			queued: true,
			triggerTurn: true,
			...(note ? { note } : {}),
		};
	}

	await record.session.steer(input.message);
	return {
		agentId: record.id,
		taskName: record.description,
		runtime: "in-process",
		deliveredAs: "steer",
		queued: false,
		triggerTurn: true,
		...(note ? { note } : {}),
	};
}
