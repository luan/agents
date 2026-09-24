import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { filterHistory, historyItems } from "../../core/history.ts";
import { initialWindowId, WINDOW_ENTRY, windowData } from "../../core/state.ts";
import { resolveSession } from "../../runtime/sessions.ts";
import { registerContextTool } from "../register.ts";
import { contextResult } from "../result.ts";
import { historyPreview } from "./result.ts";

const nullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }));
const filters = {
	agent_name: nullableString,
	window_id: nullableString,
	role: Type.Optional(Type.Union([Type.Enum(["user", "assistant", "tool", "system", "developer"]), Type.Null()])),
	tool_name: nullableString,
	tool_namespace: nullableString,
	recent_first: Type.Optional(Type.Boolean()),
	limit,
};

export function registerHistoryTools(pi: ExtensionAPI): (() => void)[] {
	return [
		registerContextTool(
			pi,
			"history__list_windows",
			"List an agent's context windows. IDs are opaque; pass them unchanged to other history tools.",
			Type.Object({ agent_name: nullableString, recent_first: Type.Optional(Type.Boolean()), limit }),
			async (args, ctx) => {
				const session = await resolveSession(ctx, args.agent_name),
					entries = session.historyEntries?.() ?? session.entries(),
					items = historyItems(entries, session.id);
				const ids = [
					initialWindowId(session.id, entries),
					...entries.flatMap((entry) =>
						entry.type === "custom" && entry.customType === WINDOW_ENTRY
							? [windowData(entry.data)?.id].filter((id): id is string => Boolean(id))
							: [],
					),
				];
				const ordered = args.recent_first ? ids.reverse() : ids;
				return contextResult("history__list_windows", args, {
					windows: ordered
						.slice(0, args.limit ?? 50)
						.map((id) => ({ window_id: id, item_count: items.filter((item) => item.window_id === id).length })),
					has_more: ordered.length > (args.limit ?? 50),
				});
			},
		),
		registerContextTool(
			pi,
			"history__list_items",
			"List normalized conversation items, including content previews and stable window/item IDs. Defaults to the current agent.",
			Type.Object({ ...filters, max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })) }),
			async (args, ctx) => {
				const session = await resolveSession(ctx, args.agent_name),
					items = filterHistory(historyItems(session.historyEntries?.() ?? session.entries(), session.id), args),
					take = args.limit ?? 50;
				return contextResult(
					"history__list_items",
					args,
					{
						items: items.slice(0, take).map(({ content, ...item }) => ({
							...item,
							truncated_content: content.slice(0, args.max_chars_per_item ?? 1000),
							total_chars: content.length,
						})),
						has_more: items.length > take,
					},
					items.slice(0, take).map((item) => historyPreview(item, args.max_chars_per_item ?? 1000)),
				);
			},
		),
		registerContextTool(
			pi,
			"history__read_item",
			"Read a bounded character range from a historical item. Use its exact window_id and item_id.",
			Type.Object({
				agent_name: nullableString,
				window_id: Type.String(),
				item_id: Type.String(),
				offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
				limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
			}),
			async (args, ctx) => {
				const session = await resolveSession(ctx, args.agent_name),
					item = historyItems(session.historyEntries?.() ?? session.entries(), session.id).find(
						(item) => item.window_id === args.window_id && item.item_id === args.item_id,
					);
				if (!item) throw new Error("History item not found in this window");
				const offset = args.offset_chars ?? 0,
					end = Math.min(item.content.length, offset + (args.limit_chars ?? 10000));
				return contextResult(
					"history__read_item",
					args,
					{
						...item,
						content: item.content.slice(offset, end),
						offset_chars: offset,
						total_chars: item.content.length,
						next_offset: end < item.content.length ? end : null,
					},
					offset === 0 && end === item.content.length ? [historyPreview(item, 100000)] : undefined,
				);
			},
		),
		registerContextTool(
			pi,
			"history__search_contents",
			"Search history with a case-sensitive literal substring. Filter by agent, window, role, or tool.",
			Type.Object({ ...filters, query: Type.String({ maxLength: 10000 }) }),
			async (args, ctx) => {
				const session = await resolveSession(ctx, args.agent_name),
					items = filterHistory(historyItems(session.historyEntries?.() ?? session.entries(), session.id), args),
					take = args.limit ?? 50;
				return contextResult(
					"history__search_contents",
					args,
					{
						items: items.slice(0, take).map(({ content, ...item }) => {
							const offset = content.indexOf(args.query);
							return {
								...item,
								offset_chars: offset,
								truncated_content: content.slice(Math.max(0, offset - 120), offset + 1000),
							};
						}),
						has_more: items.length > take,
					},
					items.slice(0, take).map((item) => historyPreview(item, 1000, args.query)),
				);
			},
		),
	];
}
