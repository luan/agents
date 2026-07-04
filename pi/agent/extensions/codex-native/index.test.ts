import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCapabilities } from "@earendil-works/pi-tui";
import { activeCodexAppsToolNames, discoverCodexAppsTools } from "./codex-apps.ts";
import {
	isCodexWebSocketError,
	normalizeCodexWebSocketError as normalizeCodexWebSocketErrorMessage,
	normalizeLegacyFunctionCallIds,
} from "./index.ts";
import {
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
import { convertResponsesMessages } from "./openai-responses-shared.ts";

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

test("does not enable native image_generation for gpt-5.4-mini", () => {
	expect(supportsNativeImageGeneration(codexMiniModel as never)).toBe(false);
	expect(supportsNativeImageGeneration(codexModel as never)).toBe(true);

	const payload = {
		model: "gpt-5.4-mini",
		input: [],
		tools: [{ type: "function", name: "image_generation", parameters: {} }],
	};

	expect(rewriteNativeImageGenerationTool(payload, codexMiniModel as never)).toEqual(payload);
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
	expect(await readFile(saved.absolutePath, "utf8")).toBe("fake-png");
	expect(await readFile(getOpenAICodexLatestImagePath(root), "utf8")).toBe("fake-png");
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
		expect(rendered).toContain("width=80");
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
						name: "slack_slack_read_channel",
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
