import { describe, expect, test } from "bun:test";
import { buildOwnCut } from "./before-compact";

const messageEntry = (id: string, role: string) => ({
	type: "message",
	id,
	message: {
		role,
		content: [{ type: "text", text: `${role} ${id}` }],
	},
});

describe("buildOwnCut", () => {
	test("compacts a prior-compaction suffix even when it has no user message", () => {
		const result = buildOwnCut([
			messageEntry("old-user", "user"),
			messageEntry("kept-assistant-1", "assistant"),
			messageEntry("kept-tool", "toolResult"),
			messageEntry("kept-assistant-2", "assistant"),
			{
				type: "compaction",
				id: "native-compaction",
				firstKeptEntryId: "kept-assistant-1",
			},
			messageEntry("new-assistant", "assistant"),
		]);

		expect(result).toEqual({
			ok: true,
			messages: [
				messageEntry("kept-assistant-1", "assistant").message,
				messageEntry("kept-tool", "toolResult").message,
				messageEntry("kept-assistant-2", "assistant").message,
				messageEntry("new-assistant", "assistant").message,
			],
			firstKeptEntryId: "",
			compactAll: true,
		});
	});

	test("still rejects sessions without any user message before first compaction", () => {
		const result = buildOwnCut([
			messageEntry("assistant-1", "assistant"),
			messageEntry("tool-1", "toolResult"),
			messageEntry("assistant-2", "assistant"),
		]);

		expect(result).toEqual({ ok: false, reason: "no_user_message" });
	});

	test("keeps the latest user message as the live tail when available", () => {
		const result = buildOwnCut([
			messageEntry("user-1", "user"),
			messageEntry("assistant-1", "assistant"),
			messageEntry("user-2", "user"),
			messageEntry("assistant-2", "assistant"),
		]);

		expect(result).toEqual({
			ok: true,
			messages: [messageEntry("user-1", "user").message, messageEntry("assistant-1", "assistant").message],
			firstKeptEntryId: "user-2",
			compactAll: false,
		});
	});
});
