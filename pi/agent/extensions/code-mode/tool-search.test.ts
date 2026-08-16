import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTool, resetToolRegistry } from "../shared/tool-registry.ts";
import type { TomlTool } from "./toml-tools.ts";
import { createToolSearchDefinition, renderSearchResult, searchTools } from "./tool-search.ts";

// `mcp__` names, so `defaultToolReach` calls them Deferred and the set is indexed with code-mode on or off.
const FIXTURES = [
	{
		name: "mcp__slack__send_message",
		description: "Send a message to a Slack channel or a direct message to a user.",
		parameters: {
			type: "object",
			properties: {
				channel_id: { type: "string", description: "Channel to post in." },
				text: { type: "string", description: "Message body, markdown." },
			},
			required: ["channel_id", "text"],
		},
	},
	{
		name: "mcp__slack__read_thread",
		description: "Read every reply in a Slack thread.",
		parameters: { type: "object", properties: { thread_ts: { type: "string" } }, required: ["thread_ts"] },
	},
	{
		name: "mcp__linear__save_issue",
		description: "Create or update an issue in Linear.",
		parameters: {
			type: "object",
			properties: { title: { type: "string" }, team_id: { type: "string" } },
			required: ["title"],
		},
	},
	{
		// One required property, so `renderParameterList` collapses it positional (tool-declarations.ts:100).
		name: "mcp__grafana__run_promql",
		description: "Run a PromQL query.",
		parameters: {
			type: "object",
			properties: {
				expr: { type: "string", description: "PromQL expression, for example `rate(http_total[5m])`." },
			},
			required: ["expr"],
		},
	},
	{
		name: "mcp__sentry__list_events",
		// The word "stack trace" appears only on a nested parameter, never in the name or the description.
		description: "List recent events for a project.",
		parameters: {
			type: "object",
			properties: {
				filter: {
					type: "object",
					properties: {
						stack_trace: { type: "string", description: "Substring matched against the stack trace frames." },
					},
				},
			},
			required: [],
		},
	},
];

function register(): void {
	resetToolRegistry();
	for (const fixture of FIXTURES) {
		registerTool({ registerTool() {} } as never, { ...fixture, execute: () => ({ content: [] }) });
	}
}

// The frequency problem is a ranking problem: one measured session dumped the catalogue 20 times for 47,895 tokens
// because a name scan does not answer the question. A wrong first hit re-opens exactly that loop.
it("ranks the tool the task describes first", () => {
	register();

	const cases: [string, string][] = [
		["post a message into a slack channel", "mcp__slack__send_message"],
		["read the replies on a slack thread", "mcp__slack__read_thread"],
		["create an issue in linear", "mcp__linear__save_issue"],
	];
	for (const [query, expected] of cases) {
		expect(searchTools(query, 8).at(0)?.name).toBe(expected);
	}
});

// codex indexes every JSON-schema property name and description recursively (`tools/src/tool_search.rs:124-149`).
// Without that, this query reaches nothing: "stack trace" is on a nested parameter only.
it("finds a tool through a nested parameter description alone", () => {
	register();

	expect(searchTools("search events by stack trace", 8).at(0)?.name).toBe("mcp__sentry__list_events");
});

it("caps the result at 8 however large the limit", () => {
	register();

	expect(searchTools("slack linear sentry message issue events", 50).length).toBeLessThanOrEqual(8);
});

// The crux: codex's search terminates because it hands back the callable thing (`tools/src/tool_search.rs:37-71`).
// A result the model must translate into a call is a result it will re-search.
it("returns a declaration that is callable as written", () => {
	register();

	const rendered = renderSearchResult(
		"post a message into a slack channel",
		searchTools("post a message into a slack channel", 2),
		true,
	);

	expect(rendered).toContain("declare const tools: {");
	expect(rendered).toContain("\tmcp__slack__send_message(args: {");
	expect(rendered).toContain("Send a message to a Slack channel");
	expect(rendered).toContain("}): Promise<CallResult>;");
});

// Code-mode off has no cell, so a `tools.` wrapper names a call the model cannot make and `CallResult` names a value
// it never receives. The system prompt draws the same distinction with `toolPrefix` (system-prompt/index.ts:159).
it("drops the cell wrapper when there is no cell", () => {
	register();

	const rendered = renderSearchResult(
		"post a message into a slack channel",
		searchTools("post a message into a slack channel", 2),
		false,
	);

	expect(rendered).toContain("mcp__slack__send_message(args: {");
	expect(rendered).toContain("Send a message to a Slack channel");
	expect(rendered).not.toContain("declare const tools");
	expect(rendered).not.toContain("CallResult");
});

// A collapsed positional parameter skips `renderObject`, the only place a property description was emitted, so a
// found tool arrived with its argument format missing. `read`'s selector grammar died that way and the model guessed.
it("keeps the parameter description on a collapsed positional argument", () => {
	register();

	const rendered = renderSearchResult("promql query", searchTools("promql query", 1), true);

	expect(rendered).toContain("mcp__grafana__run_promql(");
	expect(rendered).toContain("PromQL expression, for example `rate(http_total[5m])`.");
});

it("says so rather than ranking noise when nothing matches", () => {
	register();

	expect(renderSearchResult("photosynthesis", searchTools("photosynthesis", 8), true)).toContain("No tool matches");
});

it("registers a deferred TOML hit before claiming it is directly callable", async () => {
	resetToolRegistry();
	const cwd = mkdtempSync(join(tmpdir(), "pi-toml-promotion-"));
	const directory = join(cwd, ".pi", "codex-conversion-custom-tools");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "project_frobnicate.toml"),
		'usage = "quartz value"\ndescription = "Frobnicate quartz."\ncommand = "printf"\ndefer_loading = true\n',
	);
	const registered: TomlTool[] = [];
	const definition = createToolSearchDefinition(
		(tool) => registered.push(tool),
		() => false,
	);
	const execute = definition.execute as (...args: any[]) => Promise<{ content: Array<{ text: string }> }>;

	const result = await execute("search-1", { query: "frobnicate quartz", limit: 1 }, undefined, undefined, {
		cwd,
		sessionManager: { getSessionId: () => "toml-promotion" },
	});

	expect(registered.map((tool) => tool.name)).toEqual(["project_frobnicate"]);
	expect(result.content[0]?.text).toContain("project_frobnicate");
});
