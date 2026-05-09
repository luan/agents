import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CODEX_APPS_TOOL_PREFIX = "codex_apps_";
const DEFAULT_CODEX_APPS_MCP_URL = "https://chatgpt.com/backend-api/codex/apps";
const CODEX_APPS_CONFIG_PATH = join(homedir(), ".pi", "agent", "codex-tools.json");
const CODEX_APPS_CACHE_DIR = join(homedir(), ".codex", "cache", "codex_apps_tools");
const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");

type CodexAppsConfig = {
	enabled: boolean;
	endpointUrl?: string;
	enabledToolKeys?: string[];
	defaultEnableReadOnly?: boolean;
};

type CodexAppsCachedTool = {
	server_name?: string;
	tool_name?: string;
	tool_namespace?: string;
	server_instructions?: string | null;
	tool?: {
		name?: string;
		title?: string;
		description?: string;
		inputSchema?: unknown;
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			openWorldHint?: boolean;
		};
		_meta?: {
			resource_name?: string;
			connector_id?: string;
			connector_name?: string;
			connector_description?: string;
			link_id?: string;
			_codex_apps?: {
				resource_uri?: string;
				contains_mcp_source?: boolean;
			};
		};
	};
	connector_id?: string;
	connector_name?: string;
	connector_description?: string;
};

export type CodexAppsToolRecord = {
	key: string;
	piToolName: string;
	mcpToolName: string;
	title: string;
	description: string;
	inputSchema: unknown;
	connectorId: string;
	connectorName: string;
	connectorDescription: string;
	readOnly: boolean;
	destructive: boolean;
	openWorld: boolean;
	resourceUri?: string;
};

type CodexAuth = {
	tokens?: {
		access_token?: string;
		account_id?: string;
	};
};

const defaultConfig: CodexAppsConfig = {
	enabled: true,
	defaultEnableReadOnly: true,
	enabledToolKeys: undefined,
};

function shortHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function safeToolName(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 56);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function readJsonFileSync<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function loadConfig(): Promise<CodexAppsConfig> {
	return { ...defaultConfig, ...((await readJsonFile<CodexAppsConfig>(CODEX_APPS_CONFIG_PATH)) ?? {}) };
}

async function saveConfig(config: CodexAppsConfig): Promise<void> {
	await mkdir(dirname(CODEX_APPS_CONFIG_PATH), { recursive: true });
	await writeFile(CODEX_APPS_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function toolKey(tool: CodexAppsCachedTool): string | undefined {
	const name = tool.tool?.name;
	if (!name) return undefined;
	const connectorId =
		tool.tool?._meta?.connector_id ?? tool.connector_id ?? tool.tool?._meta?.connector_name ?? "unknown";
	const linkId = tool.tool?._meta?.link_id;
	return [connectorId, linkId, name].filter(Boolean).join(":");
}

function normalizeCachedTool(tool: CodexAppsCachedTool, usedPiNames: Set<string>): CodexAppsToolRecord | undefined {
	const mcpToolName = tool.tool?.name;
	const key = toolKey(tool);
	if (!mcpToolName || !key) return undefined;
	const connectorName = tool.tool?._meta?.connector_name ?? tool.connector_name ?? "Codex App";
	const connectorId = tool.tool?._meta?.connector_id ?? tool.connector_id ?? connectorName;
	const description = tool.tool?.description ?? `Call ${mcpToolName} from ${connectorName}.`;
	const baseName = `${CODEX_APPS_TOOL_PREFIX}${safeToolName(mcpToolName)}`;
	const piToolName = usedPiNames.has(baseName) ? `${baseName}_${shortHash(key)}` : baseName;
	usedPiNames.add(piToolName);
	const annotations = tool.tool?.annotations ?? {};

	return {
		key,
		piToolName,
		mcpToolName,
		title: tool.tool?.title ?? mcpToolName,
		description,
		inputSchema: tool.tool?.inputSchema ?? { type: "object", additionalProperties: true },
		connectorId,
		connectorName,
		connectorDescription: tool.tool?._meta?.connector_description ?? tool.connector_description ?? "",
		readOnly: annotations.readOnlyHint === true,
		destructive: annotations.destructiveHint === true,
		openWorld: annotations.openWorldHint === true,
		resourceUri: tool.tool?._meta?._codex_apps?.resource_uri,
	};
}

export async function discoverCodexAppsTools(cacheDir = CODEX_APPS_CACHE_DIR): Promise<CodexAppsToolRecord[]> {
	let files: string[];
	try {
		files = await readdir(cacheDir);
	} catch {
		return [];
	}
	const usedPiNames = new Set<string>();
	const byKey = new Map<string, CodexAppsToolRecord>();
	for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
		const parsed = await readJsonFile<{ tools?: CodexAppsCachedTool[] }>(join(cacheDir, file));
		for (const cachedTool of parsed?.tools ?? []) {
			const record = normalizeCachedTool(cachedTool, usedPiNames);
			if (record && !byKey.has(record.key)) byKey.set(record.key, record);
		}
	}
	return [...byKey.values()].sort((left, right) =>
		`${left.connectorName}:${left.title}`.localeCompare(`${right.connectorName}:${right.title}`),
	);
}

export async function fetchCodexAppsToolsFromMcp(
	config: CodexAppsConfig,
	signal?: AbortSignal,
): Promise<CodexAppsToolRecord[]> {
	const endpointUrl = process.env.CODEX_APPS_MCP_URL ?? config.endpointUrl ?? DEFAULT_CODEX_APPS_MCP_URL;
	const headers = codexAppsHeaders(readJsonFileSync<CodexAuth>(CODEX_AUTH_PATH) ?? {});
	await postJsonRpc(
		endpointUrl,
		headers,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "codex", version: "0.128.0" },
			},
		},
		signal,
	);
	const listed = await postJsonRpc(
		endpointUrl,
		headers,
		{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
		signal,
	);
	const result = isRecord(listed.json) && isRecord(listed.json.result) ? listed.json.result : {};
	const usedPiNames = new Set<string>();
	return (Array.isArray(result.tools) ? result.tools : [])
		.map((tool) => normalizeCachedTool({ tool: tool as CodexAppsCachedTool["tool"] }, usedPiNames))
		.filter((tool): tool is CodexAppsToolRecord => Boolean(tool))
		.sort((left, right) =>
			`${left.connectorName}:${left.title}`.localeCompare(`${right.connectorName}:${right.title}`),
		);
}

export function activeCodexAppsToolNames(
	tools: CodexAppsToolRecord[],
	config: CodexAppsConfig,
	activeToolNames: string[],
): string[] {
	const existing = activeToolNames.filter((name) => !name.startsWith(CODEX_APPS_TOOL_PREFIX));
	if (!config.enabled) return existing;
	const explicit = config.enabledToolKeys ? new Set(config.enabledToolKeys) : undefined;
	const enabled = tools.filter((tool) =>
		explicit ? explicit.has(tool.key) : config.defaultEnableReadOnly !== false && tool.readOnly,
	);
	return [...existing, ...enabled.map((tool) => tool.piToolName)];
}

function codexAppsHeaders(auth: CodexAuth): Record<string, string> {
	const accessToken = auth.tokens?.access_token;
	if (!accessToken) throw new Error(`Codex ChatGPT auth not found in ${CODEX_AUTH_PATH}; run codex login`);
	const headers: Record<string, string> = {
		authorization: `Bearer ${accessToken}`,
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
		"openai-beta": "responses=experimental",
		originator: "codex_cli_rs",
		"user-agent": `codex_cli_rs/0.128.0 (${process.platform}; ${process.arch}) pi-codex-apps/0`,
	};
	if (auth.tokens?.account_id) headers["chatgpt-account-id"] = auth.tokens.account_id;
	return headers;
}

async function postJsonRpc(
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	sessionId?: string,
): Promise<{ json: unknown; sessionId?: string }> {
	const requestHeaders = sessionId ? { ...headers, "mcp-session-id": sessionId } : headers;
	const response = await postWithNodeHttps(url, requestHeaders, JSON.stringify(body), signal);
	const text = response.body;
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Codex Apps MCP request failed (${response.status}): ${text.slice(0, 300)}`);
	}
	const contentType = response.headers["content-type"] ?? "";
	const responseSessionId = response.headers["mcp-session-id"] ?? sessionId;
	if (contentType.includes("text/event-stream")) {
		const dataLines = text
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim())
			.filter((line) => line && line !== "[DONE]");
		const last = dataLines.at(-1);
		return { json: last ? JSON.parse(last) : undefined, sessionId: responseSessionId };
	}
	return { json: text ? JSON.parse(text) : undefined, sessionId: responseSessionId };
}

async function postWithNodeHttps(
	url: string,
	headers: Record<string, string>,
	body: string,
	signal?: AbortSignal,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
	return await new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const request = httpsRequest(
			{
				protocol: parsed.protocol,
				hostname: parsed.hostname,
				port: parsed.port || undefined,
				path: `${parsed.pathname}${parsed.search}`,
				method: "POST",
				headers: {
					...headers,
					"content-length": Buffer.byteLength(body),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
				response.on("end", () => {
					const normalizedHeaders: Record<string, string> = {};
					for (const [key, value] of Object.entries(response.headers)) {
						if (typeof value === "string") normalizedHeaders[key.toLowerCase()] = value;
						else if (Array.isArray(value)) normalizedHeaders[key.toLowerCase()] = value.join(", ");
					}
					resolve({
						status: response.statusCode ?? 0,
						headers: normalizedHeaders,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		const abort = () => {
			request.destroy(new Error("Codex Apps MCP request aborted"));
		};
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });
		request.on("error", reject);
		request.on("close", () => signal?.removeEventListener("abort", abort));
		request.end(body);
	});
}

function mcpResultToText(value: unknown): string {
	const result = isRecord(value) && isRecord(value.result) ? value.result : value;
	if (isRecord(result)) {
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content
			.map((item) =>
				isRecord(item) && typeof item.text === "string" ? codexAppTextContentToText(item.text) : undefined,
			)
			.filter((item): item is string => Boolean(item))
			.join("\n");
		if (text) return text;
		if ("structuredContent" in result) return structuredContentToText(result.structuredContent);
	}
	return JSON.stringify(result, null, 2);
}

function codexAppTextContentToText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
	try {
		return structuredContentToText(JSON.parse(trimmed));
	} catch {
		return text;
	}
}

function structuredContentToText(value: unknown): string {
	if (!isRecord(value)) return JSON.stringify(value, null, 2);
	const primaryKeys = ["messages", "message", "content", "text", "markdown"];
	for (const key of primaryKeys) {
		if (typeof value[key] === "string" && value[key].trim().length > 0) {
			const footer = typeof value.pagination_info === "string" ? `\n\n${value.pagination_info}` : "";
			return `${value[key]}${footer}`;
		}
	}

	const textPairs = Object.entries(value).filter(
		([, entryValue]) => typeof entryValue === "string" && entryValue.trim().length > 0,
	);
	if (textPairs.length > 0 && textPairs.length <= 4) {
		return textPairs.map(([key, entryValue]) => `${humanizeIdentifier(key)}:\n${entryValue}`).join("\n\n");
	}

	return JSON.stringify(value, null, 2);
}

async function callCodexAppsTool(
	tool: CodexAppsToolRecord,
	params: Record<string, unknown>,
	config: CodexAppsConfig,
	signal?: AbortSignal,
): Promise<unknown> {
	const endpointUrl = process.env.CODEX_APPS_MCP_URL ?? config.endpointUrl ?? DEFAULT_CODEX_APPS_MCP_URL;
	const headers = codexAppsHeaders(readJsonFileSync<CodexAuth>(CODEX_AUTH_PATH) ?? {});
	const initialized = await postJsonRpc(
		endpointUrl,
		headers,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "pi-codex-apps", version: "0" },
			},
		},
		signal,
	);
	if (initialized.sessionId) {
		await postJsonRpc(
			endpointUrl,
			headers,
			{ jsonrpc: "2.0", method: "notifications/initialized", params: {} },
			signal,
			initialized.sessionId,
		);
	}
	return (
		await postJsonRpc(
			endpointUrl,
			headers,
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: tool.mcpToolName, arguments: params },
			},
			signal,
			initialized.sessionId,
		)
	).json;
}

function createToolDefinition(tool: CodexAppsToolRecord, getConfig: () => CodexAppsConfig): ToolDefinition<any> {
	return {
		name: tool.piToolName,
		label: tool.title,
		renderShell: "self",
		description: `${tool.description}\n\nCodex app: ${tool.connectorName}.`,
		promptSnippet: `Call ${tool.title} from the Codex ${tool.connectorName} app.`,
		promptGuidelines: [
			`Use ${tool.piToolName} only when the user asks for information or actions that require the ${tool.connectorName} Codex app.`,
		],
		parameters: Type.Unsafe(tool.inputSchema as Record<string, unknown>),
		async execute(_toolCallId, params, signal) {
			const result = await callCodexAppsTool(tool, params, getConfig(), signal);
			return {
				content: [{ type: "text", text: mcpResultToText(result) }],
				details: { tool, params, result },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(renderCodexAppCall(tool, args, theme, context?.isPartial !== false, context?.isError === true));
			return text;
		},
		renderResult(result, { expanded }, theme, context) {
			const textComponent = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (context?.isPartial) return textComponent;
			const output = codexAppTextContentToText(result.content.find((item) => item.type === "text")?.text ?? "");
			const details = isRecord(result.details) ? result.details : {};
			const params = isRecord(details.params) ? details.params : {};
			textComponent.setText(
				`${renderCodexAppCall(tool, params, theme, false, context?.isError === true)}\n${renderCodexAppResult(output, theme, { expanded })}`,
			);
			return textComponent;
		},
	};
}

function renderCodexAppCall(
	tool: CodexAppsToolRecord,
	args: Record<string, unknown>,
	theme: Theme,
	running: boolean,
	failed: boolean,
): string {
	const status = theme.fg(running ? "dim" : failed ? "error" : "success", "•");
	const verb = running ? "Using" : "Used";
	const action = codexAppActionLabel(tool);
	const summary = summarizeCodexAppArgs(args);
	const suffix = summary ? `${theme.fg("dim", " · ")}${theme.fg("muted", summary)}` : "";
	return `${status} ${theme.bold(verb)} ${renderConnectorName(tool.connectorName, theme)} ${theme.fg("accent", action)}${suffix}`;
}

function renderConnectorName(connectorName: string, theme: Theme): string {
	if (connectorName.toLowerCase() !== "slack") return connectorName;
	return theme.bold(
		`${theme.fg("warning", " ")}${theme.fg("mdLink", "S")}${theme.fg("success", "l")}${theme.fg("warning", "a")}${theme.fg("error", "c")}${theme.fg("toolTitle", "k")}`,
	);
}

function renderCodexAppResult(text: string, theme: Theme, options: { expanded?: boolean }): string {
	const lines = limitCodexAppResultLines(text.split("\n"), options.expanded);
	return lines
		.flatMap((line) => wrapTextWithAnsi(line, 120))
		.map((line, index, allLines) => {
			const prefix = index === allLines.length - 1 ? "  └ " : index === 0 ? "  ├ " : "  │ ";
			return `${theme.fg("dim", prefix)}${theme.fg("dim", truncateToWidth(line || " ", 120, "…"))}`;
		})
		.join("\n");
}

function limitCodexAppResultLines(lines: string[], expanded: boolean | undefined): string[] {
	if (expanded || lines.length <= 8) return lines;
	const head = lines.slice(0, 4);
	const tail = lines.slice(-3);
	return [...head, `… +${lines.length - head.length - tail.length} lines`, ...tail];
}

function codexAppActionLabel(tool: CodexAppsToolRecord): string {
	const connectorPrefix = safeToolName(tool.connectorName).toLowerCase();
	let title = tool.title || tool.mcpToolName;
	const lower = title.toLowerCase();
	if (lower.startsWith(`${connectorPrefix}_`)) title = title.slice(connectorPrefix.length + 1);
	if (lower.startsWith(`${connectorPrefix} `)) title = title.slice(connectorPrefix.length + 1);
	return humanizeIdentifier(title);
}

function summarizeCodexAppArgs(args: Record<string, unknown>): string {
	const preferred = [
		"channel_id",
		"message_ts",
		"query",
		"repo_full_name",
		"pr_number",
		"issue_number",
		"path",
		"ref",
		"id",
	];
	const parts: string[] = [];
	for (const key of preferred) {
		if (key in args) parts.push(formatArgValue(key, args[key]));
		if (parts.length >= 3) break;
	}
	if (parts.length === 0) {
		for (const [key, value] of Object.entries(args)) {
			if (parts.length >= 3) break;
			if (value === undefined || value === null || typeof value === "object") continue;
			parts.push(formatArgValue(key, value));
		}
	}
	return parts.filter(Boolean).join(" ");
}

function formatArgValue(key: string, value: unknown): string {
	if (value === undefined || value === null) return "";
	const label = key.endsWith("_id") ? "" : `${humanizeIdentifier(key)} `;
	const raw = typeof value === "string" ? value : String(value);
	return `${label}${truncateToWidth(raw.replace(/\s+/g, " "), 80, "…")}`.trim();
}

function humanizeIdentifier(value: string): string {
	const words = value
		.replace(/^_+/, "")
		.replace(/[_-]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
	return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

function codexToolsStatus(tools: CodexAppsToolRecord[], config: CodexAppsConfig): string {
	const active = activeCodexAppsToolNames(tools, config, []).length;
	return `${active}/${tools.length} Codex app tools`;
}

async function showCodexToolsPanel(
	ctx: ExtensionContext & { reload?: () => Promise<void> },
	tools: CodexAppsToolRecord[],
	config: CodexAppsConfig,
	onConfig: (config: CodexAppsConfig) => Promise<void>,
): Promise<void> {
	const enabled = new Set(
		config.enabledToolKeys ??
			tools.filter((tool) => config.defaultEnableReadOnly !== false && tool.readOnly).map((tool) => tool.key),
	);
	const items: SettingItem[] = [
		{
			id: "__bridge__",
			label: "Codex Apps bridge",
			currentValue: config.enabled ? "on" : "off",
			values: ["on", "off"],
		},
		...tools.map((tool) => ({
			id: tool.key,
			label: `${tool.connectorName}: ${tool.title}`,
			currentValue: enabled.has(tool.key) ? "on" : "off",
			values: ["on", "off"],
			description: [tool.readOnly ? "read-only" : "write", tool.destructive ? "destructive" : undefined]
				.filter(Boolean)
				.join(", "),
		})),
	];

	await ctx.ui.custom((_tui, theme: Theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Codex Tools")), 1, 0));
		container.addChild(
			new Text(
				theme.fg("dim", "Toggle tools exposed from ChatGPT/Codex Apps. /codex-tools reload refreshes discovery."),
				1,
				0,
			),
		);
		const settings = new SettingsList(
			items,
			Math.min(Math.max(items.length, 4), 22),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "__bridge__") {
					config.enabled = newValue === "on";
				} else if (newValue === "on") {
					enabled.add(id);
				} else {
					enabled.delete(id);
				}
				config.enabledToolKeys = [...enabled];
				void onConfig(config);
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(settings);
		container.addChild(
			new Text(
				theme.fg("dim", "search/type • enter/space toggle • esc close • /codex-tools reload refreshes"),
				1,
				0,
			),
		);
		return {
			render: (width: number) => container.render(width),
			handleInput: (data: string) => settings.handleInput?.(data),
			invalidate: () => container.invalidate(),
		};
	});
}

export default async function registerCodexAppsBridge(pi: ExtensionAPI) {
	let config = await loadConfig();
	let tools = await discoverCodexAppsTools();
	const registeredKeys = new Set<string>();

	const registerDiscoveredTools = (nextTools: CodexAppsToolRecord[]) => {
		for (const tool of nextTools) {
			if (registeredKeys.has(tool.key)) continue;
			registeredKeys.add(tool.key);
			pi.registerTool(createToolDefinition(tool, () => config));
		}
	};

	registerDiscoveredTools(tools);

	const applyActiveTools = (ctx?: ExtensionContext) => {
		const active = pi.getActiveTools();
		const next = activeCodexAppsToolNames(tools, config, active);
		if (active.length !== next.length || active.some((name, index) => name !== next[index])) pi.setActiveTools(next);
		if (ctx) ctx.ui.setStatus("codex-tools", ctx.ui.theme.fg("dim", codexToolsStatus(tools, config)));
	};

	const persistAndApply = async (nextConfig: CodexAppsConfig) => {
		config = { ...nextConfig };
		await saveConfig(config);
		applyActiveTools();
	};

	pi.registerCommand("codex-tools", {
		description: "Configure Codex app tools exposed through the Codex native bridge",
		handler: async (args, ctx) => {
			if (args.trim() === "reload") {
				try {
					tools = await fetchCodexAppsToolsFromMcp(config, ctx.signal);
					registerDiscoveredTools(tools);
					ctx.ui.notify(`Fetched ${tools.length} Codex app tools from ChatGPT.`, "info");
				} catch (error) {
					tools = await discoverCodexAppsTools();
					registerDiscoveredTools(tools);
					ctx.ui.notify(
						`Live fetch failed; loaded ${tools.length} cached Codex app tools: ${
							error instanceof Error ? error.message : String(error)
						}`,
						"warning",
					);
				}
				applyActiveTools(ctx);
				return;
			}
			await showCodexToolsPanel(ctx, tools, { ...config }, persistAndApply);
			applyActiveTools(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => applyActiveTools(ctx));
	pi.on("resources_discover", (_event, ctx) => applyActiveTools(ctx));
	pi.on("model_select", (_event, ctx) => applyActiveTools(ctx));
}
