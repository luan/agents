import { afterEach, describe, expect, it } from "bun:test";
import { approxTokenCount } from "./output-budget.ts";
import {
	boundTextWithArtifact,
	boundToolResultEvent,
	HARD_MAX_TOOL_TOKENS,
	setArtifactMinter,
	TOOL_TOKEN_BUDGETS,
	truncateMiddleByTokens,
} from "./tool-bounding.ts";

afterEach(() => {
	setArtifactMinter(undefined);
});

function numberedLines(count: number, width: number): string {
	return Array.from({ length: count }, (_, index) => `${index}`.padEnd(width, "x")).join("\n");
}

describe("truncateMiddleByTokens", () => {
	it("keeps both ends inside the budget, on line boundaries", () => {
		const text = numberedLines(4_000, 60);
		const bounded = truncateMiddleByTokens(text, 2_000);

		expect(bounded.truncated).toBe(true);
		expect(bounded.originalLines).toBe(4_000);
		expect(bounded.originalTokens).toBe(approxTokenCount(text));
		expect(approxTokenCount(bounded.text)).toBeLessThanOrEqual(2_000);

		const lines = bounded.text.split("\n");
		expect(lines[0]).toBe("0".padEnd(60, "x"));
		expect(lines.at(-1)).toBe("3999".padEnd(60, "x"));
		// Every surviving line is whole; a byte-aligned cut would leave a fragment.
		for (const line of lines) {
			if (line.startsWith("[…")) continue;
			expect(line).toHaveLength(60);
		}
	});

	it("spends the budget it was given", () => {
		// Short lines are where per-line token rounding used to overcharge by a
		// token each, delivering roughly half the budget the caller asked for.
		const bounded = truncateMiddleByTokens(numberedLines(20_000, 4), 1_000);
		expect(approxTokenCount(bounded.text)).toBeGreaterThan(800);
		expect(approxTokenCount(bounded.text)).toBeLessThanOrEqual(1_000);
	});

	it("cuts inside a line that is larger than the whole budget", () => {
		const bounded = truncateMiddleByTokens("a".repeat(200_000), 500);
		expect(bounded.truncated).toBe(true);
		expect(bounded.originalLines).toBe(1);
		expect(approxTokenCount(bounded.text)).toBeLessThanOrEqual(500);
		expect(bounded.text.startsWith("a")).toBe(true);
		expect(bounded.text.endsWith("a")).toBe(true);
	});

	it("leaves text under the budget untouched", () => {
		const text = numberedLines(10, 20);
		expect(truncateMiddleByTokens(text, 6_000)).toMatchObject({ text, truncated: false, originalLines: 10 });
	});

	it("names the recovery pointer in the notice", () => {
		const bounded = truncateMiddleByTokens(numberedLines(4_000, 60), 2_000, {
			fullOutputRef: "artifact://abc123",
		});
		expect(bounded.text).toContain("of 4000 lines");
		expect(bounded.text).toContain("Full output: artifact://abc123");
	});
	it("uses valid grammar when no content label is available", () => {
		const bounded = truncateMiddleByTokens("a".repeat(200_000), 500);
		expect(bounded.text).toContain("tokens; no complete line fit the budget");
		expect(bounded.text).not.toContain("tokens from;");
	});
});

describe("boundTextWithArtifact", () => {
	it("still bounds when the minter throws", async () => {
		setArtifactMinter(async () => {
			throw new Error("core binary missing");
		});
		const bounded = await boundTextWithArtifact(numberedLines(4_000, 60), { maxTokens: 2_000, label: "read result" });

		expect(bounded.truncated).toBe(true);
		expect(bounded.artifactUri).toBeUndefined();
		expect(approxTokenCount(bounded.text)).toBeLessThanOrEqual(2_000);
		expect(bounded.text).toContain("Not recoverable");
	});

	it("does not touch the store for a result under the budget", async () => {
		let mints = 0;
		setArtifactMinter(async () => {
			mints++;
			return "artifact://unused";
		});
		const bounded = await boundTextWithArtifact("small", { maxTokens: 6_000, label: "read result" });

		expect(bounded.truncated).toBe(false);
		expect(mints).toBe(0);
	});

	it("passes ownerSessionId to the artifact minter", async () => {
		let received: unknown[] | undefined;
		setArtifactMinter(async (...args) => {
			received = args;
			return "artifact://owner";
		});
		await boundTextWithArtifact(numberedLines(4_000, 60), {
			maxTokens: 2_000,
			label: "exec result",
			ownerSessionId: "owner-session",
		});
		expect(received?.[0]).toContain("0".padEnd(60, "x"));
		expect(received?.[1]).toBe("exec result");
		expect(received?.[2]).toBeUndefined();
		expect(received?.[3]).toBe("owner-session");
	});

	// `capture.ts:85` files the untruncated output and says so in the first line. Minting again filed the 8 KiB preview
	// and called it "Full output" while the real 68 KiB sat in the earlier artifact.
	it("reuses the pointer a captured result already carries instead of filing its preview", async () => {
		let mints = 0;
		setArtifactMinter(async () => {
			mints++;
			return "artifact://second";
		});
		const captured = `Captured 68.1 KiB as artifact 7; showing diagnostic tail. Read artifact://7 for the full output.\n${numberedLines(4_000, 60)}`;

		const bounded = await boundTextWithArtifact(captured, { maxTokens: 2_000, label: "exec_command result" });

		expect(bounded.text).toContain("Full output: artifact://7");
		expect(bounded.text).not.toContain("artifact://second");
		expect(mints).toBe(0);
	});

	it("files its own artifact when a result only mentions an unrelated artifact uri", async () => {
		setArtifactMinter(async () => "artifact://own");
		const mentions = `see artifact://99 for context\n${numberedLines(4_000, 60)}`;

		const bounded = await boundTextWithArtifact(mentions, { maxTokens: 2_000, label: "search result" });

		expect(bounded.text).toContain("Full output: artifact://own");
	});
});

describe("boundToolResultEvent", () => {
	// The failure this covers is silent: a call asking for 20,000 tokens gets
	// the table's 2,500 row, so asking for more returns less than asking for
	// nothing, and the result reads as if the tool simply had less to say.
	it("honours the max_output_tokens the call asked for", async () => {
		const content = [{ type: "text", text: numberedLines(20_000, 60) }];

		const withRequest = await boundToolResultEvent({
			toolName: "exec_command",
			input: { cmd: "cat big.log", max_output_tokens: 20_000 },
			content,
		});
		const withoutRequest = await boundToolResultEvent({
			toolName: "exec_command",
			input: { cmd: "cat big.log" },
			content,
		});

		const requested = (withRequest?.content?.[0] as { text: string }).text;
		const defaulted = (withoutRequest?.content?.[0] as { text: string }).text;

		expect(approxTokenCount(requested)).toBeGreaterThan(approxTokenCount(defaulted));
		expect(approxTokenCount(requested)).toBeLessThanOrEqual(20_000);
		expect(approxTokenCount(defaulted)).toBeLessThanOrEqual(TOOL_TOKEN_BUDGETS.exec_command as number);
	});
	it("updates output token metadata to match bounded content", async () => {
		const result = await boundToolResultEvent({
			toolName: "search",
			input: {},
			content: [{ type: "text", text: "token ".repeat(7_000) }],
			details: { outputTokens: 7_000, outputBounded: false, marker: "kept" },
		});
		const text = (result?.content?.[0] as { text: string }).text;
		const details = result?.details as { outputTokens: number; outputBounded: boolean; marker: string };

		expect(details.outputTokens).toBe(approxTokenCount(text));
		expect(details.outputTokens).toBeLessThanOrEqual(TOOL_TOKEN_BUDGETS.search as number);
		expect(details.outputBounded).toBe(true);
		expect(details.marker).toBe("kept");
	});

	it("shares one budget across every text block", async () => {
		const text = "token ".repeat(7_000);
		const bounded = await boundToolResultEvent({
			toolName: "x",
			input: {},
			content: [
				{ type: "text", text },
				{ type: "image", data: "pixels", mimeType: "image/png" },
				{ type: "text", text },
			],
		});
		const content = bounded?.content as Array<{ type: string; text?: string }>;
		const textBlocks = content.filter((block) => block.type === "text");
		const deliveredTokens = textBlocks.reduce((total, block) => total + approxTokenCount(block.text ?? ""), 0);

		expect(deliveredTokens).toBeLessThanOrEqual(6_000);
		expect(textBlocks).toHaveLength(1);
		expect(content.some((block) => block.type === "image")).toBe(true);
		expect(textBlocks[0]?.text).toContain("tokens from 2 text blocks");
		expect(textBlocks[0]?.text).toContain("elided ~");
	});

	it("clamps a request above the hard ceiling", async () => {
		const bounded = await boundToolResultEvent({
			toolName: "exec_command",
			input: { max_output_tokens: 400_000 },
			content: [{ type: "text", text: numberedLines(200_000, 60) }],
		});

		const text = (bounded?.content?.[0] as { text: string }).text;
		expect(approxTokenCount(text)).toBeLessThanOrEqual(HARD_MAX_TOOL_TOKENS);
	});
});
