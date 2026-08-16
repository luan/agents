import { describe, expect, test } from "bun:test";
import { detachToolResultImages } from "../shared/tool-result-images.ts";
import { buildSessionUsageData } from "./index";
import { ToolReach } from "./types";

function pngBase64(width: number, height: number): string {
	const head = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(head, 0);
	Buffer.from("IHDR", "ascii").copy(head, 12);
	head.writeUInt32BE(width, 16);
	head.writeUInt32BE(height, 20);
	return head.toString("base64");
}

function entry(id: string, parentId: string | null, message: Record<string, unknown>) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-05-10T00:00:00.000Z",
		message,
	};
}

function usage(input: number, cacheRead: number, output: number, cost: number) {
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + output, cost: { total: cost } };
}

/**
 * Two turns with the cache behaviour a real session shows: the first request
 * pays for everything, the second re-sends the same context and is served
 * almost entirely from cache. The numbers below are copied from a live session
 * rather than invented, because the point of the fixture is that the report
 * repeats what the provider said instead of re-deriving it.
 */
function twoTurnSession() {
	return [
		entry("u1", null, { role: "user", content: "please inspect files", timestamp: 0 }),
		entry("a1", "u1", {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect them." },
				{ type: "toolCall", id: "tc1", name: "exec_command", arguments: { cmd: "rg foo" } },
				{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "file.ts" } },
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: usage(8903, 0, 90, 0.00188),
			stopReason: "toolUse",
			timestamp: 0,
		}),
		entry("t1", "a1", {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "exec_command",
			content: [{ type: "text", text: "grep output ".repeat(20) }],
			isError: false,
			timestamp: 0,
		}),
		entry("t2", "t1", {
			role: "toolResult",
			toolCallId: "tc2",
			toolName: "read",
			content: [{ type: "text", text: "file content ".repeat(20) }],
			isError: false,
			timestamp: 0,
		}),
		entry("a2", "t2", {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: "test",
			provider: "test",
			model: "test",
			usage: usage(288, 8704, 25, 0.00026),
			stopReason: "stop",
			timestamp: 0,
		}),
	];
}

function usageData(entries: ReturnType<typeof twoTurnSession>, resolveReach?: (toolName: string) => ToolReach) {
	return buildSessionUsageData(
		{
			sessionManager: { getEntries: () => entries, getLeafId: () => entries.at(-1)?.id },
			getContextUsage: () => undefined,
		} as any,
		resolveReach,
	);
}

describe("token-burden session usage", () => {
	test("reports the measured context and cost rather than a tokenized estimate", () => {
		const result = usageData(twoTurnSession());

		expect(result?.tokens).toBe(8992);
		expect(result?.totals.floorTokens).toBe(8903);
		expect(result?.totals.cacheRead).toBe(8704);
		expect(result?.totals.cost).toBeCloseTo(0.00214, 6);
		expect(result?.turns.map((turn) => turn.growth)).toEqual([8903, 89]);
	});

	test("splits only the measured growth across the messages that caused it", () => {
		const result = usageData(twoTurnSession());
		const floor = result?.categories.find((category) => !category.estimated);
		const total = result?.categories.reduce((sum, category) => sum + category.tokens, 0);

		expect(floor).toEqual({ label: "Session floor", tokens: 8903, estimated: false });
		expect(total).toBe(result?.tokens);
		expect(result?.categories.filter((category) => category.estimated).map((category) => category.label)).toContain(
			"Tool result: exec_command(rg)",
		);
	});

	test("splits code-mode cell growth by nested tool reach without double-counting exec", () => {
		const entries = [
			entry("u1", null, { role: "user", content: "inspect the repo", timestamp: 0 }),
			entry("a1", "u1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "exec", arguments: { cell: "tools.exec_command(...)" } }],
				api: "test",
				provider: "test",
				model: "test",
				usage: usage(8903, 0, 90, 0.00188),
				stopReason: "toolUse",
				timestamp: 0,
			}),
			entry("t1", "a1", {
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "exec",
				content: [{ type: "text", text: "cell output ".repeat(20) }],
				details: {
					cell_id: 1,
					status: "completed",
					calls: [
						{ name: "exec_command", resultTokens: 20, status: "completed" },
						{ name: "exec_command", resultTokens: 10, status: "completed" },
						{ name: "read", resultTokens: 15, status: "completed" },
					],
				},
				isError: false,
				timestamp: 0,
			}),
			entry("a2", "t1", {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: "test",
				provider: "test",
				model: "test",
				usage: usage(288, 8704, 25, 0.00026),
				stopReason: "stop",
				timestamp: 0,
			}),
		];

		const uncategorized = usageData(entries);
		const categorized = usageData(entries, (name) => (name === "read" ? ToolReach.Deferred : ToolReach.Declared));
		const estimatedTotal = (data: ReturnType<typeof usageData>) =>
			data?.categories.filter(({ estimated }) => estimated).reduce((sum, { tokens }) => sum + tokens, 0);

		expect(estimatedTotal(categorized)).toBe(estimatedTotal(uncategorized));
		expect(categorized?.categories.length).toBe((uncategorized?.categories.length ?? 0) + 1);
	});

	// A renderer splices images out of the session entry while `withRetainedImages` keeps them in the
	// window, so reading the entry alone scored a 2000x1500 image at 0 instead of 3,553 tokens.
	test("prices an image a renderer detached from the tool result", () => {
		const drawn = {
			role: "toolResult",
			toolCallId: "tc-image",
			toolName: "view_image",
			content: [
				{ type: "text", text: "screenshot" },
				{ type: "image", mimeType: "image/png", data: pngBase64(2000, 1500) },
			],
			isError: false,
			timestamp: 0,
		};

		const entries = [
			entry("u1", null, { role: "user", content: "look at this", timestamp: 0 }),
			entry("a1", "u1", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc-text", name: "read", arguments: { path: "file.ts" } },
					{ type: "toolCall", id: "tc-image", name: "view_image", arguments: { path: "shot.png" } },
				],
				api: "test",
				provider: "test",
				model: "test",
				usage: usage(1000, 0, 90, 0.001),
				stopReason: "toolUse",
				timestamp: 0,
			}),
			entry("t1", "a1", {
				role: "toolResult",
				toolCallId: "tc-text",
				toolName: "read",
				content: [{ type: "text", text: "y".repeat(400) }],
				isError: false,
				timestamp: 0,
			}),
			entry("t2", "t1", drawn),
			entry("a2", "t2", {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: "test",
				provider: "test",
				model: "test",
				usage: usage(5000, 0, 25, 0.001),
				stopReason: "stop",
				timestamp: 0,
			}),
		];

		detachToolResultImages(drawn.toolCallId, drawn);
		expect(drawn.content).toHaveLength(1);

		const categories = usageData(entries)?.categories ?? [];
		const image = categories.find((category) => category.label === "Tool result: view_image");
		const text = categories.find((category) => category.label === "Tool result: read");

		expect(image?.tokens).toBeGreaterThan(3_000);
		expect(text?.tokens).toBeLessThan(200);
	});

	test("ignores turns the provider never billed", () => {
		const entries = twoTurnSession();
		entries.push(
			entry("a3", "a2", {
				role: "assistant",
				content: [{ type: "text", text: "aborted" }],
				api: "test",
				provider: "test",
				model: "test",
				usage: usage(0, 0, 0, 0),
				stopReason: "aborted",
				timestamp: 0,
			}),
		);

		expect(usageData(entries)?.turns).toHaveLength(2);
	});
});
