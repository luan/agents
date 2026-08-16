import { describe, expect, test } from "bun:test";

import tokenBudgetExtension from "./index";

/**
 * The latch is the only thing here worth a test.
 *
 * Losing it fails silently and expensively: the reminder would be re-sent every
 * turn, each copy landing in the context the previous copy is still occupying,
 * which is the cost this whole extension exists to warn about.
 */

interface Handlers {
	turnStart: () => void;
	compact: () => void;
}

function boot(usage: () => { tokens: number | null; contextWindow: number }) {
	const messages: string[] = [];
	const handlers: Partial<Handlers> = {};
	const ctx = { getContextUsage: () => usage() };
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			if (event === "turn_start") handlers.turnStart = () => handler({ type: event }, ctx);
			if (event === "session_compact") handlers.compact = () => handler({ type: event }, ctx);
		},
		sendMessage(message: { content: string }) {
			messages.push(message.content);
		},
	};
	tokenBudgetExtension(pi as never);
	return { messages, handlers: handlers as Handlers };
}

describe("token-budget", () => {
	test("delivers once per compaction window and never above the threshold", () => {
		let tokens = 100_000;
		const { messages, handlers } = boot(() => ({ tokens, contextWindow: 200_000 }));

		handlers.turnStart();
		expect(messages).toEqual([]);

		tokens = 180_000;
		handlers.turnStart();
		handlers.turnStart();
		expect(messages).toEqual(["You have 20000 tokens left in this context window."]);

		handlers.compact();
		handlers.turnStart();
		expect(messages).toHaveLength(2);
	});
});
