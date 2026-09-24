import { expect, test } from "bun:test";
import { initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ToolActivity } from "@luan.sh/pi-libtui/tool";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { conversationPresentation } from "../src/tools/presentation.ts";
import { conversationResult, type ConversationDetails } from "../src/tools/result.ts";

const schema = Type.Object({});
const context: Parameters<NonNullable<ToolDefinition<typeof schema, ConversationDetails, object>["renderResult"]>>[3] =
	{
		args: {},
		toolCallId: "test",
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
		lastComponent: undefined,
		invalidate() {},
	};

test.each([
	[
		"clock__curr_time",
		conversationResult({ tool: "clock__curr_time", output: { current_time: "2026-09-13 23:13:27 UTC" } }),
		"Checked time",
		"23:13:27 UTC",
	],
	[
		"request_user_input_async",
		conversationResult({
			tool: "request_user_input_async",
			output: { accepted: true },
			questions: [{ title: "Which name?", options: ["Orchid", "Comet"] }],
		}),
		"Asked for input",
		"Comet",
	],
	[
		"send_message_to_user_async",
		conversationResult({
			tool: "send_message_to_user_async",
			output: { accepted: true },
			message: "This message has its own transcript entry.",
		}),
		"Sent message",
		"",
	],
	[
		"clock__sleep",
		conversationResult({ tool: "clock__sleep", output: { elapsed_ms: 1500, reason: "input" } }),
		"Resumed on your input",
		"1.5s",
	],
] as const)("%s renders a readable result without changing model output", (name, result, title, detail) => {
	initTheme("dark", false);
	const before = JSON.stringify(result);
	const component = conversationPresentation<typeof schema>(name).renderResult!(
		result,
		{ expanded: true, isPartial: false },
		theme,
		context,
	);
	try {
		const rendered = component.render(100).map(stripTerminalSequences).join("\n");
		expect(rendered).toContain(title);
		expect(rendered).toContain(detail);
		expect(rendered).not.toContain(name);
		expect(rendered).not.toContain('"accepted"');
		expect(rendered).not.toContain("This message has its own transcript entry.");
		expect(JSON.stringify(result)).toBe(before);
	} finally {
		if (component instanceof ToolActivity) component.dispose();
	}
});

test("wait shows progress, then cancellation, using the same component", () => {
	initTheme("light", false);
	const render = conversationPresentation<typeof schema>("clock__sleep").renderResult!;
	const details: ConversationDetails = { version: 1, tool: "clock__sleep", status: "running", duration_ms: 60_000 };
	const running = render({ content: [], details }, { expanded: false, isPartial: true }, theme, {
		...context,
		isPartial: true,
	});
	expect(running.render(80).map(stripTerminalSequences).join("\n")).toContain("Waiting · up to 1m");
	const settled = render(
		conversationResult({ tool: "clock__sleep", output: { elapsed_ms: 0, reason: "cancelled" } }),
		{ expanded: false, isPartial: false },
		theme,
		{ ...context, lastComponent: running },
	);
	try {
		expect(settled).toBe(running);
		expect(settled.render(80).map(stripTerminalSequences).join("\n")).toContain("Wait cancelled");
	} finally {
		if (settled instanceof ToolActivity) settled.dispose();
	}
});
