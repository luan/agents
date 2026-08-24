import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ToolSearchMatch } from "../../search.ts";

export interface ToolSearchRankedMatch {
	name: string;
	description: string;
	score: number;
}

export interface ToolSearchDetails {
	version: 2;
	tool: "tool_search";
	status: "loaded" | "no_match";
	input: {
		query: string;
		normalizedQuery: string;
		limit: number;
	};
	rankedMatches: ToolSearchRankedMatch[];
	activation: {
		before: string[];
		added: string[];
		after: string[];
	};
	counts: {
		registered: number;
		searchable: number;
		matches: number;
		added: number;
	};
	timing: {
		durationMs: number;
	};
}

interface ToolSearchResultInput {
	query: string;
	limit: number;
	matches: readonly ToolSearchMatch[];
	activeBefore: readonly string[];
	added: readonly string[];
	registeredCount: number;
	searchableCount: number;
	durationMs: number;
}

export function createToolSearchResult(input: ToolSearchResultInput): AgentToolResult<ToolSearchDetails> {
	const rankedMatches = input.matches.map((match) => ({
		name: match.tool.name,
		description: match.tool.description,
		score: match.score,
	}));
	const after = [...new Set([...input.activeBefore, ...input.added])];
	const status = rankedMatches.length === 0 ? "no_match" : "loaded";
	return {
		content: [
			{
				type: "text",
				text:
					status === "no_match"
						? `No inactive tools match ${JSON.stringify(input.query)}.`
						: `Loaded tools: ${input.added.join(", ")}.`,
			},
		],
		details: {
			version: 2,
			tool: "tool_search",
			status,
			input: { query: input.query, normalizedQuery: input.query.trim(), limit: input.limit },
			rankedMatches,
			activation: { before: [...input.activeBefore], added: [...input.added], after },
			counts: {
				registered: input.registeredCount,
				searchable: input.searchableCount,
				matches: rankedMatches.length,
				added: input.added.length,
			},
			timing: { durationMs: input.durationMs },
		},
	};
}
