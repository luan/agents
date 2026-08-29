import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SIDE_CHAT_STATE_ENTRY_TYPE = "side-chat:tabs-v1";

export interface SideChatStateTab {
	readonly id: string;
	readonly label: string;
	readonly sessionId: string;
}

export interface SideChatState {
	readonly version: 1;
	readonly nextNumber: number;
	readonly tabs: readonly SideChatStateTab[];
}

export function latestSideChatState(entries: readonly SessionEntry[]): SideChatState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== SIDE_CHAT_STATE_ENTRY_TYPE) continue;
		const parsed = parseState(entry.data);
		if (parsed) return parsed;
	}
	return undefined;
}

type StateBoundary = unknown;

function parseState(value: StateBoundary): SideChatState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { version?: unknown; nextNumber?: unknown; tabs?: unknown };
	if (candidate.version !== 1 || !Number.isSafeInteger(candidate.nextNumber) || Number(candidate.nextNumber) < 1)
		return undefined;
	if (!Array.isArray(candidate.tabs)) return undefined;
	const tabs: SideChatStateTab[] = [];
	for (const item of candidate.tabs) {
		if (!item || typeof item !== "object") return undefined;
		const tab = item as { id?: unknown; label?: unknown; sessionId?: unknown };
		if (typeof tab.id !== "string" || typeof tab.label !== "string" || typeof tab.sessionId !== "string")
			return undefined;
		if (!/^side-chat:[0-9a-f-]{36}$/u.test(tab.id) || !/^[0-9a-f-]{36}$/u.test(tab.sessionId)) return undefined;
		tabs.push({ id: tab.id, label: tab.label, sessionId: tab.sessionId });
	}
	return { version: 1, nextNumber: Number(candidate.nextNumber), tabs };
}
