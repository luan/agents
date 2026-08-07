import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCapabilities } from "@earendil-works/pi-tui";
import { CodexAppServerMcpClient } from "./app-server-mcp.ts";
import {
	activeCodexAppsToolNames,
	buildCodexAppRecords,
	CodexToolsPanel,
	createToolDefinition,
	disabledCodexAppToolKeys,
	discoverCodexAppsTools,
	discoverCodexPlugins,
	discoverNodeReplTools,
	discoverPluginMcpTools,
	migrateCodexAppsConfig,
	pluginSkillPaths,
	systemSkillPaths,
} from "./codex-apps.ts";
import {
	isCodexWebSocketError,
	normalizeCodexWebSocketError as normalizeCodexWebSocketErrorMessage,
	normalizeLegacyFunctionCallIds,
} from "./index.ts";
import { LocalMcpClient } from "./local-mcp.ts";
import {
	buildGeneratedImageArtifactResult,
	createWebSearchTool,
	getOpenAICodexLatestImagePath,
	renderImageGenerationMessage,
	renderWebSearchMessage,
	rewriteNativeImageGenerationTool,
	rewriteNativeWebSearchTool,
	saveGeneratedImagesFromAssistantMessage,
	saveOpenAICodexGeneratedImage,
	supportsNativeImageGeneration,
	supportsNativeWebSearch,
	WEB_SEARCH_TOOL_NAME,
} from "./native-tools.ts";
import { convertResponsesMessages, processResponsesStream } from "./openai-responses-shared.ts";
import { isCodexPluginEnabled } from "./plugin-aliases.ts";

const codexModel = {
	provider: "openai-codex",
	id: "gpt-5.5",
	input: ["text", "image"],
};

const codexMiniModel = {
	provider: "openai-codex",
	id: "gpt-5.4-mini",
	input: ["text", "image"],
};

const testTheme = {
	fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
};

test("normalizes legacy function call item ids at the provider-request boundary", () => {
	const payload = {
		input: [
			{ type: "function_call", id: "ctc_0ae3fabeb0423f2e016a00c39c449c81919eab6c5ebf693f2e", call_id: "call_1" },
			{ type: "function_call", id: "fc_valid", call_id: "call_2" },
			{
				type: "custom_tool_call",
				id: "fc_ctc_0ae3fabeb0423f2e016a00c39c449c81919eab6c5ebf693f2e",
				call_id: "call_3",
			},
			{ type: "custom_tool_call", id: "ctc_custom", call_id: "call_4" },
		],
	};

	const rewritten = normalizeLegacyFunctionCallIds(payload) as typeof payload;
	expect(rewritten.input[0]?.id.startsWith("fc_")).toBe(true);
	expect(rewritten.input[0]?.id.startsWith("ctc_")).toBe(false);
	expect(rewritten.input[1]?.id).toBe("fc_valid");
	expect(rewritten.input[2]?.id.startsWith("ctc_")).toBe(true);
	expect(rewritten.input[2]?.id.startsWith("fc_")).toBe(false);
	expect(rewritten.input[3]?.id).toBe("ctc_custom");
});

test("normalizes legacy Codex custom tool call item ids for Responses replay", () => {
	const messages = convertResponsesMessages(
		{ ...codexModel, api: "openai-codex-responses" } as never,
		{
			messages: [
				{
					role: "assistant",
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.5",
					content: [
						{
							type: "toolCall",
							id: "call_apply_patch|ctc_0ae3fabeb0423f2e016a00c39c449c81919eab6c5ebf693f2e",
							name: "apply_patch",
							arguments: { input: "*** Begin Patch\n*** End Patch" },
						},
					],
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "call_apply_patch|ctc_0ae3fabeb0423f2e016a00c39c449c81919eab6c5ebf693f2e",
					toolName: "apply_patch",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			systemPrompt: "",
			tools: [],
		} as never,
		new Set(["openai-codex"]),
	) as any[];

	const call = messages.find((item) => item.type === "function_call");
	expect(call.id.startsWith("fc_")).toBe(true);
	expect(call.id.startsWith("ctc_")).toBe(false);
	expect(call.call_id).toBe("call_apply_patch");
	expect(call.id.length).toBeLessThanOrEqual(64);
});

test("strips local image artifact metadata from Responses replay", () => {
	const messages = convertResponsesMessages(
		{ ...codexModel, api: "openai-codex-responses" } as never,
		{
			messages: [
				{
					role: "assistant",
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.5",
					content: [
						{
							type: "image_generation_call",
							item: {
								type: "image_generation_call",
								id: "ig_1",
								status: "completed",
								result: PNG_BASE64,
								revised_prompt: "a moon dog",
								saved_path: "/tmp/moon-dog.png",
								savedPath: "/tmp/moon-dog.png",
								artifacts: [{ path: "/tmp/moon-dog.png" }],
								artifact_result: '{"artifacts":[{"path":"/tmp/moon-dog.png"}]}',
							},
						},
					],
					stopReason: "stop",
					timestamp: Date.now(),
				},
			],
			systemPrompt: "",
			tools: [],
		} as never,
		new Set(["openai-codex"]),
	) as any[];

	expect(messages).toEqual([
		{
			type: "image_generation_call",
			id: "ig_1",
			status: "completed",
			result: PNG_BASE64,
			revised_prompt: "a moon dog",
		},
	]);
});
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("rewrites Codex web_search function tool to native Responses tool", () => {
	const payload = {
		model: "gpt-5.5",
		input: [],
		tools: [
			{ type: "function", name: "web_search", parameters: {} },
			{ type: "function", name: "apply_patch", parameters: {} },
		],
	};

	const rewritten = rewriteNativeWebSearchTool(payload, codexModel as never) as typeof payload;
	expect(rewritten.tools[0]).toEqual({
		type: "web_search",
		external_web_access: true,
		search_content_types: ["text", "image"],
	});
	expect(rewritten.tools[1]).toEqual(payload.tools[1]);
});

test("creates native web_search placeholder tool for openai-codex", () => {
	const tool = createWebSearchTool();

	expect(tool.name).toBe(WEB_SEARCH_TOOL_NAME);
	expect(tool.label).toBe(WEB_SEARCH_TOOL_NAME);
	expect(tool.promptSnippet).toBe(tool.description);
	expect((tool.parameters as { type?: unknown }).type).toBe("object");
	expect((tool.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
	expect("properties" in (tool.parameters as object)).toBe(false);
	expect(tool.prepareArguments?.({ query: "ignored" })).toEqual({});
	expect(supportsNativeWebSearch(codexModel as never)).toBe(true);
	expect(supportsNativeWebSearch({ provider: "openai", id: "gpt-5.5" } as never)).toBe(false);
});

test("renders web search activity as a distinct compact search call", () => {
	const component = renderWebSearchMessage(
		{
			content: "Web search results\nQueries:\n- puppies",
			details: {
				searches: [
					{
						callId: "search_1",
						queries: ["puppies"],
						sources: [
							{ title: "American Kennel Club", url: "https://www.akc.org/puppies/" },
							{ title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Puppy" },
						],
					},
				],
			},
		},
		{ expanded: false },
		testTheme,
	);

	const rendered = component.render(1000).join("\n").trimEnd();
	expect(rendered).toBe(
		"<success>•</success> <bold>Web Searched</bold> <muted>puppies</muted><dim> · </dim><accent>2 results:</accent> <muted>American Kennel Club, Wikipedia</muted>",
	);
	expect(rendered).not.toContain("<bold>Explored</bold>");
	expect(rendered).not.toContain("customMessageBg");
	expect(rendered).not.toContain("Searched the web once");
});

test("renders at most five web search result labels when collapsed", () => {
	const component = renderWebSearchMessage(
		{
			content: "",
			details: {
				searches: [
					{
						callId: "search_1",
						queries: ["puppies"],
						sources: [
							{ title: "One", url: "https://example.com/1" },
							{ title: "Two", url: "https://example.com/2" },
							{ title: "Three", url: "https://example.com/3" },
							{ title: "Four", url: "https://example.com/4" },
							{ title: "Five", url: "https://example.com/5" },
							{ title: "Six", url: "https://example.com/6" },
						],
					},
				],
			},
		},
		{ expanded: false },
		testTheme,
	);

	const rendered = component.render(1000).join("\n").trimEnd();
	expect(rendered).toContain("<accent>6 results:</accent> <muted>One, Two, Three, Four, Five, +1 more</muted>");
	expect(rendered).not.toContain("Six");
});

test("rewrites image_generation only for image-capable openai-codex models", () => {
	const payload = {
		model: "gpt-5.5",
		input: [],
		tools: [{ type: "function", name: "image_generation", parameters: {} }],
	};

	const rewritten = rewriteNativeImageGenerationTool(payload, codexModel as never) as typeof payload;
	expect(rewritten.tools[0]).toEqual({
		type: "image_generation",
		output_format: "png",
	});

	const textOnly = rewriteNativeImageGenerationTool(payload, {
		...codexModel,
		input: ["text"],
	} as never) as typeof payload;
	expect(textOnly.tools[0]).toEqual(payload.tools[0]);
});

test("enables native image_generation for image-capable Codex models", () => {
	expect(supportsNativeImageGeneration(codexMiniModel as never)).toBe(true);
	expect(supportsNativeImageGeneration(codexModel as never)).toBe(true);

	const payload = {
		model: "gpt-5.4-mini",
		input: [],
		tools: [{ type: "function", name: "image_generation", parameters: {} }],
	};

	expect(rewriteNativeImageGenerationTool(payload, codexMiniModel as never).tools[0]).toEqual({
		type: "image_generation",
		output_format: "png",
	});
});

test("saves generated images under workspace .pi directory and mirrors latest", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-native-test-"));
	await mkdir(join(root, ".git"));
	const imageData = Buffer.from("fake-png").toString("base64");

	const saved = await saveOpenAICodexGeneratedImage(root, {
		responseId: "resp_123456789",
		callId: "call_abcdef",
		result: imageData,
		outputFormat: "png",
	});

	expect(saved.relativePath.startsWith(".pi/openai-codex-images/")).toBe(true);
	expect(saved.latestRelativePath).toBe(".pi/openai-codex-images/latest.png");
	expect(saved.mimeType).toBe("image/png");
	expect(saved.sha256).toBe("f084b1351c41cf3c554d932a3a978992a39b902f289c6e213b6428c3b38541ed");
	expect(await readFile(saved.absolutePath, "utf8")).toBe("fake-png");
	expect(await readFile(getOpenAICodexLatestImagePath(root), "utf8")).toBe("fake-png");
	expect(JSON.parse(buildGeneratedImageArtifactResult([saved]))).toEqual({
		artifacts: [
			{
				id: "call_abcdef",
				path: saved.absolutePath,
				mime_type: "image/png",
				sha256: saved.sha256,
			},
		],
	});
});

test("keeps concurrent generated image artifacts attributable to their calls", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-native-concurrent-images-test-"));
	await mkdir(join(root, ".git"));
	const [first, second] = await Promise.all([
		saveOpenAICodexGeneratedImage(root, {
			responseId: "resp_first",
			callId: "call_first",
			result: Buffer.from("first-image").toString("base64"),
		}),
		saveOpenAICodexGeneratedImage(root, {
			responseId: "resp_second",
			callId: "call_second",
			result: Buffer.from("second-image").toString("base64"),
		}),
	]);

	const result = JSON.parse(buildGeneratedImageArtifactResult([first, second]));
	expect(result.artifacts.map((artifact: { id: string }) => artifact.id)).toEqual(["call_first", "call_second"]);
	expect(await readFile(result.artifacts[0].path, "utf8")).toBe("first-image");
	expect(await readFile(result.artifacts[1].path, "utf8")).toBe("second-image");
	expect(result.artifacts[0].path).not.toBe(result.artifacts[1].path);
});

test("surfaces image artifact metadata in the originating assistant message", async () => {
	const output = {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as any;
	const events = {
		async *[Symbol.asyncIterator]() {
			yield {
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "image_generation_call",
					id: "ig_origin",
					status: "completed",
					result: PNG_BASE64,
					artifact_result: '{"artifacts":[{"id":"ig_origin","path":"/tmp/generated.png"}]}',
				},
			};
		},
	};
	const emitted: any[] = [];

	await processResponsesStream(
		events as never,
		output,
		{ push: (event: any) => emitted.push(event) } as never,
		codexModel as never,
	);

	expect(output.content).toHaveLength(2);
	expect(output.content[1]).toEqual({
		type: "text",
		text: '{"artifacts":[{"id":"ig_origin","path":"/tmp/generated.png"}]}',
	});
	expect(emitted.map((event) => event.type)).toEqual(["text_start", "text_end"]);
});
test("saves native image_generation assistant blocks for display", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-native-image-block-test-"));
	await mkdir(join(root, ".git"));
	const message = {
		role: "assistant",
		responseId: "resp_image_block",
		content: [
			{
				type: "image_generation_call",
				item: {
					type: "image_generation_call",
					id: "ig_image_block",
					status: "completed",
					result: PNG_BASE64,
					output_format: "png",
					revised_prompt: "a moon dog",
				},
			},
		],
	};

	const saved = await saveGeneratedImagesFromAssistantMessage(root, message);
	expect(saved).toHaveLength(1);
	expect(saved[0]?.relativePath).toContain(".pi/openai-codex-images/");
	expect(saved[0]?.latestRelativePath).toBe(".pi/openai-codex-images/latest.png");
	expect(saved[0]?.width).toBe(1);
	expect(saved[0]?.height).toBe(1);
	expect(JSON.parse(buildGeneratedImageArtifactResult(saved)).artifacts[0]).toMatchObject({
		id: "ig_image_block",
		path: saved[0]?.absolutePath,
		mime_type: "image/png",
		width: 1,
		height: 1,
		sha256: saved[0]?.sha256,
	});
	expect(await readFile(getOpenAICodexLatestImagePath(root), "base64")).toBe(PNG_BASE64);

	const duplicate = await saveGeneratedImagesFromAssistantMessage(root, message);
	expect(duplicate).toHaveLength(0);
});

test("renders generated images as compact activity with inline preview", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-native-render-image-test-"));
	await mkdir(join(root, ".git"));
	const saved = await saveOpenAICodexGeneratedImage(root, {
		responseId: "resp_render_image",
		callId: "ig_render_image",
		result: PNG_BASE64,
		outputFormat: "png",
		revisedPrompt: "a moon dog",
	});

	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	try {
		const component = renderImageGenerationMessage(
			{ content: "", details: { savedImages: [saved] } },
			{ expanded: true },
			testTheme,
		);
		const rendered = component.render(1000).join("\n");
		expect(rendered).toContain("<success>•</success> <bold>Generated image</bold>");
		expect(rendered).toContain("<accent>Prompt</accent> <muted>a moon dog</muted>");
		expect(rendered).toContain("\x1b]1337;File=");
		expect(rendered).toMatch(/width=\d+/);
		expect(rendered).not.toContain("[image_generation]");
		expect(rendered).not.toContain("customMessageBg");
	} finally {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	}
});

test("normalizes generic Codex websocket failures for auto-retry", () => {
	const base = {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "WebSocket error",
		timestamp: Date.now(),
	} as const;

	expect(normalizeCodexWebSocketErrorMessage(base as never)?.errorMessage).toBe("WebSocket connection error");
	expect(
		normalizeCodexWebSocketErrorMessage({
			...base,
			provider: "anthropic",
		} as never),
	).toBeUndefined();
	expect(isCodexWebSocketError(base as never)).toBe(true);
	expect(
		isCodexWebSocketError({
			...base,
			errorMessage: "WebSocket connection error after 418s (0s since last event, 4868 events)",
		} as never),
	).toBe(true);
	expect(
		isCodexWebSocketError({
			...base,
			errorMessage: "rate limit",
		} as never),
	).toBe(false);
});

test("discovers Codex app tools from Codex cache", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-apps-test-"));
	await mkdir(root, { recursive: true });
	await Bun.write(
		join(root, "tools.json"),
		JSON.stringify({
			tools: [
				{
					tool: {
						name: "slack.slack_read_channel",
						title: "slack_read_channel",
						description: "Reads messages.",
						inputSchema: {
							type: "object",
							properties: { channel_id: { type: "string" } },
							required: ["channel_id"],
						},
						annotations: { readOnlyHint: true },
						_meta: {
							connector_id: "asdk_app_slack",
							connector_name: "Slack",
							connector_description: "Slack app",
							link_id: "link_slack",
							_codex_apps: { resource_uri: "/asdk_app_slack/link_slack/slack_read_channel" },
						},
					},
				},
			],
		}),
	);

	const tools = await discoverCodexAppsTools(root);
	expect(tools).toHaveLength(1);
	expect(tools[0]?.piToolName).toBe("codex_apps_slack_slack_read_channel");
	expect(tools[0]?.mcpToolName).toBe("slack_slack_read_channel");
	expect(tools[0]?.key).toBe("asdk_app_slack:link_slack:slack_slack_read_channel");
	expect(tools[0]?.connectorName).toBe("Slack");
	expect(tools[0]?.readOnly).toBe(true);
});

test("activates read-only Codex app tools by default and respects explicit toggles", () => {
	const tools = [
		{
			key: "slack:read",
			piToolName: "codex_apps_slack_read",
			mcpToolName: "slack_read",
			title: "read",
			description: "read",
			inputSchema: {},
			connectorId: "slack",
			connectorName: "Slack",
			connectorDescription: "",
			readOnly: true,
			destructive: false,
			openWorld: true,
		},
		{
			key: "slack:send",
			piToolName: "codex_apps_slack_send",
			mcpToolName: "slack_send",
			title: "send",
			description: "send",
			inputSchema: {},
			connectorId: "slack",
			connectorName: "Slack",
			connectorDescription: "",
			readOnly: false,
			destructive: true,
			openWorld: true,
		},
	];

	expect(activeCodexAppsToolNames(tools, { enabled: true }, ["read"])).toEqual(["read", "codex_apps_slack_read"]);
	expect(activeCodexAppsToolNames(tools, { enabled: true, enabledToolKeys: ["slack:send"] }, ["read"])).toEqual([
		"read",
		"codex_apps_slack_send",
	]);
	expect(activeCodexAppsToolNames(tools, { enabled: false, enabledToolKeys: ["slack:send"] }, ["read"])).toEqual([
		"read",
	]);
});

test("disables every app tool owned by a disabled plugin", () => {
	const tools = [
		{
			key: "sites:read",
			piToolName: "codex_apps_sites_list",
			mcpToolName: "list",
			title: "list",
			description: "list",
			inputSchema: {},
			connectorId: "sites",
			connectorName: "Sites",
			connectorDescription: "",
			readOnly: true,
			destructive: false,
			openWorld: false,
		},
		{
			key: "slack:read",
			piToolName: "codex_apps_slack_read",
			mcpToolName: "read",
			title: "read",
			description: "read",
			inputSchema: {},
			connectorId: "slack",
			connectorName: "Slack",
			connectorDescription: "",
			readOnly: true,
			destructive: false,
			openWorld: true,
		},
	];
	const plugins = [
		{
			key: "sites",
			name: "sites",
			version: "0.1.27",
			marketplace: "openai-bundled",
			rootPath: "/plugins/sites",
			skillPaths: [],
			connectorIds: ["sites"],
		},
	];
	const disabled = disabledCodexAppToolKeys(tools, plugins, { enabled: true, disabledPluginKeys: ["sites"] });

	expect(activeCodexAppsToolNames(tools, { enabled: true }, ["read"], disabled)).toEqual([
		"read",
		"codex_apps_slack_read",
	]);
});

test("builds app surfaces from plugin connector manifests", () => {
	const tools = [
		{
			key: "sites:list",
			piToolName: "codex_apps_sites_list",
			mcpToolName: "list",
			title: "List sites",
			description: "list",
			inputSchema: {},
			connectorId: "connector_sites",
			connectorName: "Sites",
			connectorDescription: "Build and deploy websites with Sites",
			readOnly: true,
			destructive: false,
			openWorld: true,
		},
	];
	const apps = buildCodexAppRecords(tools, [
		{
			key: "sites",
			name: "sites",
			version: "0.1.27",
			marketplace: "openai-bundled",
			rootPath: "/plugins/sites",
			skillPaths: [],
			connectorIds: ["connector_sites"],
		},
	]);

	expect(apps).toEqual([
		{
			connectorId: "connector_sites",
			connectorName: "Sites",
			connectorDescription: "Build and deploy websites with Sites",
			toolKeys: ["sites:list"],
			pluginKey: "sites",
		},
	]);
});

test("discovers newest plugin manifests and their skill roots", async () => {
	const root = join(await mkdtemp(join(tmpdir(), "codex-plugin-skills-test-")), ".codex");
	const newest = join(root, "plugins", "cache", "openai-bundled", "sites", "0.1.27");
	const older = join(root, "plugins", "cache", "openai-bundled", "sites", "0.1.9");
	const alternateMarketplace = join(root, "plugins", "cache", "openai-curated", "sites", "9deadbeef");
	const other = join(root, "plugins", "cache", "openai-bundled", "visualize", "1.0.11");
	const flatApp = join(root, ".tmp", "plugins", "plugins", "datadog");
	await mkdir(join(newest, ".codex-plugin"), { recursive: true });
	await mkdir(join(newest, "declared-skills", "sites-building"), {
		recursive: true,
	});
	await mkdir(join(older, ".codex-plugin"), {
		recursive: true,
	});
	await mkdir(join(alternateMarketplace, ".codex-plugin"), {
		recursive: true,
	});
	await mkdir(join(other, ".codex-plugin"), {
		recursive: true,
	});
	await mkdir(join(flatApp, ".codex-plugin"), {
		recursive: true,
	});
	await Bun.write(
		join(newest, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "fixture-sites", version: "0.1.27", skills: "./declared-skills" }),
	);
	await Bun.write(
		join(older, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "fixture-sites", version: "0.1.9" }),
	);
	await Bun.write(
		join(alternateMarketplace, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "fixture-sites", version: "0.1.1" }),
	);
	await Bun.write(
		join(other, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "visualize", version: "1.0.11" }),
	);
	await Bun.write(
		join(flatApp, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "datadog", version: "0.1.2", apps: "./.app.json" }),
	);
	await Bun.write(
		join(root, "config.toml"),
		'[plugins."fixture-sites@openai-bundled"]\nenabled = true\n[plugins."visualize@openai-bundled"]\nenabled = false\n',
	);

	const plugins = await discoverCodexPlugins(root);
	expect(plugins.map((plugin) => plugin.name)).toEqual(["fixture-sites", "visualize"]);
	const sites = plugins.find((plugin) => plugin.name === "fixture-sites");
	expect(sites?.version).toBe("0.1.27");
	expect(sites?.marketplace).toBe("openai-bundled");
	expect(pluginSkillPaths(plugins, { enabled: true })).toEqual([join(newest, "declared-skills")]);
	expect(pluginSkillPaths(plugins, { enabled: true, disabledPluginKeys: ["fixture-sites"] })).toEqual([]);
});

test("loads Codex system skills", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-system-skills-test-"));
	const skills = join(root, "skills", ".system");
	await mkdir(skills, { recursive: true });

	expect(await systemSkillPaths(root)).toEqual([skills]);
});

test("does not expose skills from unconfigured marketplace inventory", async () => {
	const home = await mkdtemp(join(tmpdir(), "codex-plugin-config-test-"));
	const inventoryPlugin = join(home, ".codex", ".tmp", "plugins", "plugins", "build-web-data-visualization");
	await mkdir(join(inventoryPlugin, ".codex-plugin"), { recursive: true });
	await Bun.write(join(home, ".codex", "config.toml"), '[plugins."fixture-sites@openai-bundled"]\nenabled = true\n');

	expect(isCodexPluginEnabled("build-web-data-visualization", "tmp", inventoryPlugin)).toBe(false);
	expect(
		isCodexPluginEnabled(
			"fixture-sites",
			"openai-bundled",
			join(home, ".codex", "plugins", "cache", "openai-bundled", "sites", "1.0.0"),
		),
	).toBe(true);
});

test("uses the Pi-native Computer Use skill instead of the Codex node-repl skill", () => {
	const plugin = {
		key: "computer-use",
		name: "computer-use",
		version: "1.0.0",
		marketplace: "openai-bundled",
		rootPath: "/plugins/computer-use",
		skillPaths: ["/plugins/computer-use/skills"],
		connectorIds: [],
	};

	expect(pluginSkillPaths([plugin], { enabled: true })).toEqual([
		join(import.meta.dir, "skill-resources", "computer-use"),
	]);
});

test("does not launch the Computer Use MCP client directly under Pi", async () => {
	const root = await mkdtemp(join(tmpdir(), "computer-use-mcp-skip-test-"));
	const server = [
		"const readline = require('node:readline');",
		"const rl = readline.createInterface({ input: process.stdin });",
		"rl.on('line', line => {",
		"  const request = JSON.parse(line);",
		"  const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [{ name: 'list_apps' }] };",
		"  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
		"});",
	].join("\n");
	await Bun.write(
		join(root, ".mcp.json"),
		JSON.stringify({ mcpServers: { "computer-use": { command: process.execPath, args: ["-e", server] } } }),
	);
	const surfaces = await discoverPluginMcpTools([
		{
			key: "computer-use",
			name: "computer-use",
			version: "1.0.0",
			marketplace: "openai-bundled",
			rootPath: root,
			skillPaths: [],
			connectorIds: [],
		},
	]);

	try {
		expect(surfaces).toEqual([]);
	} finally {
		for (const surface of surfaces) surface.client.close();
	}
});

test("migrates explicit tool selections to the Computer Use surface once", () => {
	const config = { enabled: true, enabledToolKeys: ["slack:read"] };
	const tools = [
		{
			key: "computer-use:js",
			piToolName: "node_repl",
			mcpToolName: "js",
			title: "Run JavaScript",
			description: "Run JavaScript",
			inputSchema: {},
			connectorId: "computer-use",
			connectorName: "Computer Use",
			connectorDescription: "Control Mac apps",
			readOnly: false,
			destructive: false,
			openWorld: true,
			defaultEnabled: true,
		},
	];
	const plugins = [
		{
			key: "computer-use",
			name: "computer-use",
			version: "1.0.0",
			marketplace: "openai-bundled",
			rootPath: "/plugins/computer-use",
			skillPaths: [],
			connectorIds: [],
		},
	];

	expect(migrateCodexAppsConfig(config, tools, plugins)).toBe(true);
	expect(config.enabledToolKeys).toEqual(["computer-use:js", "slack:read"]);
	expect(config.surfaceVersion).toBe(1);
	expect(migrateCodexAppsConfig(config, tools, plugins)).toBe(false);
});

test("Computer Use renders one compact row and reveals details only when expanded", () => {
	const tool = {
		key: "computer-use:js",
		piToolName: "node_repl",
		mcpToolName: "js",
		title: "Run JavaScript",
		description: "Run JavaScript",
		inputSchema: {},
		connectorId: "computer-use",
		connectorName: "Computer Use",
		connectorDescription: "Control Mac apps",
		readOnly: false,
		destructive: false,
		openWorld: true,
	};
	const definition = createToolDefinition(tool, () => ({ enabled: true }), new Map());
	const args = { title: "Inspect Bootty", code: "nodeRepl.write(JSON.stringify(state));" };
	const call = definition.renderCall?.(
		args,
		testTheme as never,
		{
			args,
			isPartial: false,
			isError: false,
		} as never,
	);

	expect(call?.render(160).join("\n")).toContain("Inspect Bootty");
	expect(call?.render(160).join("\n")).not.toContain(args.code);

	const result = { content: [{ type: "text" as const, text: "Window: Bootty" }] };
	const collapsed = definition.renderResult?.(
		result,
		{ expanded: false },
		testTheme as never,
		{
			args,
			isPartial: false,
			isError: false,
		} as never,
	);
	expect(collapsed?.render(160)).toEqual([]);

	const expanded = definition.renderResult?.(
		result,
		{ expanded: true },
		testTheme as never,
		{
			args,
			lastComponent: collapsed,
			isPartial: false,
			isError: false,
		} as never,
	);
	const expandedText = expanded?.render(160).join("\n") ?? "";
	expect(expandedText).toContain("Code:");
	expect(expandedText).toContain(args.code);
	expect(expandedText).toContain("Output:");
	expect(expandedText).toContain("Window: Bootty");
	expect(expandedText).not.toContain("Inspect Bootty");
});

test("Computer Use renders image results through the shared Kitty renderer", () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	try {
		const tool = {
			key: "computer-use:js",
			piToolName: "node_repl",
			mcpToolName: "js",
			title: "Run JavaScript",
			description: "Run JavaScript",
			inputSchema: {},
			connectorId: "computer-use",
			connectorName: "Computer Use",
			connectorDescription: "Control Mac apps",
			readOnly: false,
			destructive: false,
			openWorld: true,
		};
		const definition = createToolDefinition(tool, () => ({ enabled: true }), new Map());
		const result = {
			content: [{ type: "image" as const, data: PNG_BASE64, mimeType: "image/png" }],
		};

		const rendered =
			definition
				.renderResult?.(
					result,
					{ expanded: false },
					testTheme as never,
					{
						args: {},
						isPartial: false,
						isError: false,
					} as never,
				)
				.render(80)
				.join("\n") ?? "";

		expect(rendered).toContain("\x1b_Ga=T");
		expect(result.content).toEqual([]);
	} finally {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	}
});

test("local MCP client keeps a server session and forwards tool calls", async () => {
	const server = [
		"const readline = require('node:readline');",
		"const rl = readline.createInterface({ input: process.stdin });",
		"let calls = 0;",
		"rl.on('line', line => {",
		"  const request = JSON.parse(line);",
		"  let result;",
		"  if (request.method === 'initialize') result = { protocolVersion: '2025-06-18' };",
		"  else if (request.method === 'tools/list') result = { tools: [{ name: 'js', inputSchema: { type: 'object' } }] };",
		"  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: String(++calls) }] };",
		"  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
		"});",
	].join("\n");
	const client = new LocalMcpClient({ command: process.execPath, args: ["-e", server], env: {} });

	expect(await client.listTools()).toEqual([{ name: "js", inputSchema: { type: "object" } }]);
	expect(await client.callTool("js", {})).toEqual({ content: [{ type: "text", text: "1" }] });
	expect(await client.callTool("js", {})).toEqual({ content: [{ type: "text", text: "2" }] });
	client.close();
});

test("local MCP client answers server elicitation requests through its approval callback", async () => {
	const server = [
		"const readline = require('node:readline');",
		"const rl = readline.createInterface({ input: process.stdin });",
		"let callId;",
		"rl.on('line', line => {",
		"  const request = JSON.parse(line);",
		"  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } }) + '\\n');",
		"  else if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'click' }] } }) + '\\n');",
		"  else if (request.method === 'tools/call') { callId = request.id; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'elicitation/create', params: { message: 'Allow click?' } }) + '\\n'); }",
		"  else if (request.id === 99) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: request.result.action }] } }) + '\\n');",
		"});",
	].join("\n");
	const client = new LocalMcpClient({ command: process.execPath, args: ["-e", server], env: {} });
	let approvalMessage = "";

	try {
		expect(await client.listTools()).toEqual([{ name: "click" }]);
		expect(
			await client.callTool("click", {}, undefined, async (message) => {
				approvalMessage = message;
				return true;
			}),
		).toEqual({ content: [{ type: "text", text: "accept" }] });
		expect(approvalMessage).toBe("Allow click?");
	} finally {
		client.close();
	}
});

test("Codex app-server MCP client proxies tools through a signed Codex parent", async () => {
	const server = [
		"const readline = require('node:readline');",
		"const rl = readline.createInterface({ input: process.stdin });",
		"let callId;",
		"rl.on('line', line => {",
		"  const request = JSON.parse(line);",
		"  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');",
		"  else if (request.method === 'thread/start') process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: 'thread-1' } } }) + '\\n');",
		"  else if (request.method === 'mcpServerStatus/list') process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{ name: 'node_repl', tools: { js: { name: 'js', inputSchema: { type: 'object' } } } }] } }) + '\\n');",
		"  else if (request.method === 'mcpServer/tool/call') { callId = request.id; process.stdout.write(JSON.stringify({ id: 99, method: 'mcpServer/elicitation/request', params: { mode: 'form', message: 'Allow JavaScript?', serverName: 'node_repl', threadId: 'thread-1', turnId: null, requestedSchema: {}, _meta: null } }) + '\\n'); }",
		"  else if (request.id === 99) process.stdout.write(JSON.stringify({ id: callId, result: { content: [{ type: 'text', text: request.result.action }] } }) + '\\n');",
		"});",
	].join("\n");
	const client = new CodexAppServerMcpClient("node_repl", {
		command: process.execPath,
		args: ["-e", server],
		cwd: process.cwd(),
	});
	let approvalMessage = "";

	try {
		expect(await client.listTools()).toEqual([{ name: "js", inputSchema: { type: "object" } }]);
		expect(
			await client.callTool("js", { code: "1 + 1" }, undefined, async (message) => {
				approvalMessage = message;
				return true;
			}),
		).toEqual({ content: [{ type: "text", text: "accept" }] });
		expect(approvalMessage).toBe("Allow JavaScript?");
	} finally {
		client.close();
	}
});

test("Codex Tools panel supports vim navigation, filtering, and app tabs", async () => {
	const tool = {
		key: "slack:read",
		piToolName: "codex_apps_slack_read",
		mcpToolName: "read",
		title: "Read channel",
		description: "Read messages from a Slack channel",
		inputSchema: {},
		connectorId: "slack",
		connectorName: "Slack",
		connectorDescription: "Read and manage Slack",
		readOnly: true,
		destructive: false,
		openWorld: true,
	};
	const plugin = {
		key: "slack",
		name: "slack",
		version: "0.1.4",
		marketplace: "openai-curated-remote",
		rootPath: "/plugins/slack",
		skillPaths: [],
		connectorIds: ["slack"],
	};
	const config = { enabled: true, enabledToolKeys: [tool.key] };
	let saves = 0;
	let closed = false;
	const panel = new CodexToolsPanel(
		testTheme as never,
		[tool],
		[plugin],
		config,
		async () => {
			saves++;
		},
		() => {
			closed = true;
		},
	);

	const initialRender = panel.render(120);
	expect(initialRender.join("\n")).toContain("[ Main ]");
	expect(initialRender[0]).toContain("<border>╭");
	expect(initialRender.at(-1)).toContain("<border>╰");
	const panelHeight = initialRender.length;
	panel.handleInput("l");
	const appRender = panel.render(120);
	expect(appRender.join("\n")).toContain("[ Slack ]");
	expect(appRender).toHaveLength(panelHeight);
	panel.handleInput("/");
	panel.handleInput("r");
	panel.handleInput("e");
	const filteredRender = panel.render(120);
	expect(filteredRender.join("\n")).toContain("/re▌");
	expect(filteredRender).toHaveLength(panelHeight);
	panel.handleInput("\r");
	panel.handleInput("h");
	panel.handleInput("j");
	panel.handleInput("j");
	expect(panel.render(120).join("\n")).toContain("<accent>▸</accent> App · Slack");
	panel.handleInput("l");
	panel.handleInput("\r");
	await panel.waitForPendingSaves();

	expect(config.enabledToolKeys).toEqual([]);
	expect(saves).toBe(1);
	const finalRender = panel.render(120);
	expect(finalRender.join("\n")).toContain("[ Main ]");
	expect(finalRender).toHaveLength(panelHeight);
	panel.handleInput("q");
	expect(closed).toBe(true);
});

test("Codex Tools panel persists per-skill autocomplete visibility", async () => {
	const config = { enabled: true };
	let saves = 0;
	const panel = new CodexToolsPanel(
		testTheme as never,
		[],
		[
			{
				key: "browser",
				name: "browser",
				version: "1.0.0",
				marketplace: "openai-bundled",
				rootPath: "/plugins/browser",
				skillPaths: ["/plugins/browser/skills"],
				connectorIds: [],
			},
		],
		config,
		async () => {
			saves++;
		},
		() => {},
		[
			{
				name: "control-in-app-browser",
				filePath: "/plugins/browser/skills/control-in-app-browser/SKILL.md",
				pluginKey: "browser",
			},
		],
	);

	panel.handleInput("/");
	for (const character of "control-in-app-browser") panel.handleInput(character);
	panel.handleInput("\r");
	expect(panel.render(120).join("\n")).toContain("Skill · control-in-app-browser  <success>on</success>");
	panel.handleInput(" ");
	await panel.waitForPendingSaves();

	expect(config.hiddenSkillNames).toEqual(["control-in-app-browser"]);
	expect(saves).toBe(1);
	expect(panel.render(120).join("\n")).toContain("Skill · control-in-app-browser  <muted>off</muted>");
});

test("node_repl tools come from cache without spawning the codex app-server", async () => {
	// CODEX_CLI_PATH points at a binary that cannot exist: if discovery tried to hand the tool list
	// off to the app-server, the spawn would fail and no tools would come back.
	const previousCliPath = process.env.CODEX_CLI_PATH;
	process.env.CODEX_CLI_PATH = join(tmpdir(), "definitely-not-a-codex-binary");
	const cachePath = join(await mkdtemp(join(tmpdir(), "node-repl-cache-")), "tools.json");
	try {
		const cachedTool = {
			key: "computer-use:js",
			piToolName: "node_repl",
			mcpToolName: "js",
			title: "js",
			description: "run javascript",
			inputSchema: { type: "object" },
			connectorId: "computer-use",
			connectorName: "Computer Use",
			connectorDescription: "",
			readOnly: false,
			destructive: false,
			openWorld: false,
		};
		await writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), tools: [cachedTool] }));

		const surface = await discoverNodeReplTools(cachePath);

		expect(surface?.tools.map((tool) => tool.piToolName)).toEqual(["node_repl"]);
		// Cache is inside the TTL, so the background refresh must be a no-op rather than a spawn.
		expect(await surface?.refresh()).toEqual([]);
	} finally {
		if (previousCliPath === undefined) delete process.env.CODEX_CLI_PATH;
		else process.env.CODEX_CLI_PATH = previousCliPath;
	}
});

test("node_repl discovery refreshes past the cache TTL and reports only newly seen tools", async () => {
	const previousCliPath = process.env.CODEX_CLI_PATH;
	process.env.CODEX_CLI_PATH = join(tmpdir(), "definitely-not-a-codex-binary");
	const cachePath = join(await mkdtemp(join(tmpdir(), "node-repl-stale-")), "tools.json");
	try {
		await writeFile(
			cachePath,
			JSON.stringify({
				fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
				tools: [{ key: "computer-use:js", piToolName: "node_repl" }],
			}),
		);

		const surface = await discoverNodeReplTools(cachePath);

		// Stale cache still serves startup immediately...
		expect(surface?.tools.map((tool) => tool.piToolName)).toEqual(["node_repl"]);
		// ...and the refresh does reach for the app-server, which cannot spawn here, so it rejects
		// rather than silently reporting an empty tool list.
		await expect(surface?.refresh()).rejects.toThrow();
	} finally {
		if (previousCliPath === undefined) delete process.env.CODEX_CLI_PATH;
		else process.env.CODEX_CLI_PATH = previousCliPath;
	}
});
