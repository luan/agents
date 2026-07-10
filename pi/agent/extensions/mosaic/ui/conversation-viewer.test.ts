import { describe, expect, test } from "bun:test";
import type { Theme } from "./agent-widget";
import { ConversationViewer } from "./conversation-viewer";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

const theme: Theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

describe("ConversationViewer", () => {
	test("renders model and effort metadata in the transcript header", () => {
		const viewer = new ConversationViewer(
			{ terminal: { rows: 12 } } as never,
			{
				messages: [],
				subscribe: () => () => {},
			} as never,
			{
				id: "a1",
				type: "Explore",
				description: "Inspect scope",
				status: "running",
				toolUses: 0,
				startedAt: Date.now(),
				modelName: "claude-haiku-4-5",
				thinkingLevel: "high",
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
				compactionCount: 0,
			},
			undefined,
			theme,
			() => {},
		);

		const rendered = stripAnsi(viewer.render(100).join("\n"));

		expect(rendered).toContain("claude-haiku-4-5 · effort high");
	});
});
