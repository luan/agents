import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findRetryableError, prepareAgentRun, resolveSessionRuntimeOptions } from "./agent-runner";

test("shares the parent model runtime with subagents on Pi 0.80+", () => {
	const runtime = {};
	const registry = { runtime };

	expect(resolveSessionRuntimeOptions(registry)).toEqual({ modelRuntime: runtime });
});

test("keeps the legacy model registry path for older Pi versions", () => {
	const registry = {};

	expect(resolveSessionRuntimeOptions(registry)).toEqual({ modelRegistry: registry });
});

test("subagents inherit the exact parent tool and skill surface", async () => {
	const pi = {
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
		getActiveTools: () => ["read", "spawn_agent"],
		getThinkingLevel: () => "high",
	} as never;
	const prepared = await prepareAgentRun(
		{
			cwd: "/tmp",
			getSystemPrompt: () => "# Parent",
			modelRegistry: { getAvailable: () => [], getAll: () => [] },
			model: undefined,
		} as never,
		{
			pi,
			agentConfig: {},
		},
		false,
	);

	expect(prepared.toolNames).toEqual(["read", "spawn_agent"]);
	expect(prepared.systemPrompt).toContain("# Parent");
});

test("does not mark a successful assistant turn as retryable", () => {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "done?" }],
		timestamp: 1,
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});

	expect(findRetryableError(sessionManager.getBranch())).toBeUndefined();
});
