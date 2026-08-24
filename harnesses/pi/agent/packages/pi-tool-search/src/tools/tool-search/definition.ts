import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MAX_RESULTS, searchTools, type ToolMetadata } from "../../search.ts";
import { renderToolSearchCall, renderToolSearchResult } from "./presentation.ts";
import { createToolSearchResult, type ToolSearchDetails } from "./result.ts";

export const TOOL_SEARCH_NAME = "tool_search";

const TOOL_SEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "The capability or task to find a tool for.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: MAX_RESULTS,
			description: `The maximum number of tools to load. Defaults to ${MAX_RESULTS}.`,
		},
	},
	required: ["query"],
	additionalProperties: false,
} as const;

export interface ToolSearchScope {
	tools(): readonly ToolMetadata[];
	active(): readonly string[];
	setActive(names: readonly string[]): void;
}

export function createToolSearchTool(
	scope: ToolSearchScope,
): ToolDefinition<typeof TOOL_SEARCH_PARAMETERS, ToolSearchDetails> {
	return {
		name: TOOL_SEARCH_NAME,
		label: "Tool Search",
		description: `Search the inactive tools in this Pi session when the task needs a capability that is not active. Matches and loads at most ${MAX_RESULTS} tools.`,
		parameters: TOOL_SEARCH_PARAMETERS,
		executionMode: "sequential",
		renderShell: "self",
		renderCall(parameters, theme, context) {
			return renderToolSearchCall(parameters.query, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolSearchResult(result, theme, context, options.expanded);
		},
		async execute(_toolCallId, parameters) {
			return executeToolSearch(parameters, scope);
		},
	};
}

export async function executeToolSearch(
	parameters: { query: string; limit?: number },
	scope: ToolSearchScope,
): Promise<ReturnType<typeof createToolSearchResult>> {
	const startedAt = performance.now();
	const activeTools = [...scope.active()];
	const activeNames = new Set(activeTools);
	const allTools = [...scope.tools()];
	const searchableTools = allTools.filter((tool) => !activeNames.has(tool.name));
	const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(parameters.limit ?? MAX_RESULTS) || MAX_RESULTS));
	const matches = searchTools(parameters.query, searchableTools, limit);

	if (matches.length === 0) {
		return createToolSearchResult({
			query: parameters.query,
			limit,
			matches,
			activeBefore: activeTools,
			added: [],
			registeredCount: allTools.length,
			searchableCount: searchableTools.length,
			durationMs: performance.now() - startedAt,
		});
	}

	const added = matches.map((match) => match.tool.name);
	scope.setActive([...new Set([...activeTools, ...added])]);
	return createToolSearchResult({
		query: parameters.query,
		limit,
		matches,
		activeBefore: activeTools,
		added,
		registeredCount: allTools.length,
		searchableCount: searchableTools.length,
		durationMs: performance.now() - startedAt,
	});
}
