import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { selectForkedHistory } from "../src/core/fork-history.ts";

const user = (content: string, timestamp: number): AgentMessage => ({ role: "user", content, timestamp });
const assistant = (content: string, timestamp: number): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text: content }],
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
	timestamp,
});

test("selects the requested completed turns", () => {
	const messages: AgentMessage[] = [
		user("one", 1),
		assistant("one done", 2),
		user("two", 3),
		assistant("two done", 4),
		user("active", 5),
	];
	expect(selectForkedHistory(messages, "none")).toEqual([]);
	expect(selectForkedHistory(messages, 1)).toEqual(messages.slice(2, 4));
	expect(selectForkedHistory(messages, "all")).toEqual(messages.slice(0, 4));
});

test("steering timestamps stay inside the current turn", () => {
	const messages = [user("task", 1), user("steer", 2), assistant("done", 3), user("next", 4)];
	expect(selectForkedHistory(messages, 1, new Set([2]))).toEqual(messages.slice(0, 3));
});

test("excludes the entire active turn instead of exposing its orchestration to the child", () => {
	const messages: AgentMessage[] = [
		user("completed", 0),
		assistant("completed result", 1),
		user("task", 1),
		{
			role: "assistant",
			content: [
				{ type: "text", text: "working" },
				{ type: "toolCall", id: "call", name: "read", arguments: {} },
			],
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
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "partial" }],
			isError: false,
			timestamp: 3,
		},
	];
	const selected = selectForkedHistory(messages, "all");
	expect(selected).toHaveLength(2);
	expect(selected).toEqual(messages.slice(0, 2));
});

test("rejects invalid numeric fork counts", () => {
	expect(() => selectForkedHistory([], 0)).toThrow("positive integer");
	expect(() => selectForkedHistory([], 1.5)).toThrow("positive integer");
});
