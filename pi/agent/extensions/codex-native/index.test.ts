import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNNESTABLE_TOOLS } from "../code-mode/nested-dispatch.ts";
import { CodexAppServerMcpClient, type CodexAppServerMcpServer } from "./app-server-mcp.ts";
import {
	buildCodexAppRecords,
	codexMcpWarnings,
	disabledConnectorIds,
	discoverCodexAppsTools,
	discoverCodexPlugins,
	discoverPluginMcpTools,
	enabledCodexAppsTools,
	migrateCodexAppsConfig,
	pluginSkillPaths,
	systemSkillPaths,
} from "./codex-apps.ts";
import {
	buildImageGenerationRequestBody,
	collectRecentSessionImages,
	extractGeneratedImage,
	loadReferencedImages,
	readImageGenerationArgs,
} from "./image-gen.ts";
import {
	isCodexWebSocketError,
	normalizeCodexWebSocketError as normalizeCodexWebSocketErrorMessage,
	normalizeLegacyFunctionCallIds,
} from "./index.ts";
import {
	buildGeneratedImageArtifactResult,
	createImageGenerationTool,
	createWebSearchTool,
	getOpenAICodexLatestImagePath,
	rewriteNativeImageGenerationTool,
	rewriteNativeWebSearchTool,
	saveGeneratedImagesFromAssistantMessage,
	saveOpenAICodexGeneratedImage,
	supportsNativeImageGeneration,
	supportsNativeWebSearch,
	WEB_SEARCH_TOOL_NAME,
} from "./native-tools.ts";
import { convertResponsesMessages } from "./openai-responses-shared.ts";
import { isCodexPluginEnabled } from "./plugin-aliases.ts";
import { buildSearchRequestBody, createWebRunTool, resolveCodexSearchUrl, WEB_RUN_TOOL_NAME } from "./web-run.ts";

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

/**
 * A codex app-server that answers the four methods this bridge sends.
 *
 * `click` elicits and `list_apps` does not, which is the distinction the real
 * server makes and the only one these tests turn on. Note the absence of a
 * `jsonrpc` field: the app-server protocol omits it, and a client that assumed
 * otherwise would pass against a stricter fake than the real thing.
 */
const fakeCodexAppServer = [
	"const readline = require('node:readline');",
	"const rl = readline.createInterface({ input: process.stdin });",
	"const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
	"let callId;",
	"rl.on('line', line => {",
	"  const request = JSON.parse(line);",
	"  if (request.method === 'initialize') send({ id: request.id, result: {} });",
	"  else if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-1' } } });",
	"  else if (request.method === 'mcpServerStatus/list') send({ id: request.id, result: { data: [{ name: 'computer-use', tools: { list_apps: { name: 'list_apps', inputSchema: { type: 'object' } } } }] } });",
	"  else if (request.method === 'mcpServer/tool/call' && request.params.tool === 'click') { callId = request.id; send({ id: 99, method: 'mcpServer/elicitation/request', params: { mode: 'form', message: 'Allow click?', serverName: request.params.server, threadId: request.params.threadId, turnId: null, requestedSchema: {}, _meta: null } }); }",
	"  else if (request.method === 'mcpServer/tool/call') send({ id: request.id, result: { content: [{ type: 'text', text: 'ok' }] } });",
	"  else if (request.id === 99) send(request.error ? { id: callId, error: request.error } : { id: callId, result: { content: [{ type: 'text', text: request.result.action }] } });",
	"});",
].join("\n");

const retryingThreadAppServer = [
	"const readline = require('node:readline');",
	"const rl = readline.createInterface({ input: process.stdin });",
	"const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
	"let threadStarts = 0;",
	"rl.on('line', line => {",
	"  const request = JSON.parse(line);",
	"  if (request.method === 'initialize') send({ id: request.id, result: {} });",
	"  else if (request.method === 'thread/start') { threadStarts++; send({ id: request.id, result: threadStarts === 1 ? {} : { thread: { id: 'thread-1' } } }); }",
	"  else if (request.method === 'mcpServer/tool/call') send({ id: request.id, result: { content: [{ type: 'text', text: 'ok' }] } });",
	"});",
].join("\n");

function createTestMcpClient(servers: Map<string, CodexAppServerMcpServer>): CodexAppServerMcpClient {
	return { listServers: async () => servers, close: () => {} } as unknown as CodexAppServerMcpClient;
}

function nodeReplMcpServer(): CodexAppServerMcpServer {
	return {
		enabled: true,
		serverInfo: { name: "rmcp", version: "1.5.0" },
		tools: [
			{
				name: "js",
				inputSchema: {
					type: "object",
					properties: { code: { type: "string" }, title: { type: "string" }, timeout_ms: { type: "integer" } },
					required: ["code", "title", "timeout_ms"],
					additionalProperties: false,
				},
			},
			{ name: "js_reset", inputSchema: { type: "object" } },
			{ name: "js_add_node_module_dir", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
		],
	};
}

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
	expect(tools[0]?.connectorId).toBe("asdk_app_slack");
});

test("registers every connector tool by default and drops a switched-off connector", () => {
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
			key: "sites:list",
			piToolName: "codex_apps_sites_list",
			mcpToolName: "sites_list",
			title: "list",
			description: "list",
			inputSchema: {},
			connectorId: "sites",
			connectorName: "Sites",
			connectorDescription: "",
			readOnly: false,
			destructive: true,
			openWorld: true,
		},
	];

	// Write and destructive tools are registered too: nesting made the read-only
	// default pointless, and a cell can call anything the human left switched on.
	expect(enabledCodexAppsTools(tools, [], { enabled: true }).map((tool) => tool.piToolName)).toEqual([
		"codex_apps_slack_read",
		"codex_apps_sites_list",
	]);
	expect(
		enabledCodexAppsTools(tools, [], { enabled: true, disabledConnectorIds: ["sites"] }).map(
			(tool) => tool.piToolName,
		),
	).toEqual(["codex_apps_slack_read"]);
	expect(enabledCodexAppsTools(tools, [], { enabled: false })).toEqual([]);
});

test("a disabled plugin switches off the connectors it owns", () => {
	const plugins = [
		{
			key: "sites",
			name: "sites",
			version: "0.1.27",
			marketplace: "openai-bundled",
			rootPath: "/plugins/sites",
			skillPaths: [],
			connectorIds: ["connector_sites"],
		},
	];

	expect([...disabledConnectorIds(plugins, { enabled: true, disabledPluginKeys: ["sites"] })].sort()).toEqual([
		"connector_sites",
		"sites",
	]);
	expect([...disabledConnectorIds(plugins, { enabled: true })]).toEqual([]);
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

test("discovers the Computer Use plugin alongside the rest", async () => {
	const root = join(await mkdtemp(join(tmpdir(), "codex-computer-use-test-")), ".codex");
	const computerUse = join(root, "plugins", "cache", "openai-bundled", "computer-use", "1.0.0");
	const sites = join(root, "plugins", "cache", "openai-bundled", "sites", "0.1.27");
	await mkdir(join(computerUse, ".codex-plugin"), { recursive: true });
	await mkdir(join(sites, ".codex-plugin"), { recursive: true });
	await Bun.write(
		join(computerUse, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "computer-use", version: "1.0.0" }),
	);
	await Bun.write(join(sites, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "sites", version: "0.1.27" }));
	await Bun.write(
		join(root, "config.toml"),
		'[plugins."computer-use@openai-bundled"]\nenabled = true\n[plugins."sites@openai-bundled"]\nenabled = true\n',
	);

	// Its MCP helper refuses a caller pi could ever be, but the calls go through
	// the codex app-server rather than pi, so the plugin is bridgeable again.
	expect((await discoverCodexPlugins(root)).map((plugin) => plugin.name)).toEqual(["computer-use", "sites"]);
});

test("reaches a plugin's own MCP server through the codex app-server, and only when enabled", async () => {
	const root = await mkdtemp(join(tmpdir(), "plugin-mcp-test-"));
	await Bun.write(
		join(root, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				"computer-use": { command: "./bin/launcher", args: ["mcp"] },
				// A remote connector arrives through `codex_apps` instead, so
				// registering it here would give every one of its tools a
				// second name.
				notion: { type: "http", url: "https://mcp.notion.com/mcp" },
			},
		}),
	);
	const plugin = {
		key: "computer-use",
		name: "computer-use",
		version: "1.0.0",
		marketplace: "openai-bundled",
		rootPath: root,
		skillPaths: [],
		connectorIds: [],
		displayName: "Computer Use",
	};
	let clientsCreated = 0;
	const createClient = () => {
		clientsCreated++;
		return new CodexAppServerMcpClient({
			command: process.execPath,
			args: ["-e", fakeCodexAppServer],
			cwd: root,
		});
	};

	const skipped = await discoverPluginMcpTools(
		[plugin],
		{ enabled: true, disabledPluginKeys: ["computer-use"] },
		createClient,
	);
	expect(skipped.tools).toEqual([]);
	expect(clientsCreated).toBe(0);

	const discovered = await discoverPluginMcpTools([plugin], { enabled: true }, createClient);
	try {
		expect(discovered.tools.map((tool) => tool.piToolName)).toEqual(["mcp__computer_use__list_apps"]);
		expect(discovered.tools.map((tool) => tool.connectorName)).toEqual(["Computer Use"]);
	} finally {
		discovered.client?.close();
	}
});

test("exposes configured MCP tools without a plugin owner", async () => {
	const discovered = await discoverPluginMcpTools(
		[],
		{ enabled: true },
		() => createTestMcpClient(new Map([["node_repl", nodeReplMcpServer()]])),
		[{ name: "node_repl", enabled: true }],
	);

	expect(discovered.tools.map((tool) => tool.piToolName)).toEqual([
		"mcp__node_repl__js",
		"mcp__node_repl__js_reset",
		"mcp__node_repl__js_add_node_module_dir",
	]);
	expect(discovered.tools[0]?.inputSchema).toMatchObject({
		required: ["code", "title", "timeout_ms"],
		additionalProperties: false,
	});
});

test("keeps MCP tool names unique after sanitization", async () => {
	const discovered = await discoverPluginMcpTools(
		[],
		{ enabled: true },
		() =>
			createTestMcpClient(
				new Map([["node_repl", { enabled: true, tools: [{ name: "foo-bar" }, { name: "foo_bar" }] }]]),
			),
		[{ name: "node_repl", enabled: true }],
	);
	const names = discovered.tools.map((tool) => tool.piToolName);

	expect(names[0]).toBe("mcp__node_repl__foo_bar");
	expect(names[1]).toMatch(/^mcp__node_repl__foo_bar_[a-z0-9]+$/);
	expect(new Set(names).size).toBe(2);
});

test("does not warn for disabled configured MCP servers", async () => {
	const discovered = await discoverPluginMcpTools([], { enabled: true }, undefined, [
		{ name: "computer-use", enabled: false },
	]);

	expect(discovered.tools).toEqual([]);
	expect(codexMcpWarnings(discovered.servers)).toEqual([]);
});

test("config ownership wins when a plugin claims the same MCP server", async () => {
	const root = await mkdtemp(join(tmpdir(), "configured-mcp-plugin-test-"));
	await Bun.write(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { node_repl: { command: "node-repl" } } }));
	const plugin = {
		key: "node-repl-plugin",
		name: "node-repl-plugin",
		version: "1.0.0",
		marketplace: "test",
		rootPath: root,
		skillPaths: [],
		connectorIds: [],
	};

	const discovered = await discoverPluginMcpTools(
		[plugin],
		{ enabled: true },
		() => createTestMcpClient(new Map([["node_repl", nodeReplMcpServer()]])),
		[{ name: "node_repl", enabled: true }],
	);

	expect(discovered.tools).toHaveLength(3);
	expect(discovered.tools.every((tool) => tool.key.startsWith("codex-config:node_repl:"))).toBe(true);
	expect(discovered.tools.every((tool) => tool.connectorId === "mcp:node_repl")).toBe(true);
});

test("Codex app-server MCP client lists servers and forwards a call", async () => {
	const client = new CodexAppServerMcpClient({
		command: process.execPath,
		args: ["-e", fakeCodexAppServer],
		cwd: process.cwd(),
	});

	try {
		expect([...(await client.listServers()).keys()]).toEqual(["computer-use"]);
		expect(await client.callTool("computer-use", "list_apps", {})).toEqual({
			content: [{ type: "text", text: "ok" }],
		});
	} finally {
		client.close();
	}
});

// An elicitation arrives while the tool call is still open, so a client that
// ignored it would hang rather than fail — the expensive, silent kind of bug.
test("Codex app-server MCP client answers a mid-call elicitation instead of stalling", async () => {
	const client = new CodexAppServerMcpClient({
		command: process.execPath,
		args: ["-e", fakeCodexAppServer],
		cwd: process.cwd(),
	});

	try {
		expect(await client.callTool("computer-use", "click", { app: "Dia" })).toEqual({
			content: [{ type: "text", text: "accept" }],
		});
	} finally {
		client.close();
	}
});

test("rejects a mid-call elicitation from an untrusted server", async () => {
	const client = new CodexAppServerMcpClient({
		command: process.execPath,
		args: ["-e", fakeCodexAppServer],
		cwd: process.cwd(),
	});

	try {
		await expect(client.callTool("untrusted", "click", {})).rejects.toThrow(
			"MCP elicitation rejected for untrusted server untrusted",
		);
	} finally {
		client.close();
	}
});

test("retries MCP calls after thread startup fails", async () => {
	const client = new CodexAppServerMcpClient({
		command: process.execPath,
		args: ["-e", retryingThreadAppServer],
		cwd: process.cwd(),
	});

	try {
		await expect(client.callTool("computer-use", "list_apps", {})).rejects.toThrow(
			"Codex app-server returned an invalid thread",
		);
		expect(await client.callTool("computer-use", "list_apps", {})).toEqual({
			content: [{ type: "text", text: "ok" }],
		});
	} finally {
		client.close();
	}
});

test("migration drops the dead per-tool selection and re-enables the bridge once", () => {
	const config = {
		enabled: false,
		enabledToolKeys: ["slack:read"],
		defaultEnableReadOnly: true,
		disabledPluginKeys: ["sites"],
		hiddenSkillNames: ["control-in-app-browser"],
	};

	expect(migrateCodexAppsConfig(config)).toBe(true);
	expect(config).toEqual({
		enabled: true,
		disabledPluginKeys: ["sites"],
		hiddenSkillNames: ["control-in-app-browser"],
		surfaceVersion: 2,
	});
	expect(migrateCodexAppsConfig(config)).toBe(false);
});

test("resolves the Codex search endpoint beside codex/responses", () => {
	expect(resolveCodexSearchUrl("https://chatgpt.com/backend-api")).toBe(
		"https://chatgpt.com/backend-api/codex/alpha/search",
	);
	expect(resolveCodexSearchUrl("https://chatgpt.com/backend-api/")).toBe(
		"https://chatgpt.com/backend-api/codex/alpha/search",
	);
	expect(resolveCodexSearchUrl("https://chatgpt.com/backend-api/codex")).toBe(
		"https://chatgpt.com/backend-api/codex/alpha/search",
	);
	expect(resolveCodexSearchUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(
		"https://chatgpt.com/backend-api/codex/alpha/search",
	);
	expect(resolveCodexSearchUrl(undefined)).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
});

test("sends web__run commands verbatim with direct-caller settings", () => {
	const body = buildSearchRequestBody(
		{ search_query: [{ q: "latest Rust release" }], response_length: "short" },
		"gpt-5.6-luna",
		"session-7",
	);

	expect(body).toEqual({
		id: "session-7",
		model: "gpt-5.6-luna",
		commands: { search_query: [{ q: "latest Rust release" }], response_length: "short" },
		settings: { allowed_callers: ["direct"], external_web_access: true },
	});
});

test("exposes every web.run command family on web__run", () => {
	const tool = createWebRunTool();
	const properties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);

	expect(tool.name).toBe(WEB_RUN_TOOL_NAME);
	expect(properties).toEqual([
		"search_query",
		"image_query",
		"open",
		"click",
		"find",
		"screenshot",
		"finance",
		"weather",
		"sports",
		"time",
		"response_length",
	]);
});

test("refuses web__run on a model without native Codex web access", async () => {
	const tool = createWebRunTool();

	await expect(
		tool.execute("call-1", { search_query: [{ q: "x" }] } as never, undefined, undefined, {
			model: { provider: "openai", id: "gpt-5.5" },
		} as never),
	).rejects.toThrow("only available with openai-codex models");
});

test("refuses a web__run call carrying no command", async () => {
	const tool = createWebRunTool();

	await expect(
		tool.execute("call-2", {} as never, undefined, undefined, { model: codexModel } as never),
	).rejects.toThrow("needs at least one command");
});

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

async function pngFixtureDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "codex-image-gen-"));
	await writeFile(join(dir, "seed.png"), Buffer.from(onePixelPng, "base64"));
	return dir;
}

test("declares image_generation with a prompt and two reference channels", () => {
	const tool = createImageGenerationTool();
	const schema = tool.parameters as { properties: Record<string, unknown>; required: string[] };

	expect(Object.keys(schema.properties)).toEqual(["prompt", "referenced_image_paths", "num_last_images_to_include"]);
	expect(schema.required).toEqual(["prompt"]);
	// `prepareArguments: () => ({})` would drop the prompt the model just wrote.
	expect(tool.prepareArguments).toBeUndefined();
});

test("refuses image_generation on a model that cannot read images", async () => {
	const tool = createImageGenerationTool();

	await expect(
		tool.execute("call-1", { prompt: "a red cube" } as never, undefined, undefined, {
			model: { provider: "openai-codex", id: "gpt-5.5", input: ["text"] },
		} as never),
	).rejects.toThrow("openai-codex model that accepts image input");
});

test("refuses an image_generation call that names both reference channels", () => {
	expect(() =>
		readImageGenerationArgs({
			prompt: "a red cube",
			referenced_image_paths: ["a.png"],
			num_last_images_to_include: 2,
		}),
	).toThrow("referenced_image_paths or num_last_images_to_include");
});

test("accepts a bare prompt string from a cell", () => {
	expect(readImageGenerationArgs("a red cube")).toEqual({ prompt: "a red cube", referencedImagePaths: [] });
});

test("refuses an image_generation call with no prompt", () => {
	expect(() => readImageGenerationArgs({ referenced_image_paths: ["a.png"] })).toThrow("needs a prompt");
});

test("sends the prompt and every reference as one image_generation request", () => {
	const body = buildImageGenerationRequestBody("gpt-5.5", "a red cube", [
		{ data: "AAA", mimeType: "image/png", source: "/tmp/a.png" },
	]);

	expect(body.tools).toEqual([{ type: "image_generation", output_format: "png" }]);
	expect(body.stream).toBe(true);
	expect((body.input as Array<{ content: unknown[] }>)[0].content).toEqual([
		{ type: "input_text", text: "a red cube" },
		{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAA" },
	]);
});

test("names the file when a referenced image path is missing", async () => {
	const dir = await pngFixtureDir();

	await expect(loadReferencedImages(dir, ["absent.png"])).rejects.toThrow(join(dir, "absent.png"));
});

test("reads a referenced image relative to the workspace", async () => {
	const dir = await pngFixtureDir();

	const images = await loadReferencedImages(dir, ["seed.png"]);

	expect(images).toHaveLength(1);
	expect(images[0]?.mimeType).toBe("image/png");
	expect(images[0]?.source).toBe(join(dir, "seed.png"));
});

test("pulls the generated image out of the Codex event stream", async () => {
	async function* events() {
		yield { type: "response.created", response: { id: "resp_1" } };
		yield {
			type: "response.output_item.done",
			item: {
				type: "image_generation_call",
				id: "ig_1",
				result: onePixelPng,
				output_format: "png",
				revised_prompt: "a red cube on white",
			},
		};
	}

	const { image } = await extractGeneratedImage(events());

	expect(image).toEqual({
		callId: "ig_1",
		result: onePixelPng,
		responseId: "resp_1",
		outputFormat: "png",
		revisedPrompt: "a red cube on white",
	});
});

test("keeps the assistant text when Codex answers without an image", async () => {
	async function* events() {
		yield { type: "response.output_text.delta", delta: "I will not draw that." };
	}

	const { image, text } = await extractGeneratedImage(events());

	expect(image).toBeUndefined();
	expect(text).toBe("I will not draw that.");
});

test("reuses a session image through the artifact path a generated result carries", async () => {
	const dir = await pngFixtureDir();
	const artifactText = buildGeneratedImageArtifactResult([
		{
			absolutePath: join(dir, "seed.png"),
			relativePath: "seed.png",
			latestAbsolutePath: join(dir, "latest.png"),
			latestRelativePath: "latest.png",
			responseId: "resp_1",
			callId: "ig_1",
			outputFormat: "png",
			mimeType: "image/png",
			sha256: "abc",
		},
	]);
	const sessionManager = {
		getBranch: () => [
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: artifactText }] } },
		],
	};

	const images = await collectRecentSessionImages({ sessionManager } as never, 1);

	expect(images.map((image) => image.source)).toEqual([join(dir, "seed.png")]);
});
test("caps selected historical images at five", async () => {
	const entries = Array.from({ length: 8 }, (_, index) => ({
		type: "message",
		message: { role: "user", content: [{ type: "image", data: `image-${index}`, mimeType: "image/png" }] },
	}));
	const images = await collectRecentSessionImages({ sessionManager: { getBranch: () => entries } } as never, 8);
	expect(images).toHaveLength(5);
	expect(images.map((image) => image.data)).toEqual(["image-3", "image-4", "image-5", "image-6", "image-7"]);
});

test("refuses num_last_images_to_include when the session holds no image", async () => {
	await expect(collectRecentSessionImages({ sessionManager: { getBranch: () => [] } } as never, 2)).rejects.toThrow(
		"no earlier image",
	);
});

test("lets a cell call image_generation", () => {
	expect([...UNNESTABLE_TOOLS]).not.toContain("image_generation");
	expect([...UNNESTABLE_TOOLS]).toContain("web_search");
});
