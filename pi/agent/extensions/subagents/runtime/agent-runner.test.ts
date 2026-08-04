import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findRetryableError, resolveSessionRuntimeOptions, retryFailedTurn } from "./agent-runner";
import { isSubagentOrchestrationToolName } from "./orchestration-tools";
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

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(fields: { content?: unknown[]; stopReason: string; errorMessage?: string; timestamp: number }) {
	return {
		role: "assistant" as const,
		content: fields.content ?? [],
		api: "openai-responses",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		usage: EMPTY_USAGE,
		stopReason: fields.stopReason,
		errorMessage: fields.errorMessage,
		timestamp: fields.timestamp,
	};
}

test("re-issues the failed request and keeps completed tool work in context", async () => {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "finish the delegated task" }],
		timestamp: 1,
	});
	sessionManager.appendMessage(
		assistant({
			stopReason: "error",
			errorMessage: "Retry failed after 3 attempts: fetch failed",
			timestamp: 2,
		}) as never,
	);

	const userMessage = { role: "user", content: [{ type: "text", text: "finish the delegated task" }], timestamp: 1 };
	const answeredCall = assistant({
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 2,
	});
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [],
		isError: false,
		timestamp: 3,
	};
	const state = {
		messages: [
			userMessage,
			answeredCall,
			toolResult,
			// Tool calls the failed request never answered must not be replayed.
			assistant({
				content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }],
				stopReason: "toolUse",
				timestamp: 4,
			}),
			assistant({ stopReason: "error", errorMessage: "fetch failed", timestamp: 5 }),
		],
	};
	let continued = 0;
	// navigateTree and sendUserMessage are intentionally absent: replaying the user turn must throw.
	const session = {
		sessionManager,
		messages: [],
		subscribe: () => () => {},
		agent: {
			state,
			continue: async () => {
				continued++;
			},
		},
	} as never;

	expect(findRetryableError(sessionManager.getBranch())).toBe("Retry failed after 3 attempts: fetch failed");
	await retryFailedTurn(session);

	expect(state.messages).toEqual([userMessage, answeredCall, toolResult]);
	expect(continued).toBe(1);
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

	expect(findRetryableError(sessionManager.getBranch())).toBeUndefined();
});

test("allows recursive agent tools while blocking parent-owned interaction", () => {
	expect(isSubagentOrchestrationToolName("spawn_agent")).toBe(false);
	expect(isSubagentOrchestrationToolName("followup_task")).toBe(false);
	expect(isSubagentOrchestrationToolName("ask_user")).toBe(true);
	expect(isSubagentOrchestrationToolName("task_write")).toBe(true);
});
