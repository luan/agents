import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { historyText } from "./history/result.ts";
import { ComponentStack } from "@luan.sh/pi-libtui";
import { settleToolCallPreview, ToolActivity, toolCallPreview, type ToolActivityView } from "@luan.sh/pi-libtui/tool";
import type { TSchema } from "typebox";
import { type JsonValue, jsonValue } from "../core/state.ts";
import type { ContextToolDetails } from "./result.ts";

const actions: Record<string, { queued: string; completed: string }> = {
	notes__write_file: { queued: "Save note", completed: "Saved note" },
	notes__append_to_file: { queued: "Update note", completed: "Updated note" },
	notes__read_file: { queued: "Read note", completed: "Read note" },
	notes__list_files_by_prefix: { queued: "List notes", completed: "Listed notes" },
	notes__search_contents: { queued: "Search notes", completed: "Searched notes" },
	history__list_windows: { queued: "List context windows", completed: "Listed context windows" },
	history__list_items: { queued: "Browse history", completed: "Browsed history" },
	history__search_contents: { queued: "Search history", completed: "Searched history" },
	history__read_item: { queued: "Read history", completed: "Read history" },
	new_context: { queued: "Start fresh context", completed: "Requested fresh context" },
	get_context_remaining: { queued: "Check context space", completed: "Context available" },
};

export function contextPresentation<Schema extends TSchema>(
	tool: string,
): Pick<ToolDefinition<Schema, ContextToolDetails>, "renderShell" | "renderCall" | "renderResult"> {
	const labels = actions[tool] ?? { queued: "Read context", completed: "Read context" };
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (context.executionStarted) return new ComponentStack();
			return toolCallPreview(
				context.state,
				new ToolActivity({
					theme,
					requestRender: context.invalidate,
					view: { action: { verb: labels.queued, detail: inputDetail(jsonValue(args)), status: "queued" } },
				}),
			);
		},
		renderResult(result, options, theme, context) {
			settleToolCallPreview(context.state);
			const details = result.details;
			const failed = context.isError || !details || details.version !== 1 || details.tool !== tool;
			const view: ToolActivityView = failed
				? {
						mode: options.expanded ? "full" : "preview",
						action: { verb: `${labels.queued} failed`, detail: inputDetail(jsonValue(context.args)), status: "failed" },
						failure: result.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
					}
				: contextView(details, labels.completed, options.expanded);
			return ToolActivity.reuse(context.lastComponent, {
				theme,
				requestRender: context.invalidate,
				view,
				previewRows: 4,
				fullRows: 200,
				maxCharacters: 100_000,
			});
		},
	};
}

function inputDetail(input: JsonValue): string | undefined {
	return string(input, "path") || string(input, "query") || string(input, "prefix") || string(input, "agent_name");
}

function contextView(details: ContextToolDetails, verb: string, expanded: boolean): ToolActivityView {
	const { tool, input, output } = details;
	const previews = new Map(details.history?.map((item) => [item.itemId, item.text]));
	let detail = inputDetail(input);
	let body: string | undefined;
	let meta: string[] | undefined;
	if (tool === "new_context") detail = "Checkpoint retained";
	else if (tool === "get_context_remaining") {
		const tokens = field(output, "tokens_left");
		detail = typeof tokens === "number" ? `${tokens.toLocaleString("en-US")} tokens left` : "Usage not available yet";
	} else if (tool === "notes__write_file" || tool === "notes__append_to_file") {
		body = string(input, "text");
		const bytes = field(output, "bytes");
		if (typeof bytes === "number") meta = [`${bytes.toLocaleString("en-US")} bytes`];
	} else if (tool === "notes__read_file") {
		body = string(output, "text");
		const lines = field(output, "total_lines");
		if (typeof lines === "number") meta = [count(lines, "line")];
	} else if (tool === "notes__list_files_by_prefix") {
		const files = array(output, "files");
		meta = [count(files.length, "note")];
		body = files.map((file) => `${string(file, "path")} · ${field(file, "bytes") ?? 0} bytes`).join("\n");
		if (!files.length) verb = "No notes found";
	} else if (tool === "notes__search_contents") {
		const matches = array(output, "matches");
		meta = [count(matches.length, "match", "matches")];
		body = matches
			.map((match) => `${string(match, "path")}:${field(match, "line")}\n${string(match, "text")}`)
			.join("\n\n");
		if (!matches.length) verb = "No note matches";
	} else if (tool === "history__list_windows") {
		const windows = array(output, "windows");
		meta = [count(windows.length, "window")];
		body = windows
			.map(
				(window, index) =>
					`Window ${index + 1} · ${field(window, "item_count")} items${expanded ? `\n${string(window, "window_id")}` : ""}`,
			)
			.join("\n");
	} else if (tool === "history__read_item") {
		detail = string(output, "role") || "Conversation item";
		body = previews.get(string(output, "item_id")) ?? historyText(string(output, "content"));
		if (expanded) body += historyReference(output);
		if (typeof field(output, "next_offset") === "number") meta = ["More content available"];
	} else {
		const items = array(output, "items");
		meta = [
			count(
				items.length,
				tool === "history__search_contents" ? "match" : "item",
				tool === "history__search_contents" ? "matches" : "items",
			),
		];
		body = items
			.map(
				(item) =>
					`${string(item, "role") || "Message"}${string(item, "tool_name") ? ` · ${string(item, "tool_name")}` : ""}\n${previews.get(string(item, "item_id")) ?? historyText(string(item, "truncated_content"))}${expanded ? historyReference(item) : ""}`,
			)
			.join("\n\n");
		if (!items.length) verb = tool === "history__search_contents" ? "No history matches" : "No history items";
	}
	if (field(output, "has_more") === true) meta = [...(meta ?? []), "More available"];
	return {
		action: { verb, detail, meta, status: "succeeded" },
		payload: body ? { kind: "text", text: body, revision: 0 } : undefined,
		mode: expanded ? "full" : "preview",
	};
}

function historyReference(item: JsonValue): string {
	return `\nWindow: ${string(item, "window_id")}\nItem: ${string(item, "item_id")}`;
}
function field(value: JsonValue, key: string): JsonValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;
}
function string(value: JsonValue, key: string): string {
	const result = field(value, key);
	return typeof result === "string" ? result : "";
}
function array(value: JsonValue, key: string): JsonValue[] {
	const result = field(value, key);
	return Array.isArray(result) ? result : [];
}
function count(value: number, singular: string, plural = `${singular}s`): string {
	return `${value} ${value === 1 ? singular : plural}`;
}
