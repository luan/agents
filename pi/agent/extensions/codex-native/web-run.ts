import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codexChatGptCredentials } from "./codex-auth";
import { supportsNativeWebSearch } from "./native-tools";

// This is the cell-side half of codex's `web.run`: native-tools.ts:132 keeps `web_search` as the provider's own tool.
export const WEB_RUN_TOOL_NAME = "web__run";

const SEARCH_PATH = "alpha/search";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

type SearchResponse = {
	output?: unknown;
	results?: unknown;
};

type WebRunArgs = Record<string, unknown>;

/** `alpha/search` sits beside `codex/responses`; both use the same Codex base URL. */
export function resolveCodexSearchUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return `${normalized.slice(0, -"/responses".length)}/${SEARCH_PATH}`;
	if (normalized.endsWith("/codex")) return `${normalized}/${SEARCH_PATH}`;
	return `${normalized}/codex/${SEARCH_PATH}`;
}

const queryItems = {
	type: "object",
	properties: {
		q: { type: "string", description: "Search query." },
		recency: { type: "number", description: "Restrict to this many recent days." },
		domains: { type: "array", items: { type: "string" }, description: "Restrict to these domains." },
	},
	required: ["q"],
	additionalProperties: false,
} as const;

const WEB_RUN_SCHEMA = {
	type: "object",
	properties: {
		search_query: {
			type: "array",
			items: queryItems,
			description: "Search the internet. At most 4 per call; over 3 needs response_length medium or long.",
		},
		image_query: { type: "array", items: queryItems, description: "Search images." },
		open: {
			type: "array",
			description: "Open pages by result ref_id or by URL.",
			items: {
				type: "object",
				properties: {
					ref_id: { type: "string", description: "A ref_id from an earlier result, or a literal URL." },
					lineno: { type: "number", description: "Line to position the page at." },
				},
				required: ["ref_id"],
				additionalProperties: false,
			},
		},
		click: {
			type: "array",
			description: "Follow a numbered link inside a page already opened in this session.",
			items: {
				type: "object",
				properties: {
					ref_id: { type: "string" },
					id: { type: "number", description: "The numbered link id shown in the page text." },
				},
				required: ["ref_id", "id"],
				additionalProperties: false,
			},
		},
		find: {
			type: "array",
			description: "Find a text pattern in a page.",
			items: {
				type: "object",
				properties: { ref_id: { type: "string" }, pattern: { type: "string" } },
				required: ["ref_id", "pattern"],
				additionalProperties: false,
			},
		},
		screenshot: {
			type: "array",
			description: "Screenshot a PDF page.",
			items: {
				type: "object",
				properties: { ref_id: { type: "string" }, pageno: { type: "number", description: "Zero-indexed page." } },
				required: ["ref_id", "pageno"],
				additionalProperties: false,
			},
		},
		finance: {
			type: "array",
			description: "Look up a price.",
			items: {
				type: "object",
				properties: {
					ticker: { type: "string" },
					type: { type: "string", enum: ["equity", "fund", "crypto", "index"] },
					market: { type: "string", description: 'ISO 3166-1 alpha-3 code, "OTC", or "" for crypto.' },
				},
				required: ["ticker", "type"],
				additionalProperties: false,
			},
		},
		weather: {
			type: "array",
			description: "Look up a forecast.",
			items: {
				type: "object",
				properties: {
					location: { type: "string", description: '"Country, Area, City".' },
					start: { type: "string", description: "YYYY-MM-DD; defaults to today." },
					duration: { type: "number", description: "Days to return; defaults to 7." },
				},
				required: ["location"],
				additionalProperties: false,
			},
		},
		sports: {
			type: "array",
			description: "Look up a schedule or standings.",
			items: {
				type: "object",
				properties: {
					fn: { type: "string", enum: ["schedule", "standings"] },
					league: {
						type: "string",
						enum: ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"],
					},
					team: { type: "string", description: "The 3 or 4 letter broadcast alias." },
					opponent: { type: "string" },
					date_from: { type: "string", description: "YYYY-MM-DD." },
					date_to: { type: "string", description: "YYYY-MM-DD." },
					num_games: { type: "number" },
					locale: { type: "string" },
				},
				required: ["fn", "league"],
				additionalProperties: false,
			},
		},
		time: {
			type: "array",
			description: "Look up a local time.",
			items: {
				type: "object",
				properties: { utc_offset: { type: "string", description: 'Formatted like "+03:00".' } },
				required: ["utc_offset"],
				additionalProperties: false,
			},
		},
		response_length: { type: "string", enum: ["short", "medium", "long"], description: "Defaults to short." },
	},
	additionalProperties: false,
} as const;

const WEB_RUN_DESCRIPTION = [
	"Search the internet and read what it returns. Combine commands in one call to finish in one round trip.",
	"",
	'`search_query` searches; `image_query` searches images. Each result carries a `ref_id` like "turn0search0".',
	"Feed a `ref_id` to `open`, `click`, `find` or `screenshot` to read the page behind a result, or pass a URL to `open` directly.",
	"`finance`, `weather`, `sports` and `time` answer without a page.",
	"A `ref_id` stays resolvable for the rest of the session, so a search and its follow-up reads can be separate calls.",
	"Reference ids belong to this tool. Cite the URL in a result, never the `ref_id`.",
].join("\n");

/** The session id keys the endpoint's `ref_id` table, so `open` after `search_query` needs the same one. */
function searchSessionId(ctx: unknown): string {
	const fromCtx = (
		ctx as { sessionManager?: { getSessionId?: () => string | undefined } } | undefined
	)?.sessionManager?.getSessionId?.();
	return fromCtx ?? "pi-web-run";
}

export function buildSearchRequestBody(args: WebRunArgs, model: string, sessionId: string): Record<string, unknown> {
	return {
		id: sessionId,
		model,
		commands: args,
		settings: { allowed_callers: ["direct"], external_web_access: true },
	};
}

export function summarizeWebRunCommand(args: unknown): string {
	const commands = (args ?? {}) as WebRunArgs;
	const queries = [...asItems(commands.search_query), ...asItems(commands.image_query)]
		.map((item) => (typeof item.q === "string" ? item.q : undefined))
		.filter((q): q is string => Boolean(q));
	if (queries.length > 0) return queries.join(", ");
	const refs = ["open", "click", "find", "screenshot"].flatMap((key) =>
		asItems(commands[key]).map((item) => (typeof item.ref_id === "string" ? item.ref_id : undefined)),
	);
	const namedRef = refs.find((ref): ref is string => Boolean(ref));
	if (namedRef) return namedRef;
	const lookup = ["finance", "weather", "sports", "time"].find((key) => asItems(commands[key]).length > 0);
	return lookup ?? "web";
}

function asItems(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function resultCount(results: unknown): number {
	return Array.isArray(results) ? results.length : 0;
}

export function createWebRunTool(): ToolDefinition<any> {
	return {
		name: WEB_RUN_TOOL_NAME,
		label: WEB_RUN_TOOL_NAME,
		description: WEB_RUN_DESCRIPTION,
		parameters: Type.Unsafe<WebRunArgs>(WEB_RUN_SCHEMA),
		async execute(_toolCallId, params, signal, _onUpdate, ctx: { model?: ExtensionContext["model"] }) {
			if (!supportsNativeWebSearch(ctx?.model)) {
				throw new Error(`${WEB_RUN_TOOL_NAME} is only available with openai-codex models`);
			}
			const args = (params ?? {}) as WebRunArgs;
			if (Object.keys(args).length === 0) {
				throw new Error(`${WEB_RUN_TOOL_NAME} needs at least one command, such as search_query.`);
			}
			const { token, accountId } = codexChatGptCredentials();
			const headers: Record<string, string> = {
				Authorization: `Bearer ${token}`,
				originator: "pi",
				"content-type": "application/json",
			};
			if (accountId) headers["chatgpt-account-id"] = accountId;
			const response = await fetch(resolveCodexSearchUrl(ctx?.model?.baseUrl), {
				method: "POST",
				headers,
				body: JSON.stringify(buildSearchRequestBody(args, ctx?.model?.id ?? "gpt-5.6", searchSessionId(ctx))),
				signal,
			});
			const text = await response.text();
			if (!response.ok) throw new Error(`Codex search failed (${response.status}): ${text.slice(0, 300)}`);
			let parsed: SearchResponse;
			try {
				parsed = JSON.parse(text);
			} catch {
				throw new Error(`Codex search returned unparseable JSON: ${text.slice(0, 300)}`);
			}
			const output = typeof parsed.output === "string" ? parsed.output : "";
			return {
				content: [{ type: "text", text: output || "(no results)" }],
				details: { queries: summarizeWebRunCommand(args), results: resultCount(parsed.results) },
			};
		},
	};
}
