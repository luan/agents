import { describe, expect, test } from "bun:test";
import { registerVccCommand } from "./vcc";

const messageEntry = (id: string, role: string) => ({
	type: "message",
	id,
	message: {
		role,
		content: [{ type: "text", text: `${role} ${id}` }],
	},
});

const registerCommand = () => {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	registerVccCommand({
		registerCommand(name: string, definition: any) {
			if (name === "vcc") handler = definition.handler;
		},
	} as any);
	if (!handler) throw new Error("vcc command was not registered");
	return handler;
};

describe("vcc command", () => {
	test("warns immediately without entering compaction when there are too few live messages", async () => {
		const handler = registerCommand();
		const notifications: Array<{ message: string; level: string }> = [];
		let compactCalls = 0;

		await handler("", {
			sessionManager: {
				getBranch: () => [messageEntry("user-1", "user"), messageEntry("assistant-1", "assistant")],
			},
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
			compact: () => {
				compactCalls++;
			},
		});

		expect(compactCalls).toBe(0);
		expect(notifications).toEqual([{ message: "vcc: Too few messages to compact", level: "warning" }]);
	});

	test("delegates to core compaction after local preflight passes", async () => {
		const handler = registerCommand();
		const compactOptions: any[] = [];

		await handler("", {
			sessionManager: {
				getBranch: () => [
					messageEntry("user-1", "user"),
					messageEntry("assistant-1", "assistant"),
					messageEntry("user-2", "user"),
					messageEntry("assistant-2", "assistant"),
				],
			},
			ui: {
				notify: () => {},
			},
			compact: (options: any) => {
				compactOptions.push(options);
			},
		});

		expect(compactOptions).toHaveLength(1);
		expect(compactOptions[0].customInstructions).toBe("__vcc__");
	});
});
