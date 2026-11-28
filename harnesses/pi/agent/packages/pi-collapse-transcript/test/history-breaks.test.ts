import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { activityBreaks } from "../src/history-breaks.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
let next = 0;
const base = () => ({ id: `e${next++}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" });
function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): SessionEntry {
	return {
		...base(),
		type: "message",
		message: {
			role: "assistant",
			api: "openai-responses",
			provider: "fixture",
			model: "fixture",
			content,
			stopReason,
			timestamp: 0,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost },
		},
	};
}
const thinking = (text = "plan") => ({ type: "thinking" as const, thinking: text });
const text = (value = "prose") => ({ type: "text" as const, text: value });
const call = (id = "t") => ({ type: "toolCall" as const, id, name: "read", arguments: {} });
const result = (id = "t"): SessionEntry => ({
	...base(),
	type: "message",
	message: { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp: 0 },
});
const user = (content = "do it"): SessionEntry => ({
	...base(),
	type: "message",
	message: { role: "user", content, timestamp: 0 },
});
const state = (): SessionEntry => ({ ...base(), type: "custom", customType: "fixture-state", data: {} });

test("pages start only where no activity fold is open", () => {
	const entries = [
		user(),
		assistant([thinking(), call("a")]),
		result("a"),
		assistant([thinking(), call("b")]),
		result("b"),
		assistant([text("done")], "stop"),
		user("next"),
	];
	// The final prose ends the fold, so a page may also start there.
	expect(activityBreaks(entries)).toEqual([true, true, false, false, false, true, true]);
});

test("assistant prose ends a fold, so a message that starts with prose may start a page", () => {
	const entries = [
		assistant([thinking(), call()]),
		result(),
		assistant([text("I will check"), call("c")]),
		result("c"),
	];
	expect(activityBreaks(entries)[2]).toBe(true);
	// Thinking before the prose extends the open fold, so that message cannot start a page.
	expect(activityBreaks([assistant([call()]), result(), assistant([thinking(), text(), call("c")])])[2]).toBe(false);
	// The tools after the prose open a new fold that continues into the next message.
	expect(activityBreaks([assistant([text(), call()]), result(), assistant([thinking(), call("c")])])[2]).toBe(false);
});

test("a message that ends with prose leaves no fold open", () => {
	const entries = [
		assistant([thinking(), call()]),
		result(),
		assistant([thinking(), text("summary")]),
		assistant([thinking()]),
	];
	expect(activityBreaks(entries)[3]).toBe(true);
});

test("error and truncation notices end a fold and stay visible on their own", () => {
	const entries = [
		assistant([thinking(), call()]),
		result(),
		assistant([thinking()], "error"),
		assistant([thinking()]),
	];
	expect(activityBreaks(entries).slice(2)).toEqual([true, true]);
});

test("entries that render nothing neither open nor end a fold", () => {
	const open = [assistant([thinking(), call()]), result(), state(), assistant([call("c")])];
	expect(activityBreaks(open).slice(2)).toEqual([false, false]);
	const closed = [user(), state(), assistant([call()])];
	expect(activityBreaks(closed).slice(1)).toEqual([true, true]);
	// An empty user message renders nothing either.
	expect(activityBreaks([assistant([call()]), result(), user("  "), assistant([call("c")])]).slice(2)).toEqual([
		false,
		false,
	]);
});
