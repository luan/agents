import { describe, expect, test } from "bun:test";
import { isTerminalAssistantMessage, resolveFullSessionAgentStatus } from "./full-session-status";

describe("resolveFullSessionAgentStatus", () => {
	test("marks a running full-session agent stopped when its target closes before assistant output", () => {
		const resolved = resolveFullSessionAgentStatus({
			currentStatus: "running",
			live: undefined,
			transcript: { hasAssistantMessage: false },
			now: 1234,
		});

		expect(resolved.status).toBe("stopped");
		expect(resolved.completedAt).toBe(1234);
		expect(resolved.error).toContain("closed before producing");
		expect(resolved.activityText).toContain("closed");
	});

	test("keeps an idle live target running until it produces output or closes", () => {
		const resolved = resolveFullSessionAgentStatus({
			currentStatus: "running",
			live: { busy: false },
			transcript: { hasAssistantMessage: false },
			now: 1234,
		});

		expect(resolved.status).toBe("running");
		expect(resolved.completedAt).toBeUndefined();
		expect(resolved.activityText).toBe("idle in mosaic target");
	});

	test("uses the transcript assistant message as the terminal result", () => {
		const resolved = resolveFullSessionAgentStatus({
			currentStatus: "running",
			live: undefined,
			transcript: {
				hasAssistantMessage: true,
				assistantTimestamp: 1000,
				result: "done",
			},
			now: 1234,
		});

		expect(resolved.status).toBe("completed");
		expect(resolved.completedAt).toBe(1000);
		expect(resolved.result).toBe("done");
	});

	test("does not regress a terminal status when heartbeat evidence is gone later", () => {
		const resolved = resolveFullSessionAgentStatus({
			currentStatus: "completed",
			live: undefined,
			transcript: { hasAssistantMessage: false },
			now: 1234,
		});

		expect(resolved.status).toBe("completed");
		expect(resolved.completedAt).toBe(1234);
	});
});

describe("isTerminalAssistantMessage", () => {
	test("rejects assistant tool-use preambles as terminal output", () => {
		expect(
			isTerminalAssistantMessage({
				stopReason: "toolUse",
				content: [
					{ type: "text", text: "I'll run that now." },
					{ type: "toolCall", name: "exec_command" },
				],
			}),
		).toBe(false);
	});

	test("accepts ordinary assistant text as terminal output", () => {
		expect(isTerminalAssistantMessage({ stopReason: "stop", content: [{ type: "text", text: "Done." }] })).toBe(true);
	});
});
