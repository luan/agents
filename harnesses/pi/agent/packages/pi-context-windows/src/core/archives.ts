import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./state.ts";
export const ARCHIVE_ENTRY = "pi-context/archive/v1";
/** Expand only archives referenced by this branch, never unrelated session branches. */
export function archivedHistory(all: readonly SessionEntry[], branch: readonly SessionEntry[]): SessionEntry[] {
	const byId = new Map(all.map((entry) => [entry.id, entry]));
	const seen = new Set<string>();
	const expanded: SessionEntry[] = [];
	const pending = branch.map((entry) => ({ entry, expanded: false })).reverse();
	while (pending.length) {
		const item = pending.pop()!;
		const entry = item.entry;
		if (item.expanded) {
			expanded.push(entry);
			continue;
		}
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		if (entry.type !== "custom" || entry.customType !== ARCHIVE_ENTRY) {
			expanded.push(entry);
			continue;
		}
		const data = entry.data;
		if (!isRecord(data) || data.version !== 1 || typeof data.from !== "string" || typeof data.base !== "string")
			throw new Error("Invalid context archive");
		pending.push({ entry, expanded: true });
		const visited = new Set<string>();
		let id: string | null = data.from;
		while (id !== data.base) {
			if (!id || visited.has(id)) throw new Error("Context archive path is invalid");
			visited.add(id);
			const archived = byId.get(id);
			if (!archived) throw new Error("Context archive entry is missing");
			pending.push({ entry: archived, expanded: false });
			id = archived.parentId;
		}
	}
	return expanded;
}
