import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SIDE_PANEL_STATE_ENTRY_TYPE = "side-panel:layout-v1";

export interface SidePanelLayoutState {
	readonly version: 1;
	readonly visible: boolean;
	readonly width?: number;
	readonly order: readonly string[];
	readonly activeTabId?: string;
}

export const EMPTY_SIDE_PANEL_STATE: SidePanelLayoutState = {
	version: 1,
	visible: false,
	order: [],
};

export function latestSidePanelLayout(entries: readonly SessionEntry[]): SidePanelLayoutState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== SIDE_PANEL_STATE_ENTRY_TYPE) continue;
		const parsed = parseSidePanelLayout(entry.data);
		if (parsed) return parsed;
	}
	return undefined;
}

// type-boundary: Pi session custom-entry data is untyped; this parser validates the complete layout state.
type SidePanelLayoutBoundary = unknown;

function parseSidePanelLayout(value: SidePanelLayoutBoundary): SidePanelLayoutState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<Record<keyof SidePanelLayoutState, unknown>>;
	if (candidate.version !== 1 || typeof candidate.visible !== "boolean" || !Array.isArray(candidate.order))
		return undefined;
	if (!candidate.order.every((id) => typeof id === "string" && id.length > 0)) return undefined;
	if (new Set(candidate.order).size !== candidate.order.length) return undefined;
	if (candidate.width !== undefined && (!Number.isSafeInteger(candidate.width) || Number(candidate.width) <= 0))
		return undefined;
	if (candidate.activeTabId !== undefined && typeof candidate.activeTabId !== "string") return undefined;
	return {
		version: 1,
		visible: candidate.visible,
		...(typeof candidate.width === "number" ? { width: candidate.width } : {}),
		order: candidate.order,
		...(typeof candidate.activeTabId === "string" ? { activeTabId: candidate.activeTabId } : {}),
	};
}
