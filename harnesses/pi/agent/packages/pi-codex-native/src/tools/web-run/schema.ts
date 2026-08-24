const SEARCH_QUERY = {
	type: "object",
	properties: {
		q: { type: "string" },
		recency: { type: "integer", minimum: 0 },
		domains: { type: "array", items: { type: "string" } },
	},
	required: ["q"],
	additionalProperties: false,
} as const;

export const WEB_RUN_SCHEMA = {
	type: "object",
	properties: {
		search_query: { type: "array", items: SEARCH_QUERY },
		image_query: { type: "array", items: SEARCH_QUERY },
		open: {
			type: "array",
			items: {
				type: "object",
				properties: { ref_id: { type: "string" }, lineno: { type: "integer", minimum: 0 } },
				required: ["ref_id"],
				additionalProperties: false,
			},
		},
		click: {
			type: "array",
			items: {
				type: "object",
				properties: { ref_id: { type: "string" }, id: { type: "integer", minimum: 0 } },
				required: ["ref_id", "id"],
				additionalProperties: false,
			},
		},
		find: {
			type: "array",
			items: {
				type: "object",
				properties: { ref_id: { type: "string" }, pattern: { type: "string" } },
				required: ["ref_id", "pattern"],
				additionalProperties: false,
			},
		},
		screenshot: {
			type: "array",
			items: {
				type: "object",
				properties: { ref_id: { type: "string" }, pageno: { type: "integer", minimum: 0 } },
				required: ["ref_id", "pageno"],
				additionalProperties: false,
			},
		},
		finance: {
			type: "array",
			items: {
				type: "object",
				properties: {
					ticker: { type: "string" },
					type: { type: "string", enum: ["equity", "fund", "crypto", "index"] },
					market: { type: "string" },
				},
				required: ["ticker", "type"],
				additionalProperties: false,
			},
		},
		weather: {
			type: "array",
			items: {
				type: "object",
				properties: {
					location: { type: "string" },
					start: { type: "string" },
					duration: { type: "integer", minimum: 0 },
				},
				required: ["location"],
				additionalProperties: false,
			},
		},
		sports: {
			type: "array",
			items: {
				type: "object",
				properties: {
					tool: { type: "string", enum: ["sports"] },
					fn: { type: "string", enum: ["schedule", "standings"] },
					league: { type: "string", enum: ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"] },
					team: { type: "string" },
					opponent: { type: "string" },
					date_from: { type: "string" },
					date_to: { type: "string" },
					num_games: { type: "integer", minimum: 0 },
					locale: { type: "string" },
				},
				required: ["fn", "league"],
				additionalProperties: false,
			},
		},
		time: {
			type: "array",
			items: {
				type: "object",
				properties: { utc_offset: { type: "string" } },
				required: ["utc_offset"],
				additionalProperties: false,
			},
		},
		response_length: { type: "string", enum: ["short", "medium", "long"] },
		settings: {
			type: "object",
			properties: { search_context_size: { type: "string", enum: ["low", "medium", "high"] } },
			additionalProperties: false,
		},
	},
	additionalProperties: false,
} as const;

export type WebRunParameters = Record<string, unknown>;
