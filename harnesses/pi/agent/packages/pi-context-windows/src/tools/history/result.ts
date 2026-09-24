import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { HistoryItem } from "../../core/history.ts";
import { type JsonValue, jsonValue } from "../../core/state.ts";

export function historyPreview(item: HistoryItem, limit: number, query?: string): { itemId: string; text: string } {
	const text = historyText(item.content);
	const offset = query ? Math.max(0, text.indexOf(query) - 120) : 0;
	const end = Math.min(text.length, offset + limit);
	return {
		itemId: item.item_id,
		text: `${offset ? "…" : ""}${text.slice(offset, end)}${end < text.length ? "…" : ""}`,
	};
}

/** Extract readable content before slicing search previews through serialized messages. */
export function historyText(text: string): string {
	if (!text.trimStart().startsWith("{")) return text;
	const message = jsonValue(parseStreamingJson(text));
	const content = field(message, "content");
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return text;
	return content
		.map((part) => {
			const type = string(part, "type");
			if (type === "text") return string(part, "text");
			if (type === "thinking") return string(part, "thinking");
			if (type === "image") return "[Image]";
			if (type === "audio") return "[Audio]";
			if (type !== "toolCall") return "";
			const name = string(part, "name");
			const args = field(part, "arguments") ?? {};
			const detail = string(args, "path") || string(args, "query");
			const labels: Record<string, string> = {
				request_user_input_async: "Ask for input",
				send_message_to_user_async: "Send message",
				clock__curr_time: "Check time",
				clock__sleep: "Wait",
				new_context: "Start fresh context",
				exec: "Run code",
			};
			const label = labels[name] ?? name.replaceAll("__", " · ").replaceAll("_", " ");
			const questions = field(args, "questions");
			const body =
				string(args, "code") ||
				string(args, "cmd") ||
				string(args, "message") ||
				(Array.isArray(questions) ? questions.map((question) => string(question, "title")).join("\n") : "");
			return `${label}${detail ? ` · ${detail}` : ""}${body ? `\n${body}` : ""}`;
		})
		.filter(Boolean)
		.join("\n\n");
}

function field(value: JsonValue, key: string): JsonValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;
}
function string(value: JsonValue, key: string): string {
	const result = field(value, key);
	return typeof result === "string" ? result : "";
}
