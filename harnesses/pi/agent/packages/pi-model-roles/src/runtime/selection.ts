import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const MODEL_ROLE_SELECTION_ENTRY = "pi-model-roles/selection";

export interface ModelRoleSelectionData {
	version: 1;
	role: string | null;
}

type SessionData = Extract<SessionEntry, { type: "custom" }>["data"];

function isSelectionData(data: SessionData): data is ModelRoleSelectionData {
	if (!data || typeof data !== "object" || Array.isArray(data)) return false;
	const candidate = data as Partial<ModelRoleSelectionData>;
	return candidate.version === 1 && (typeof candidate.role === "string" || candidate.role === null);
}

export function latestRoleSelection(entries: readonly SessionEntry[]): string | null | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== MODEL_ROLE_SELECTION_ENTRY || !isSelectionData(entry.data))
			continue;
		return entry.data.role;
	}
	return undefined;
}
