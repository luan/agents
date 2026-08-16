// codex gates the "filter `ALL_TOOLS`" guidance on a search tool existing (`core/src/tools/spec_plan.rs:723`); pi
// shipped the guidance without the mechanism, and one session dumped the catalogue 20 times for 47,895 tokens against
// 25,690 tokens of work. Prompt text is not the fix: codex wrote "do not print the full `ALL_TOOLS` array", deleted it,
// and pinned the deletion (`code-mode-protocol/src/description.rs:1173`). Rank in the harness, return the callable thing.

import { Type } from "typebox";
import { sessionIdFromContext } from "../shared/session-context.ts";
import type { RegisteredToolDefinition } from "../shared/tool-registry.ts";
import { ToolReach } from "../token-burden/types.ts";
import { promoteToolToDirect } from "../tool-policy/policy.ts";
import { isCodeModeEnabled } from "./mode.ts";
import type { TomlTool } from "./toml-tools.ts";
import { unifiedCatalog } from "./tool-catalog.ts";
import {
	namedOutputDeclaration,
	renderDeclarationBody,
	renderDocComment,
	renderParameterList,
} from "./tool-declarations.ts";
import { renderToolSearchResult } from "./tool-search-presentation.ts";

export const TOOL_SEARCH_NAME = "tool_search";

/** codex's `TOOL_SEARCH_DEFAULT_LIMIT` (`tools/src/tool_discovery.rs:7`), and here also the ceiling. */
const RESULT_LIMIT = 8;

/** codex's `MAX_MCP_TOOL_DESCRIPTION_BYTES` (`tools/src/mcp_tool.rs:7`), so 8 verbose connector tools stay bounded. */
const MAX_DESCRIPTION_CHARS = 1_000;

const MAX_SCHEMA_DEPTH = 6;

const K1 = 1.2;
const B = 0.75;

/** Prefix expansion below this length matches everything, so `to` would score every tool equally. */
const MIN_PREFIX_LENGTH = 3;

interface IndexedTool {
	name: string;
	definition: RegisteredToolDefinition;
	frequencies: Map<string, number>;
	length: number;
}

/** Same contract as `sessionIdOf` (nested-dispatch.ts), reusing the shared helper directly so the two files never cycle. */
function sessionIdOfContext(ctx: unknown): string | undefined {
	try {
		return sessionIdFromContext(ctx);
	} catch {
		return undefined;
	}
}

/** Whether any registered tool is Deferred. Nothing Deferred means nothing to discover, so `tool_search` costs zero. */
export function hasDeferredTools(sessionId?: string, cwd = process.cwd()): boolean {
	return unifiedCatalog(sessionId, cwd).some(
		(entry) => entry.name !== TOOL_SEARCH_NAME && entry.reach === ToolReach.Deferred,
	);
}

// Only suffix stripping: "messages" has to reach `slack_send_message`, and a Porter stemmer buys nothing over ~350 tools.
function stem(term: string): string {
	for (const suffix of ["ing", "es", "ed", "s"]) {
		if (term.length > suffix.length + 2 && term.endsWith(suffix)) return term.slice(0, -suffix.length);
	}
	return term;
}

function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 1)
		.map(stem);
}

/** Every JSON-schema property name and description, recursively — codex's `append_schema_search_text`
 * (`tools/src/tool_search.rs:124-149`). This is the part that makes one search enough where a name list is not. */
function appendSchemaText(schema: unknown, depth: number, out: string[]): void {
	if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > MAX_SCHEMA_DEPTH) return;
	const node = schema as Record<string, unknown>;
	const properties = node.properties;
	if (properties && typeof properties === "object") {
		for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
			out.push(key, key.replaceAll("_", " "));
			const description = (value as { description?: unknown })?.description;
			if (typeof description === "string") out.push(description);
			appendSchemaText(value, depth + 1, out);
		}
	}
	appendSchemaText(node.items, depth + 1, out);
	const variants = [
		...(Array.isArray(node.anyOf) ? node.anyOf : []),
		...(Array.isArray(node.oneOf) ? node.oneOf : []),
	];
	for (const variant of variants) appendSchemaText(variant, depth + 1, out);
}

function searchText(name: string, definition: RegisteredToolDefinition): string[] {
	// The name is pushed twice, raw and underscore-split, exactly as codex does (`tools/src/tool_search.rs:126-127`):
	// a term in the name then carries double the frequency of the same term in a description. A third push was tried
	// and dropped — it moved no result across 4 live queries against 224 registered tools.
	const parts = [name, name.replaceAll("_", " ")];
	if (typeof definition.description === "string") parts.push(definition.description);
	appendSchemaText(definition.parameters, 0, parts);
	return parts;
}

/**
 * Rebuilt per call: connectors register late (`codex-native/codex-apps.ts:1466`), so a cache answers for a surface
 * that no longer exists. 224 tools measured a few ms. Direct is excluded — its schema is already in the provider's
 * tool array. codex indexes Deferred only (`core/src/tools/handlers/tool_search.rs:57-70`); Declared stays in so a
 * plausible query is never answered with nothing.
 */
function buildIndex(sessionId: string | undefined, cwd = process.cwd()): IndexedTool[] {
	const documents: IndexedTool[] = [];
	for (const entry of unifiedCatalog(sessionId, cwd)) {
		if (entry.name === TOOL_SEARCH_NAME || !entry.definition) continue;
		const frequencies = new Map<string, number>();
		let length = 0;
		for (const field of searchText(entry.name, entry.definition)) {
			for (const term of tokenize(field)) {
				frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
				length++;
			}
		}
		documents.push({ name: entry.name, definition: entry.definition, frequencies, length });
	}
	return documents;
}

/** Exact term first, then prefix expansion, so `auth` reaches `authenticate` without a stemmer that knows the word. */
function frequencyOf(document: IndexedTool, term: string): number {
	const exact = document.frequencies.get(term);
	if (exact) return exact;
	if (term.length < MIN_PREFIX_LENGTH) return 0;
	let total = 0;
	for (const [candidate, count] of document.frequencies) {
		if (candidate.startsWith(term)) total += count;
	}
	return total;
}

export interface ToolSearchHit {
	name: string;
	score: number;
	definition: RegisteredToolDefinition;
}

export function searchTools(
	query: string,
	limit = RESULT_LIMIT,
	sessionId?: string,
	cwd = process.cwd(),
): ToolSearchHit[] {
	const documents = buildIndex(sessionId, cwd);
	const queryTerms = [...new Set(tokenize(query))];
	if (documents.length === 0 || queryTerms.length === 0) return [];

	const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
	const scores = new Float64Array(documents.length);
	for (const term of queryTerms) {
		const frequencies = documents.map((document) => frequencyOf(document, term));
		const containing = frequencies.reduce((count, frequency) => count + (frequency > 0 ? 1 : 0), 0);
		if (containing === 0) continue;
		const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
		for (let index = 0; index < documents.length; index++) {
			const frequency = frequencies[index];
			if (frequency === 0) continue;
			const document = documents[index];
			scores[index] +=
				(idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * document.length) / averageLength));
		}
	}

	return documents
		.map((document, index) => ({ name: document.name, score: scores[index], definition: document.definition }))
		.filter((hit) => hit.score > 0)
		.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
		.slice(0, Math.min(RESULT_LIMIT, Math.max(1, Math.floor(limit) || RESULT_LIMIT)));
}

function cappedDescription(definition: RegisteredToolDefinition): string {
	const description = renderDeclarationBody(definition);
	return description.length > MAX_DESCRIPTION_CHARS ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…` : description;
}

/**
 * Cell shape is the member text `buildCoreToolDeclarations` emits (nested-dispatch.ts:367-371), through the same
 * `tool-declarations.ts` renderers, so a hit is copied into a cell rather than looked up a second time.
 *
 * Direct shape drops the `tools.` wrapper and the `Promise<…>` return, which the system prompt does through its own
 * `toolPrefix` (system-prompt/index.ts:159 — `codeMode ? "tools." : ""`). With no cell there is no `CallResult`, so
 * declaring one would describe a value the model never receives.
 */
function renderMember(hit: ToolSearchHit, cell: boolean): { member: string; type?: string } {
	const indent = cell ? "\t" : "";
	const output = cell ? namedOutputDeclaration(hit.definition.nestedResult?.details) : undefined;
	const description = cappedDescription(hit.definition);
	const lines: string[] = [];
	if (description) lines.push(renderDocComment(description, indent));
	const parameters = renderParameterList(hit.definition.parameters, indent);
	const returns = cell ? `: Promise<${output ? `ToolResult<${output.name}>` : "CallResult"}>;` : "";
	lines.push(`${indent}${hit.name}(${parameters})${returns}`);
	return { member: lines.join("\n"), type: output ? `type ${output.name} = ${output.declaration};` : undefined };
}

export function renderSearchResult(query: string, hits: readonly ToolSearchHit[], cell = isCodeModeEnabled()): string {
	if (hits.length === 0) {
		return `No tool matches ${JSON.stringify(query)}. Try fewer words, or the words of the task; a connector tool is named \`mcp__<server>__<tool>\`.`;
	}
	const members: string[] = [];
	const types = new Map<string, string>();
	for (const hit of hits) {
		const rendered = renderMember(hit, cell);
		members.push(rendered.member);
		if (rendered.type) types.set(hit.name, rendered.type);
	}
	const one = hits.length === 1;
	const heading = `${hits.length} tool${one ? "" : "s"} match${one ? "es" : ""} ${JSON.stringify(query)}, best first`;
	return [
		cell ? `${heading}:` : `${heading}. Each is now in your tool list, callable by name:`,
		"",
		"```ts",
		...(types.size > 0 ? [...new Set(types.values()), ""] : []),
		...(cell ? ["declare const tools: {"] : []),
		...members,
		...(cell ? ["};"] : []),
		"```",
	].join("\n");
}

// Mode-neutral wording, because pi reads `description` once at registration: this same string is the cell declaration
// with code-mode on and the provider schema with it off. The cell-specific `text(r.text)` example lives where it is
// true — the declaration block (nested-dispatch.ts:400) and `EXEC_DESCRIPTION` (payload.ts:25), both code-mode only.
const TOOL_SEARCH_DESCRIPTION = `Find a tool that is not in your tool list. Ranked search over every registered tool's name, description and parameter names, connector tools included.

Returns up to ${RESULT_LIMIT} declarations, best match first, and makes each one callable. Query with the words of the task, or with the name you guessed — both are tokenized.`;

type RegisterTomlTool = (tool: TomlTool) => void;

// Registered with pi by extensions/tool-search/index.ts. Tool policy keeps `tool_search` Declared in code-mode and Direct when off.
export function createToolSearchDefinition(
	registerTomlTool?: RegisterTomlTool,
	codeModeEnabled: () => boolean = isCodeModeEnabled,
): RegisteredToolDefinition {
	return {
		name: TOOL_SEARCH_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		parameters: Type.Object(
			{
				query: Type.String({ description: "What the tool should do, in the words of the task." }),
				limit: Type.Optional(
					Type.Number({
						minimum: 1,
						description: `How many declarations to return. Defaults to and caps at ${RESULT_LIMIT}.`,
					}),
				),
			},
			{ additionalProperties: false },
		),
		renderShell: "self",
		renderResult: renderToolSearchResult,
		execute: ((
			_toolCallId: string,
			params: { query?: unknown; limit?: unknown },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: unknown,
		) => {
			const query = typeof params?.query === "string" ? params.query : "";
			const limit = typeof params?.limit === "number" ? params.limit : RESULT_LIMIT;
			const sessionId = sessionIdOfContext(ctx);
			const hits = searchTools(query, limit, sessionId, (ctx as { cwd?: string })?.cwd);
			const cell = codeModeEnabled();
			// A direct search result is truthful only after Pi owns its execute callback.
			if (!cell) {
				for (const hit of hits) {
					const toml = hit.definition.tomlTool as TomlTool | undefined;
					if (toml) {
						if (!registerTomlTool) throw new Error(`TOML tool ${toml.name} is not registered with Pi`);
						registerTomlTool(toml);
					}
					promoteToolToDirect(hit.name, sessionId);
				}
			}
			return {
				content: [{ type: "text", text: renderSearchResult(query, hits, cell) }],
				details: {
					query,
					count: hits.length,
					matches: hits.map((hit) => ({
						name: hit.name,
						description: typeof hit.definition.description === "string" ? hit.definition.description : "",
					})),
				},
			};
		}) as RegisteredToolDefinition["execute"],
	};
}
