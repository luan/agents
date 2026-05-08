import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeCodexAppsToolNames, discoverCodexAppsTools } from "./codex-apps.ts";
import { isCodexWebSocketError, normalizeCodexWebSocketError as normalizeCodexWebSocketErrorMessage } from "./index.ts";
import {
	getOpenAICodexLatestImagePath,
	rewriteNativeImageGenerationTool,
	rewriteNativeWebSearchTool,
	saveOpenAICodexGeneratedImage,
} from "./native-tools.ts";

const codexModel = {
	provider: "openai-codex",
	id: "gpt-5.5",
	input: ["text", "image"],
};

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
