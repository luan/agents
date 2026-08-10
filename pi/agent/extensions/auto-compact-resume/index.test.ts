import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoCompactResumeExtension, { needsCompaction } from "./index";

describe("auto compact and resume", () => {
	test("stops high-context tool loops and resumes after Pi compacts", () => {
		let turnEnd: ((event: any, ctx: any) => void) | undefined;
		let abortCalls = 0;
		let compactCalls = 0;
		let compactOptions: any;
		const messages: any[] = [];
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => void) {
				if (event === "turn_end") turnEnd = handler;
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
				compactOptions = options;
				options.onComplete();
			},
		};

		autoCompactResumeExtension(pi);
		turnEnd?.({ message: { content: [{ type: "toolCall" }] } }, ctx);

		expect(abortCalls).toBe(0);
		expect(compactCalls).toBe(1);
		expect(compactOptions).toBeDefined();
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

	test("leaves completed and low-context turns alone", () => {
		expect(needsCompaction([{ type: "text" }], 235_000, 272_000)).toBe(false);
		expect(needsCompaction([{ type: "toolCall" }], 224_000, 272_000)).toBe(false);
	});
});
