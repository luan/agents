import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findRetryableTurn, resolveSessionRuntimeOptions, retryFailedTurn } from "./agent-runner";
import { readAssistantUsage } from "./usage";

test("shares the parent model runtime with subagents on Pi 0.80+", () => {
	const runtime = {};
	const registry = { runtime };

	expect(resolveSessionRuntimeOptions(registry)).toEqual({ modelRuntime: runtime });
});

test("keeps the legacy model registry path for older Pi versions", () => {
	const registry = {};

	expect(resolveSessionRuntimeOptions(registry)).toEqual({ modelRegistry: registry });
});

test("captures assistant cost for parent-session accounting", () => {
	expect(
		readAssistantUsage({
			usage: {
				input: 120,
				output: 30,
				cacheWrite: 10,
				cost: { total: 0.42 },
			},
		}),
	).toEqual({ input: 120, output: 30, cacheWrite: 10, cost: 0.42 });
});

test("retries a failed turn from before its originating user message", async () => {
	const sessionManager = SessionManager.inMemory();
	const userContent = [{ type: "text" as const, text: "finish the delegated task" }];
	const userId = sessionManager.appendMessage({
		role: "user",
		content: userContent,
		timestamp: 1,
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [],
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
		stopReason: "error",
		errorMessage: "Retry failed after 3 attempts: fetch failed",
		timestamp: 2,
	});

	const navigated: string[] = [];
	const sent: unknown[] = [];
	const session = {
		sessionManager,
		messages: [],
		subscribe: () => () => {},
		navigateTree: async (entryId: string) => {
			navigated.push(entryId);
			sessionManager.resetLeaf();
			return { cancelled: false };
		},
		sendUserMessage: async (content: unknown) => {
			sent.push(content);
		},
	} as never;

	expect(findRetryableTurn(sessionManager.getBranch())?.error).toBe("Retry failed after 3 attempts: fetch failed");
	await retryFailedTurn(session);

	expect(navigated).toEqual([userId]);
	expect(sent).toEqual([userContent]);
});

test("does not retry a successful assistant turn", () => {
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

	expect(findRetryableTurn(sessionManager.getBranch())).toBeUndefined();
});
