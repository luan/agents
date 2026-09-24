import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { initialWindowId, isRecord, WINDOW_ENTRY, windowData } from "./state.ts";

export interface HistoryItem {
	window_id: string;
	item_id: string;
	role: string;
	content: string;
	tool_name?: string;
	tool_namespace?: string;
	ordinal: number;
}
export interface HistoryFilter {
	window_id?: string | null;
	role?: string | null;
	tool_name?: string | null;
	tool_namespace?: string | null;
	recent_first?: boolean;
	query?: string;
}

export function historyItems(entries: readonly SessionEntry[], sessionId: string): HistoryItem[] {
	let windowId = initialWindowId(sessionId, entries);
	const items: HistoryItem[] = [];
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === WINDOW_ENTRY) {
			const state = windowData(entry.data);
			if (state) windowId = state.id;
			continue;
		}
		if (entry.type === "branch_summary") {
			items.push({
				window_id: windowId,
				item_id: entry.id,
				role: "assistant",
				content: entry.summary,
				ordinal: items.length,
			});
			continue;
		}
		if (entry.type !== "message" && entry.type !== "custom_message") continue;
		const message = entry.type === "message" ? entry.message : undefined;
		const auditRole =
			entry.type === "custom_message" &&
			isRecord(entry.details) &&
			(entry.details.role === "developer" || entry.details.role === "system")
				? entry.details.role
				: "user";
		const role = message?.role === "toolResult" ? "tool" : (message?.role ?? auditRole);
		const toolName = message?.role === "toolResult" ? message.toolName : undefined;
		const content = entry.type === "custom_message" ? entry.content : entry.message;
		items.push({
			window_id: windowId,
			item_id: entry.id,
			role,
			content: typeof content === "string" ? content : JSON.stringify(content),
			...(toolName
				? {
						tool_name: toolName.split("__").at(-1),
						tool_namespace: toolName.includes("__") ? toolName.split("__").slice(0, -1).join("__") : "functions",
					}
				: {}),
			ordinal: items.length,
		});
	}
	return items;
}
export function filterHistory(items: readonly HistoryItem[], filter: HistoryFilter): HistoryItem[] {
	const selected = items.filter(
		(item) =>
			(!filter.window_id || item.window_id === filter.window_id) &&
			(!filter.role || item.role === filter.role) &&
			(!filter.tool_name || item.tool_name === filter.tool_name) &&
			(!filter.tool_namespace || item.tool_namespace === filter.tool_namespace) &&
			(filter.query === undefined || item.content.includes(filter.query)),
	);
	return filter.recent_first ? selected.reverse() : selected;
}
