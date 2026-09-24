import { expect, test } from "bun:test";
import { initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ToolActivity } from "@luan.sh/pi-libtui/tool";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { contextPresentation } from "../src/tools/presentation.ts";
import { type ContextToolDetails, contextResult } from "../src/tools/result.ts";
import { historyPreview } from "../src/tools/history/result.ts";

const schema = Type.Object({});
const context: Parameters<NonNullable<ToolDefinition<typeof schema, ContextToolDetails, object>["renderResult"]>>[3] = {
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

test("search excerpts use readable previews while preserving the model's raw history result", () => {
	initTheme("dark", false);
	const item = {
		item_id: "entry",
		window_id: "window",
		role: "assistant",
		ordinal: 0,
		content: JSON.stringify({
			role: "assistant",
			content: [{ type: "text", text: `${"Earlier work. ".repeat(100)}Remember potato.` }],
			usage: { totalTokens: 123 },
		}),
	};
	const rawExcerpt = item.content.slice(item.content.indexOf("potato") - 20);
	const result = contextResult(
		"history__search_contents",
		{ query: "potato" },
		{ items: [{ ...item, truncated_content: rawExcerpt }] },
		[historyPreview(item, 1000, "potato")],
	);
	const content = structuredClone(result.content);
	const component = contextPresentation<typeof schema>("history__search_contents").renderResult!(
		result,
		{ expanded: true, isPartial: false },
		theme,
		context,
	);
	try {
		const rendered = component.render(100).map(stripTerminalSequences).join("\n");
		expect(rendered).toContain("Remember potato.");
		expect(rendered).not.toContain("totalTokens");
		expect(result.content).toEqual(content);
	} finally {
		if (component instanceof ToolActivity) component.dispose();
	}
});

test.each(["light", "dark"])("note previews preserve content and use readable summaries (%s)", (mode) => {
	initTheme(mode, false);
	const text = `Remember potato.\n${"Keep the accepted decisions.\n".repeat(15)}Last line.`;
	const result = contextResult("notes__read_file", { path: "checkpoint.md" }, { text, total_lines: 17 });
	const render = contextPresentation<typeof schema>("notes__read_file").renderResult!;
	const preview = render(result, { expanded: false, isPartial: false }, theme, { ...context, expanded: false });
	const full = render(result, { expanded: true, isPartial: false }, theme, context);
	try {
		const lines = full.render(60);
		const output = lines.map(stripTerminalSequences).join("\n");
		expect(output).toContain("Read note");
		expect(output).toContain("checkpoint.md");
		expect(output).toContain("Remember potato.");
		expect(output).toContain("Last line.");
		expect(output).not.toContain('"total_lines"');
		expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
		expect(preview.render(60).length).toBeLessThan(lines.length);
	} finally {
		if (preview instanceof ToolActivity) preview.dispose();
		if (full instanceof ToolActivity) full.dispose();
	}
});

test.each([
	["notes__write_file", { path: "checkpoint.md", text: "potato" }, { bytes: 6 }, "Saved note", "potato"],
	["notes__append_to_file", { path: "checkpoint.md", text: "potato" }, { bytes: 6 }, "Updated note", "potato"],
	[
		"notes__list_files_by_prefix",
		{},
		{ files: [{ path: "checkpoint.md", bytes: 6 }] },
		"Listed notes",
		"checkpoint.md",
	],
	[
		"notes__search_contents",
		{ query: "potato" },
		{ matches: [{ path: "checkpoint.md", line: 1, text: "potato" }] },
		"Searched notes",
		"checkpoint.md:1",
	],
	[
		"history__list_windows",
		{},
		{ windows: [{ window_id: "old-window", item_count: 2 }] },
		"Listed context windows",
		"old-window",
	],
	[
		"history__list_items",
		{},
		{ items: [{ role: "user", truncated_content: "potato", item_id: "entry", window_id: "old-window" }] },
		"Browsed history",
		"potato",
	],
	["history__search_contents", { query: "potato" }, { items: [], has_more: false }, "No history matches", "0 matches"],
	[
		"history__read_item",
		{},
		{ role: "user", content: "potato", item_id: "entry", window_id: "old-window" },
		"Read history",
		"potato",
	],
	["new_context", {}, { accepted: true }, "Requested fresh context", "Checkpoint retained"],
	["get_context_remaining", {}, { tokens_left: null }, "Context available", "Usage not available yet"],
] as const)("%s renders its useful result without JSON", (name, input, output, title, body) => {
	initTheme("dark", false);
	const result = contextResult(name, input, output);
	const before = JSON.stringify(result);
	const component = contextPresentation<typeof schema>(name).renderResult!(
		result,
		{ expanded: true, isPartial: false },
		theme,
		context,
	);
	try {
		const rendered = component.render(100).map(stripTerminalSequences).join("\n");
		expect(rendered).toContain(title);
		expect(rendered).toContain(body);
		expect(rendered).not.toContain(name);
		expect(JSON.stringify(result)).toBe(before);
	} finally {
		if (component instanceof ToolActivity) component.dispose();
	}
});

test("tool failure preserves the error instead of rendering a success", () => {
	initTheme("dark", false);
	const component = contextPresentation<typeof schema>("notes__read_file").renderResult!(
		{ content: [{ type: "text", text: "Note not found" }], details: contextResult("notes__read_file", {}, {}).details },
		{ expanded: true, isPartial: false },
		theme,
		{ ...context, isError: true },
	);
	try {
		const output = component.render(80).map(stripTerminalSequences).join("\n");
		expect(output).toContain("Read note failed");
		expect(output).toContain("Note not found");
	} finally {
		if (component instanceof ToolActivity) component.dispose();
	}
});

test.each([false, true])(
	"history renders message content rather than transport metadata (truncated=%s)",
	(truncated) => {
		initTheme("dark", false);
		const raw = JSON.stringify({
			role: "assistant",
			content: [{ type: "text", text: "Remember potato." }],
			usage: { totalTokens: 123 },
		});
		const text = truncated ? raw.slice(0, raw.indexOf("usage") - 2) : raw;
		const result = contextResult(
			"history__list_items",
			{},
			{ items: [{ role: "assistant", truncated_content: text }] },
		);
		const component = contextPresentation<typeof schema>("history__list_items").renderResult!(
			result,
			{ expanded: true, isPartial: false },
			theme,
			context,
		);
		try {
			const rendered = component.render(100).map(stripTerminalSequences).join("\n");
			expect(rendered).toContain("Remember potato.");
			expect(rendered).not.toContain('"role"');
			expect(rendered).not.toContain("totalTokens");
		} finally {
			if (component instanceof ToolActivity) component.dispose();
		}
	},
);
