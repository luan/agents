import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoCompactResumeExtension, { needsCompaction } from "./index";

const compactionReasonOverrideKey = Symbol.for("agents.pi.compaction-reason.override");
const compactionReasonGlobal = globalThis as typeof globalThis & {
	[compactionReasonOverrideKey]?: "threshold";
};

describe("auto compact and resume", () => {
	test("stops high-context tool loops gracefully, compacts when settled, then resumes", () => {
		let turnEnd: ((event: any, ctx: any) => void) | undefined;
		let context: ((event: any, ctx: any) => any) | undefined;
		let messageEnd: ((event: any, ctx: any) => any) | undefined;
		let agentSettled: ((event: any, ctx: any) => void) | undefined;
		let abortCalls = 0;
		let compactCalls = 0;
		let compactOptions: any;
		const messages: any[] = [];
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => void) {
				if (event === "turn_end") turnEnd = handler;
				if (event === "context") context = handler;
				if (event === "message_end") messageEnd = handler;
				if (event === "agent_settled") agentSettled = handler;
			},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			getContextUsage: () => ({ tokens: 235_000, contextWindow: 272_000, percent: 86 }),
			hasPendingMessages: () => false,
			abort() {
				abortCalls++;
			},
			compact(options: any) {
				compactCalls++;
				expect(compactionReasonGlobal[compactionReasonOverrideKey]).toBe("threshold");
				compactOptions = options;
			},
		};

		autoCompactResumeExtension(pi);
		turnEnd?.({ message: { content: [{ type: "toolCall" }] } }, ctx);

		expect(abortCalls).toBe(0);
		expect(compactCalls).toBe(0);

		const contextResult = context?.({ messages: [] }, ctx);
		expect(contextResult?.messages.at(-1)?.role).toBe("user");

		const replacement = messageEnd?.(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Paused." }],
					stopReason: "stop",
				},
			},
			ctx,
		);
		expect(replacement?.message.content).toEqual([]);

		agentSettled?.({}, ctx);
		expect(compactCalls).toBe(1);

		compactOptions.onComplete();
		expect(compactionReasonGlobal[compactionReasonOverrideKey]).toBeUndefined();
		expect(messages).toEqual([
			{
				message: {
					customType: "auto-compact-resume",
					content: "Continue the original request from the compacted context.",
					display: false,
				},
				options: { triggerTurn: true, deliverAs: "followUp" },
			},
		]);
	});

	test("reads compaction threshold from PI_AUTO_COMPACT_PERCENT", () => {
		const previous = process.env.PI_AUTO_COMPACT_PERCENT;
		process.env.PI_AUTO_COMPACT_PERCENT = "5";
		try {
			expect(needsCompaction([{ type: "toolCall" }], 41_000, 272_000)).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_AUTO_COMPACT_PERCENT;
			else process.env.PI_AUTO_COMPACT_PERCENT = previous;
		}
	});

	test("leaves completed and low-context turns alone", () => {
		expect(needsCompaction([{ type: "text" }], 235_000, 272_000)).toBe(false);
		expect(needsCompaction([{ type: "toolCall" }], 224_000, 272_000)).toBe(false);
	});
});
