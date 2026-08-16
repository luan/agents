import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { selectForkedHistory } from "./fork-history";

const user = (text: string, timestamp: number) =>
	({ role: "user", content: [{ type: "text", text }], timestamp }) as AgentMessage;

const assistant = (text: string, timestamp: number, stopReason: "stop" | "toolUse" = "stop") =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		usage: {},
		stopReason,
		timestamp,
	}) as AgentMessage;

test("selects the latest fork turn and sanitizes an active turn", () => {
	const messages = [
		user("one", 1),
		assistant("first", 2),
		user("two", 3),
		assistant("second", 4),
		user("active", 5),
		assistant("calling a tool", 6, "toolUse"),
	];

	const recent = selectForkedHistory(messages, 1);
	expect(recent[0]).toEqual(messages[4]);
	expect(recent[1]).toMatchObject({ role: "assistant", stopReason: "stop" });
	expect(selectForkedHistory(messages, "all")).toHaveLength(6);
	expect(selectForkedHistory(messages, "none")).toEqual([]);
});

test("full forks preserve pre-turn context while integer forks drop it", () => {
	const startup = { role: "custom", customType: "startup", content: "setup", timestamp: 0 } as AgentMessage;
	const messages = [startup, user("one", 1), assistant("first", 2)];

	expect(selectForkedHistory(messages, "all")).toEqual(messages);
	expect(selectForkedHistory(messages, 2)).toEqual(messages.slice(1));
});

test("integer forks count only triggered user boundaries", () => {
	const messages = [
		user("one", 1),
		assistant("first", 2),
		user("queued", 3),
		assistant("second", 4),
		user("two", 5),
		assistant("final", 6),
	];

	expect(selectForkedHistory(messages, 2, new Set([3]))[0]).toEqual(messages[0]);
	expect(selectForkedHistory(messages, 2)[0]).toEqual(messages[2]);
});

test("sanitizes an active tool turn without losing the user task", () => {
	const messages = [
		user("work", 1),
		assistant("calling", 2, "toolUse"),
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "spawn_agent",
			content: [],
			isError: false,
			timestamp: 3,
		} as AgentMessage,
	];

	const forked = selectForkedHistory(messages, "all");
	expect(forked[0]).toEqual(messages[0]);
	expect(forked[1]).toMatchObject({ role: "assistant", stopReason: "stop" });
	expect(forked).toHaveLength(2);
});

test("removes transient subagent messages from complete turns", () => {
	const messages = [
		user("work", 1),
		{
			role: "custom",
			customType: "subagent-message",
			content: "temporary child report",
			display: false,
			timestamp: 2,
		} as AgentMessage,
		assistant("done", 3),
	];

	expect(selectForkedHistory(messages, "all")).toEqual([messages[0], messages[2]]);
});

test("removes a transient inter-agent delivery as one complete turn", () => {
	const messages = [
		user("keep this", 1),
		assistant("kept", 2),
		user("Message Type: MESSAGE\nTask name: /root/worker\nSender: /root\nPayload:\nstatus", 3),
		assistant("acknowledged", 4),
	];

	expect(selectForkedHistory(messages, "all")).toEqual(messages.slice(0, 2));
});

test("rejects invalid numeric turn counts", () => {
	expect(() => selectForkedHistory([], -1)).toThrow("fork_turns must be none, all, or a positive integer");
	expect(() => selectForkedHistory([], 1.5)).toThrow("fork_turns must be none, all, or a positive integer");
});
