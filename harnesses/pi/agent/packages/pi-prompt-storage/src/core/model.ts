import { fuzzyMatch } from "@earendil-works/pi-tui";

export type PromptKind = "stash" | "history";
export type PromptAction = "apply" | "pop" | "drop";

export interface PromptItem {
	kind: PromptKind;
	id: number | string;
	text: string;
	timestamp: number;
	cwd: string;
	sessionPath?: string;
	sessionName?: string;
	hasImages?: boolean;
}

export interface PromptStorageConfig {
	shortcuts: { stash: string };
	history: { includeSlashCommands: boolean; maxResults: number };
	picker: { maxVisible: number; enterAction: "apply" | "pop" };
}

export interface IndexProgress {
	phase: "sessions" | "prompts";
	loaded: number;
	total: number;
}

export function preview(value: string, max = 90): string {
	const compact = value.replace(/\s+/gu, " ").trim();
	return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 1))}…`;
}

/** Keep the above-editor stash status to one row; only multiple stashes need a latest-item hint. */
export function stashWidgetLine(items: readonly PromptItem[]): string {
	const count = `Prompt stash (${items.length})`;
	const latest = items.length > 1 ? items[0] : undefined;
	return latest ? `${count} • ${preview(latest.text, 96)}` : count;
}

export function sourceLabel(item: PromptItem): string {
	if (item.kind === "stash") return preview(item.text, 48);
	return item.sessionName?.trim() || "History";
}

function searchTokens(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
}

function searchableFields(item: PromptItem): string[] {
	return item.sessionName?.trim() ? [item.text, item.sessionName] : [item.text];
}

function itemMatchScore(item: PromptItem, tokens: readonly string[]): number | undefined {
	const phrase = tokens.join(" ");
	const text = item.text.toLowerCase();
	let score = text === phrase ? -10_000 : 0;
	const phraseIndex = text.indexOf(phrase);
	if (phraseIndex >= 0 && text !== phrase) score -= 5_000 + phraseIndex * 0.1;
	for (const token of tokens) {
		let best: number | undefined;
		for (const field of searchableFields(item)) {
			const lower = field.toLowerCase();
			const exactIndex = lower.indexOf(token);
			if (exactIndex >= 0) {
				best = Math.min(best ?? Number.POSITIVE_INFINITY, -1_000 + exactIndex * 0.1);
				continue;
			}
			const match = fuzzyMatch(token, field);
			if (match.matches) best = Math.min(best ?? Number.POSITIVE_INFINITY, match.score);
		}
		if (best === undefined) return undefined;
		score += best;
	}
	return score;
}

/** Search prompt text and session names, with relevance before recency. */
export function filterPrompts(items: readonly PromptItem[], query: string, limit: number): PromptItem[] {
	const boundedLimit = Math.max(0, Math.floor(limit));
	const tokens = searchTokens(query);
	if (tokens.length === 0) return items.slice(0, boundedLimit);
	return items
		.map((item) => ({ item, score: itemMatchScore(item, tokens) }))
		.filter((result): result is { item: PromptItem; score: number } => result.score !== undefined)
		.sort((left, right) => left.score - right.score || right.item.timestamp - left.item.timestamp)
		.map((result) => result.item)
		.slice(0, boundedLimit);
}

export function queryMatchIndexes(text: string, query: string): ReadonlySet<number> {
	const lower = text.toLowerCase();
	const indexes = new Set<number>();
	for (const token of searchTokens(query)) {
		let from = 0;
		while (from < lower.length) {
			const index = lower.indexOf(token, from);
			if (index < 0) break;
			for (let offset = 0; offset < token.length; offset++) indexes.add(index + offset);
			from = index + Math.max(1, token.length);
		}
	}
	return indexes;
}
