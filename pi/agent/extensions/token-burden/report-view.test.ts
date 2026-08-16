import { describe, expect, test } from "bun:test";
import type { RegisteredToolDefinition } from "../shared/tool-registry.ts";
import {
	filterToolsByTab,
	formatToolMarkdown,
	isBackKey,
	isForwardKey,
	isNavigateDownKey,
	isNavigateUpKey,
	providerOwnedToolType,
	showReport,
	toolRowLabel,
	toolTabFor,
} from "./report-view";
import type { ParsedPrompt, ToolEntry } from "./types.ts";
import { ToolReach } from "./types.ts";

describe("token burden vim key bindings", () => {
	test("maps vim movement keys to existing overlay actions", () => {
		expect(isNavigateUpKey("k")).toBe(true);
		expect(isNavigateDownKey("j")).toBe(true);
		expect(isForwardKey("l")).toBe(true);
		expect(isBackKey("h")).toBe(true);
		expect(isBackKey("q")).toBe(true);
	});

	test("does not treat unrelated printable keys as navigation", () => {
		expect(isNavigateUpKey("u")).toBe(false);
		expect(isNavigateDownKey("d")).toBe(false);
		expect(isForwardKey("f")).toBe(false);
		expect(isBackKey("b")).toBe(false);
	});
});

function entry(name: string, reach: ToolReach = ToolReach.Deferred): ToolEntry {
	return { name, chars: 10, tokens: 5, content: JSON.stringify({ name }), reach };
}

function toolsPrompt(): ParsedPrompt {
	return {
		totalChars: 50,
		totalTokens: 22,
		skills: [],
		sections: [
			{
				label: "Tool schemas (1 resident of 2)",
				chars: 20,
				tokens: 10,
				tools: {
					tools: [
						{ name: "exec", chars: 20, tokens: 10, content: '{"name":"exec"}', reach: ToolReach.Direct },
						{ name: "read", chars: 30, tokens: 12, content: '{"name":"read"}', reach: ToolReach.Deferred },
					],
					residentTokens: 10,
					registeredTokens: 22,
					declarationTokens: 5,
				},
			},
		],
	};
}

function overlayCtx(keys: string[]): any {
	return {
		ui: {
			custom: async (factory: any) => {
				const component = factory({ requestRender() {} }, {}, {}, () => {});
				for (const key of keys) {
					component.handleInput(key);
				}
			},
		},
	};
}

describe("token burden tools overlay", () => {
	test("space walks a tool around the whole reach cycle", async () => {
		const calls: Array<[string, ToolReach]> = [];
		const parsed = toolsPrompt();

		await showReport(
			parsed,
			100,
			overlayCtx(["l", "j", " ", " ", " ", " "]),
			[],
			undefined,
			undefined,
			(name, reach) => {
				calls.push([name, reach]);
				return true;
			},
		);

		expect(calls).toEqual([
			["read", ToolReach.Blocked],
			["read", ToolReach.Direct],
			["read", ToolReach.Declared],
			["read", ToolReach.Deferred],
		]);
		expect(parsed.sections[0].tools?.tools[1].reach).toBe(ToolReach.Deferred);
	});

	test("a refused transition leaves the row where it was", async () => {
		const calls: Array<[string, ToolReach]> = [];
		const parsed = toolsPrompt();

		await showReport(parsed, 100, overlayCtx(["l", " ", " "]), [], undefined, undefined, (name, reach) => {
			calls.push([name, reach]);
			return false;
		});

		expect(calls).toEqual([
			["exec", ToolReach.Declared],
			["exec", ToolReach.Declared],
		]);
		expect(parsed.sections[0].tools?.tools[0].reach).toBe(ToolReach.Direct);
	});
});

function agentToolsPrompt(): ParsedPrompt {
	return {
		totalChars: 80,
		totalTokens: 40,
		skills: [],
		sections: [
			{
				label: "Tool schemas (3 resident of 3)",
				chars: 80,
				tokens: 40,
				tools: {
					tools: [
						{
							name: "spawn_agent",
							chars: 40,
							tokens: 20,
							content: '{"name":"spawn_agent"}',
							reach: ToolReach.Direct,
						},
						{ name: "exec", chars: 20, tokens: 10, content: '{"name":"exec"}', reach: ToolReach.Direct },
						{
							name: "mcp__linear__list_issues",
							chars: 20,
							tokens: 10,
							content: '{"name":"mcp__linear__list_issues"}',
							reach: ToolReach.Direct,
						},
					],
					residentTokens: 40,
					registeredTokens: 40,
					declarationTokens: 0,
				},
			},
		],
	};
}

describe("token burden agent tool namespace", () => {
	test("renders the dotted name while tool-policy still sees the bare one", async () => {
		const calls: Array<[string, ToolReach]> = [];
		const rendered: string[] = [];
		const ctx: any = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {} }, {}, {}, () => {});
					component.handleInput("l");
					component.handleInput(" ");
					rendered.push(...component.render(80));
					// A second "l" is the tab step, so the MCP rows render too.
					component.handleInput("l");
					rendered.push(...component.render(80));
				},
			},
		};

		await showReport(agentToolsPrompt(), 100, ctx, [], undefined, undefined, (name, reach) => {
			calls.push([name, reach]);
			return true;
		});

		expect(calls).toEqual([["spawn_agent", ToolReach.Declared]]);
		const output = rendered.join("\n");
		expect(output).toContain("collaboration.spawn_agent");
		expect(output).toContain("functions.exec");
		expect(output).toContain("mcp__linear__list_issues");
		expect(output).not.toContain("functions.collaboration");
		expect(output).not.toContain("functions.mcp__");
	});

	test("prefixes the eight and leaves every other name alone", () => {
		expect(toolRowLabel("wait_agent", ToolReach.Deferred)).toBe("collaboration.wait_agent");
		expect(toolRowLabel("exec", ToolReach.Deferred)).toBe("exec");
	});

	test("adds functions. to a resident native tool that has no namespace yet", () => {
		expect(toolRowLabel("exec", ToolReach.Direct)).toBe("functions.exec");
		expect(toolRowLabel("ask_user", ToolReach.Direct)).toBe("functions.ask_user");
		expect(toolRowLabel("read", ToolReach.Declared)).toBe("read");
	});

	// mcp__ and codex_apps_ are namespaces spelled with the separators the provider accepts.
	test("never stacks functions. on a name that already carries a namespace", () => {
		expect(toolRowLabel("wait_agent", ToolReach.Direct)).toBe("collaboration.wait_agent");
		expect(toolRowLabel("mcp__linear__list_issues", ToolReach.Direct)).toBe("mcp__linear__list_issues");
		expect(toolRowLabel("codex_apps_notion_search", ToolReach.Direct)).toBe("codex_apps_notion_search");
	});
});

// Mirrors createImageGenerationTool at codex-native/native-tools.ts:447.
function placeholderDefinition(name: string): RegisteredToolDefinition {
	return {
		name,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		prepareArguments: () => ({}),
		execute: () => {
			throw new Error(`${name} is a native provider tool and should not execute locally`);
		},
	};
}

function localDefinition(name: string): RegisteredToolDefinition {
	return {
		name,
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		execute: () => ({ content: [] }),
	};
}

function wireEntry(name: string, schema: unknown): ToolEntry {
	return {
		name,
		chars: 120,
		tokens: 30,
		content: JSON.stringify({ name, description: `${name} description`, input_schema: schema }),
		reach: ToolReach.Direct,
	};
}

describe("token burden provider-native tool view", () => {
	test("names the provider tool type instead of showing an empty schema", () => {
		const registry = new Map([["image_generation", placeholderDefinition("image_generation")]]);
		const entry = wireEntry("image_generation", { type: "object", properties: {}, required: [] });

		const markdown = formatToolMarkdown(entry, 2, (name) => registry.get(name));

		expect(markdown).toContain("Owner: the provider. This registration is a placeholder.");
		expect(markdown).toContain("Provider tool type: `image_generation`");
		expect(markdown).toContain("The provider defines that tool's fields.");
		expect(markdown).toContain("Placeholder schema:");
	});

	test("leaves a tool that owns its own schema untouched", () => {
		const registry = new Map([["read", localDefinition("read")]]);
		const entry = wireEntry("read", { type: "object", properties: { path: { type: "string" } }, required: ["path"] });

		const markdown = formatToolMarkdown(entry, 2, (name) => registry.get(name));

		expect(markdown).toContain("#### Input schema");
		expect(markdown).not.toContain("Provider tool type");
		expect(markdown).toContain('"path"');
	});

	test("reads the provider type off a registration that declares one", () => {
		const declared: RegisteredToolDefinition = {
			name: "future_native",
			providerToolType: "provider_side_type",
			parameters: { type: "object", properties: { query: { type: "string" } } },
			execute: () => ({ content: [] }),
		};

		expect(providerOwnedToolType("future_native", () => declared)).toBe("provider_side_type");
		expect(providerOwnedToolType("missing", () => undefined)).toBeUndefined();
	});
});

describe("token burden tool tabs", () => {
	test("routes each name family to one tab", () => {
		expect(toolTabFor("exec")).toBe("native");
		expect(toolTabFor("mcp__linear__list_issues")).toBe("mcp");
		expect(toolTabFor("codex_apps_notion_search")).toBe("apps");
	});

	test("filters a mixed registry into three disjoint lists", () => {
		const tools = [entry("exec"), entry("mcp__fff__grep"), entry("codex_apps_slack_send"), entry("ask_user")];

		expect(filterToolsByTab(tools, "native").map((tool) => tool.name)).toEqual(["exec", "ask_user"]);
		expect(filterToolsByTab(tools, "mcp").map((tool) => tool.name)).toEqual(["mcp__fff__grep"]);
		expect(filterToolsByTab(tools, "apps").map((tool) => tool.name)).toEqual(["codex_apps_slack_send"]);
	});
});
