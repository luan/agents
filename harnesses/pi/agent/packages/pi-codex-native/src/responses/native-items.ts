export interface WebSearchCallItem {
	type: "web_search_call";
	id: string;
	status?: string;
	action?: unknown;
	results?: unknown;
}

export interface WebSearchCallBlock {
	type: "web_search_call";
	item: WebSearchCallItem;
}

export type ImageDetail = "auto" | "high" | "original";

export function isWebSearchCallBlock(block: { type: string; item?: unknown }): block is WebSearchCallBlock {
	return (
		block.type === "web_search_call" &&
		typeof block.item === "object" &&
		block.item !== null &&
		(block.item as Record<string, unknown>).type === "web_search_call"
	);
}

export function sanitizeWebSearchCallItem(item: unknown): WebSearchCallItem | undefined {
	if (!item || typeof item !== "object") return undefined;
	const candidate = item as Record<string, unknown>;
	if (candidate.type !== "web_search_call" || typeof candidate.id !== "string" || candidate.id.length === 0)
		return undefined;
	return {
		type: "web_search_call",
		id: candidate.id,
		...(typeof candidate.status === "string" ? { status: candidate.status } : {}),
		...(candidate.action !== undefined ? { action: candidate.action } : {}),
		...(candidate.results !== undefined ? { results: candidate.results } : {}),
	};
}

export function imageDetailForResponses(block: unknown): ImageDetail {
	const detail = block && typeof block === "object" ? (block as Record<string, unknown>).detail : undefined;
	return detail === "high" || detail === "original" ? detail : "auto";
}
