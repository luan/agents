import { describe, expect, test } from "bun:test";
import { stashWidgetLine, type PromptItem } from "../src/core/model.ts";

function stash(id: number, text: string): PromptItem {
	return { kind: "stash", id, text, timestamp: id, cwd: "/repo" };
}

describe("stash widget", () => {
	test("uses one line with the latest item only when multiple stashes exist", () => {
		expect(stashWidgetLine([stash(1, "only draft")])).toBe("Prompt stash (1)");
		expect(stashWidgetLine([stash(2, "latest draft"), stash(1, "older draft")])).toBe(
			"Prompt stash (2) • latest draft",
		);
	});
});
