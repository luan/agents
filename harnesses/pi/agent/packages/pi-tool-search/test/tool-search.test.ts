import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, icon } from "pi-libtui";
import toolSearchExtension from "../src/extension.ts";
import { searchTools, type ToolMetadata } from "../src/search.ts";
import { createToolSearchTool, TOOL_SEARCH_NAME } from "../src/tools/tool-search/definition.ts";
import { renderToolSearchResult } from "../src/tools/tool-search/presentation.ts";

const SETTINGS_KEY = Symbol.for("pi-xsettings/registry/v1");
const ADAPTERS_KEY = Symbol.for("pi-code-mode/nested-tool-adapters/v2");

afterEach(() => {
	Reflect.deleteProperty(globalThis, SETTINGS_KEY);
	Reflect.deleteProperty(globalThis, ADAPTERS_KEY);
	configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
});

const presentationTheme = {
	name: "tool-search-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[39m",
	getBgAnsi: () => "\x1b[49m",
} as never as Theme;

function metadata(
	name: string,
	description: string,
	parameters: ToolMetadata["parameters"] = { type: "object", properties: {} },
): ToolMetadata {
	return {
		name,
		description,
		parameters,
		sourceInfo: {
			source: "extension",
			path: `/extensions/${name}.ts`,
			scope: "user",
			origin: "package",
		},
	};
}

function toolApi(tools: ToolMetadata[], active: string[]) {
	const updates: string[][] = [];
	return {
		api: {
			getAllTools: () => tools,
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => {
				active.splice(0, active.length, ...names);
				updates.push([...names]);
			},
		},
		scope(...deferredNames: string[]) {
			const assigned = new Set([...active, ...deferredNames]);
			return {
				tools: () => tools.filter((tool) => assigned.has(tool.name)),
				active: () => [...active],
				setActive: (names: readonly string[]) => {
					active.splice(0, active.length, ...names);
					updates.push([...names]);
				},
			};
		},
		updates,
	};
}

describe("ranking", () => {
	test("ranks name matches above description matches", () => {
		const matches = searchTools("weather", [
			metadata("weather_lookup", "Read a forecast."),
			metadata("city_lookup", "Read weather for a city."),
		]);

		expect(matches.map((match) => match.tool.name)).toEqual(["weather_lookup", "city_lookup"]);
	});

	test("searches parameter names and descriptions", () => {
		const matches = searchTools("repository", [
			metadata("find_issue", "Find an issue.", {
				type: "object",
				properties: {
					repo: { type: "string", description: "The repository to inspect." },
				},
			}),
			metadata("find_person", "Find a person."),
		]);

		expect(matches.map((match) => match.tool.name)).toEqual(["find_issue"]);
	});
});

describe("dynamic loading", () => {
	test("registers tool_search as a normal Pi tool", () => {
		const registered: unknown[] = [];
		toolSearchExtension({
			registerTool: (tool: unknown) => {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		expect(registered).toHaveLength(1);
		expect(registered[0]).toMatchObject({ name: TOOL_SEARCH_NAME });
		const adapters = Reflect.get(globalThis, ADAPTERS_KEY) as { adapters: Map<string, { name: string }> };
		expect(adapters.adapters.get(TOOL_SEARCH_NAME)).toMatchObject({ name: TOOL_SEARCH_NAME });
	});

	test("owns deferred selection lifecycle without another hierarchy provider", () => {
		const handlers: string[] = [];
		const pi = {
			registerTool() {},
			on(event: string) {
				handlers.push(event);
			},
		} as unknown as ExtensionAPI;

		toolSearchExtension(pi);

		expect(handlers).toEqual(["session_start", "session_shutdown"]);
	});

	test("defers only configured active tools and excludes disabled tools from its chooser", async () => {
		const active = [TOOL_SEARCH_NAME, "deferred_weather", "direct_issues"];
		const handlers = new Map<string, Array<() => void | Promise<void>>>();
		let latestDefinitions: Array<Record<string, unknown>> = [];
		Reflect.set(globalThis, SETTINGS_KEY, {
			protocol: "pi-xsettings/registry/v1",
			version: 1,
			registrations: {},
			values: {},
			listeners: [],
			register(registration: {
				definitions: Array<Record<string, unknown>>;
				onValues?: (values: Record<string, string[]>) => void;
			}) {
				latestDefinitions = registration.definitions;
				registration.onValues?.({ tools: ["deferred_weather", "disabled_weather"] });
				return () => undefined;
			},
			async publish() {},
			onRegister() {
				return () => undefined;
			},
		});
		const tools = [
			metadata(TOOL_SEARCH_NAME, "Search tools."),
			metadata("deferred_weather", "Weather data."),
			metadata("direct_issues", "Issue data."),
			metadata("disabled_weather", "Disabled weather data."),
		];
		const pi = {
			registerTool() {},
			getAllTools: () => tools,
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
			on(event: string, handler: () => void | Promise<void>) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;

		toolSearchExtension(pi);
		for (const handler of handlers.get("session_start") ?? []) await handler();

		expect(active).toEqual([TOOL_SEARCH_NAME, "direct_issues"]);
		const definition = latestDefinitions.find((candidate) => candidate["key"] === "tools");
		expect(definition?.["options"]).toEqual([
			{ value: "deferred_weather", label: "deferred_weather", description: "Weather data." },
			{ value: "direct_issues", label: "direct_issues", description: "Issue data." },
		]);
	});

	test("uses sibling Code Mode tools when tool_search is under exec", async () => {
		const handlers = new Map<string, Array<() => void | Promise<void>>>();
		let latestDefinitions: Array<Record<string, unknown>> = [];
		Reflect.set(globalThis, SETTINGS_KEY, {
			protocol: "pi-xsettings/registry/v1",
			version: 1,
			registrations: {},
			values: {},
			listeners: [],
			register(registration: {
				definitions: Array<Record<string, unknown>>;
				onValues?: (values: Record<string, string[]>) => void;
			}) {
				latestDefinitions = registration.definitions;
				registration.onValues?.({ tools: ["exec_command"] });
				return () => undefined;
			},
			async publish() {},
			onRegister() {
				return () => undefined;
			},
		});
		const activeNested = ["exec_command", "write_stdin"];
		const nestedTools = [
			metadata("exec_command", "Run a shell command."),
			metadata("write_stdin", "Continue a command."),
		];
		const pi = {
			registerTool() {},
			getAllTools: () => [metadata(TOOL_SEARCH_NAME, "Search tools."), ...nestedTools],
			getActiveTools: () => ["exec", "wait"],
			setActiveTools() {},
			on(event: string, handler: () => void | Promise<void>) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;

		toolSearchExtension(pi);
		const adapter = (
			Reflect.get(globalThis, ADAPTERS_KEY) as {
				adapters: Map<
					string,
					{
						onScopeChange(scope: {
							tools(): typeof nestedTools;
							active(): string[];
							setActive(names: readonly string[]): void;
						}): void;
						invoke(input: { query: string; limit?: number }): Promise<unknown>;
					}
				>;
			}
		).adapters.get(TOOL_SEARCH_NAME)!;
		adapter.onScopeChange({
			tools: () => nestedTools,
			active: () => [...activeNested],
			setActive: (names) => activeNested.splice(0, activeNested.length, ...names),
		});
		for (const handler of handlers.get("session_start") ?? []) await handler();

		expect(activeNested).toEqual(["write_stdin"]);
		const definition = latestDefinitions.find((candidate) => candidate["key"] === "tools");
		expect(definition?.["options"]).toEqual([
			{ value: "exec_command", label: "exec_command", description: "Run a shell command." },
			{ value: "write_stdin", label: "write_stdin", description: "Continue a command." },
		]);
		await adapter.invoke({ query: "shell command" });
		expect(activeNested).toEqual(["write_stdin", "exec_command"]);
	});

	test("excludes active tools and activates matches additively", async () => {
		const active = [TOOL_SEARCH_NAME, "read", "weather_lookup"];
		const { scope, updates } = toolApi(
			[
				metadata(TOOL_SEARCH_NAME, "Search tools."),
				metadata("read", "Read a file."),
				metadata("weather_lookup", "Look up weather."),
				metadata("weather_history", "Read historical weather."),
				metadata("issue_search", "Search issues."),
			],
			active,
		);
		const tool = createToolSearchTool(scope("weather_history", "issue_search"));

		const result = await tool.execute("call", { query: "weather", limit: 8 }, undefined, undefined, {} as never);

		expect(updates).toEqual([[TOOL_SEARCH_NAME, "read", "weather_lookup", "weather_history"]]);
		expect(result.details).toMatchObject({
			version: 2,
			tool: "tool_search",
			status: "loaded",
			input: { query: "weather", normalizedQuery: "weather", limit: 8 },
			rankedMatches: [{ name: "weather_history" }],
			activation: {
				before: [TOOL_SEARCH_NAME, "read", "weather_lookup"],
				added: ["weather_history"],
				after: [TOOL_SEARCH_NAME, "read", "weather_lookup", "weather_history"],
			},
			counts: { registered: 5, searchable: 2, matches: 1, added: 1 },
		});
		expect(result.details.timing.durationMs).toBeGreaterThanOrEqual(0);
		expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
	});

	test("loads matching tools from the assigned inactive scope", async () => {
		const active = [TOOL_SEARCH_NAME];
		const { scope, updates } = toolApi(
			[
				metadata(TOOL_SEARCH_NAME, "Search tools."),
				metadata("exec_command", "Run a shell command."),
				metadata("write_stdin", "Continue a running command."),
			],
			active,
		);

		const result = await createToolSearchTool(scope("exec_command", "write_stdin")).execute(
			"call",
			{ query: "shell command", limit: 8 },
			undefined,
			undefined,
			{} as never,
		);

		expect(updates).toEqual([[TOOL_SEARCH_NAME, "exec_command", "write_stdin"]]);
		expect(result.details.activation.added).toEqual(["exec_command", "write_stdin"]);
	});

	test("does not change the active set when no inactive tool matches", async () => {
		const active = [TOOL_SEARCH_NAME, "read"];
		const { scope, updates } = toolApi(
			[metadata(TOOL_SEARCH_NAME, "Search tools."), metadata("read", "Read a file.")],
			active,
		);
		const tool = createToolSearchTool(scope());

		const result = await tool.execute("call", { query: "weather", limit: 8 }, undefined, undefined, {} as never);

		expect(updates).toEqual([]);
		expect(result.details).toMatchObject({
			version: 2,
			tool: "tool_search",
			status: "no_match",
			input: { query: "weather", normalizedQuery: "weather", limit: 8 },
			rankedMatches: [],
			activation: {
				before: [TOOL_SEARCH_NAME, "read"],
				added: [],
				after: [TOOL_SEARCH_NAME, "read"],
			},
			counts: { registered: 2, searchable: 0, matches: 0, added: 0 },
		});
	});

	test("caps activation at eight matches", async () => {
		const active = [TOOL_SEARCH_NAME];
		const tools = Array.from({ length: 12 }, (_, index) => metadata(`weather_${index}`, "Weather data."));
		const { scope, updates } = toolApi([metadata(TOOL_SEARCH_NAME, "Search tools."), ...tools], active);
		const tool = createToolSearchTool(scope(...tools.map((tool) => tool.name)));

		await tool.execute("call", { query: "weather", limit: 20 }, undefined, undefined, {} as never);

		expect(updates[0]).toHaveLength(9);
		expect(updates[0]?.[0]).toBe(TOOL_SEARCH_NAME);
	});

	test("the limit bounds activation without expanding a hidden group", async () => {
		const names = Array.from({ length: 10 }, (_, index) => `suite_${index}`);
		const { scope, updates } = toolApi(
			[metadata(TOOL_SEARCH_NAME, "Search tools."), ...names.map((name) => metadata(name, "Suite capability."))],
			[TOOL_SEARCH_NAME],
		);

		const result = await createToolSearchTool(scope(...names)).execute(
			"call",
			{ query: "suite capability", limit: 1 },
			undefined,
			undefined,
			{} as never,
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]).toHaveLength(2);
		expect(result.details.activation.added).toHaveLength(1);
	});

	test("never searches registered tools outside its assigned deferred scope", async () => {
		const active = [TOOL_SEARCH_NAME];
		const { scope, updates } = toolApi(
			[
				metadata(TOOL_SEARCH_NAME, "Search tools."),
				metadata("deferred_weather", "Weather data."),
				metadata("disabled_weather", "Weather data."),
			],
			active,
		);

		const result = await createToolSearchTool(scope("deferred_weather")).execute(
			"call",
			{ query: "weather", limit: 8 },
			undefined,
			undefined,
			{} as never,
		);

		expect(updates).toEqual([[TOOL_SEARCH_NAME, "deferred_weather"]]);
		expect(result.details.rankedMatches.map((match) => match.name)).toEqual(["deferred_weather"]);
	});

	test("missing persisted details use the configured search marker", () => {
		configureTuiAppearance({ iconPack: "emoji" });
		const component = renderToolSearchResult(
			{ content: [{ type: "text", text: "search failed" }], details: undefined as never },
			presentationTheme,
			{
				args: { query: "weather" },
				executionStarted: true,
				invalidate() {},
				isError: true,
				lastComponent: undefined,
			},
			false,
		);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toBe(`${icon("search")} Tool search failed · weather ›`);
	});

	test("malformed nested search details fall back without throwing", () => {
		const component = renderToolSearchResult(
			{
				content: [{ type: "text", text: "search failed" }],
				details: {
					version: 2,
					tool: "tool_search",
					status: "loaded",
					input: { query: "weather" },
					rankedMatches: [{ name: "weather", description: "Weather", score: 1 }],
					activation: {},
					counts: { matches: 1 },
					timing: { durationMs: 1 },
				} as never,
			},
			presentationTheme,
			{
				args: { query: "weather" },
				executionStarted: true,
				invalidate() {},
				isError: true,
				lastComponent: undefined,
			},
			false,
		);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toBe(`${icon("search")} Tool search failed · weather ›`);
	});
});
