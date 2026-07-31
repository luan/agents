import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { defineExtensionTui, textComponent, truncateToWidthCompat } from "../shared/tui";
import { CodexAppServerMcpClient } from "./app-server-mcp";
import { discoverLocalMcpServers, findCodexCliPath, LocalMcpClient, type LocalMcpTool } from "./local-mcp";
import { isCodexPluginEnabled, isCodexPluginInstalled, setCodexPluginAliases } from "./plugin-aliases";

type McpClient = LocalMcpClient | CodexAppServerMcpClient;

const CODEX_APPS_TOOL_PREFIX = "codex_apps_";
const codexAppsTui = defineExtensionTui({ id: "codex-tools" });
const DEFAULT_CODEX_APPS_MCP_URL = "https://chatgpt.com/backend-api/codex/apps";
const CODEX_APPS_CONFIG_PATH = join(homedir(), ".pi", "agent", "codex-tools.json");
const CODEX_APPS_CACHE_DIR = join(homedir(), ".codex", "cache", "codex_apps_tools");
const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CODEX_NATIVE_SKILL_RESOURCES = join(dirname(fileURLToPath(import.meta.url)), "skill-resources");

type CodexAppsConfig = {
	enabled: boolean;
	endpointUrl?: string;
	enabledToolKeys?: string[];
	defaultEnableReadOnly?: boolean;
	disabledPluginKeys?: string[];
	hiddenSkillNames?: string[];
	surfaceVersion?: number;
};

const CODEX_APPS_SURFACE_VERSION = 1;

type CodexPluginManifest = {
	name?: string;
	version?: string;
	skills?: string | string[];
	apps?: string | { apps?: Record<string, { id?: string }> };
};

type CodexPluginAppManifest = {
	apps?: Record<string, { id?: string; required?: boolean }>;
};

export type CodexPluginRecord = {
	key: string;
	name: string;
	version: string;
	marketplace: string;
	rootPath: string;
	skillPaths: string[];
	connectorIds: string[];
};

export type CodexAppRecord = {
	connectorId: string;
	connectorName: string;
	connectorDescription: string;
	toolKeys: string[];
	pluginKey?: string;
};

export type CodexSkillRecord = {
	name: string;
	filePath: string;
	pluginKey: string;
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
	localServer?: string;
	defaultEnabled?: boolean;
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

function codexHome(): string {
	return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function pluginVersionRank(version: string): string {
	return version.replace(/[^0-9.]/g, ".");
}

async function findInstalledCodexPluginRoots(root = codexHome()): Promise<string[]> {
	const marketplaceRoot = join(root, "plugins", "cache");
	const candidates: Array<{ path: string; marketplace: string; name: string; version: string }> = [];
	let marketplaces: string[] = [];
	try {
		marketplaces = await readdir(marketplaceRoot);
	} catch {}

	for (const marketplace of marketplaces) {
		let pluginNames: string[];
		try {
			pluginNames = await readdir(join(marketplaceRoot, marketplace));
		} catch {
			continue;
		}
		for (const name of pluginNames) {
			const pluginRoot = join(marketplaceRoot, marketplace, name);
			let versions: string[];
			try {
				versions = await readdir(pluginRoot);
			} catch {
				continue;
			}
			for (const version of versions) {
				const manifestPath = join(pluginRoot, version, ".codex-plugin", "plugin.json");
				const manifest = await readJsonFile<CodexPluginManifest>(manifestPath);
				if (!manifest?.name) continue;
				if (!isCodexPluginInstalled(manifest.name, marketplace, join(pluginRoot, version), root)) continue;
				candidates.push({
					path: join(pluginRoot, version),
					marketplace,
					name: manifest.name,
					version: manifest.version ?? version,
				});
			}
		}
	}
	await addFlatPluginRoots(join(root, ".tmp", "plugins", "plugins"), "tmp", candidates, root);
	await addFlatPluginRoots(
		join(root, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins"),
		"openai-bundled",
		candidates,
		root,
	);

	return candidates
		.sort(
			(left, right) =>
				pluginVersionRank(right.version).localeCompare(pluginVersionRank(left.version), undefined, {
					numeric: true,
				}) || right.marketplace.localeCompare(left.marketplace),
		)
		.filter((candidate, index, all) => all.findIndex((other) => other.name === candidate.name) === index)
		.map((candidate) => candidate.path);
}

async function addFlatPluginRoots(
	pluginsRoot: string,
	marketplace: string,
	candidates: Array<{ path: string; marketplace: string; name: string; version: string }>,
	root: string,
): Promise<void> {
	let pluginNames: string[];
	try {
		pluginNames = await readdir(pluginsRoot);
	} catch {
		return;
	}

	for (const name of pluginNames) {
		const pluginRoot = join(pluginsRoot, name);
		const manifest = await readJsonFile<CodexPluginManifest>(join(pluginRoot, ".codex-plugin", "plugin.json"));
		if (!manifest?.name) continue;
		if (!isCodexPluginInstalled(manifest.name, marketplace, pluginRoot, root)) continue;
		candidates.push({
			path: pluginRoot,
			marketplace,
			name: manifest.name,
			version: manifest.version ?? "0.0.0",
		});
	}
}

export async function discoverCodexPlugins(root = codexHome()): Promise<CodexPluginRecord[]> {
	const pluginRoots = await findInstalledCodexPluginRoots(root);
	const plugins: CodexPluginRecord[] = [];
	for (const pluginRoot of pluginRoots) {
		const manifest = await readJsonFile<CodexPluginManifest>(join(pluginRoot, ".codex-plugin", "plugin.json"));
		if (!manifest?.name) continue;
		const appManifest =
			typeof manifest.apps === "string"
				? await readJsonFile<CodexPluginAppManifest>(join(pluginRoot, manifest.apps))
				: manifest.apps;
		const connectorIds = Object.values(appManifest?.apps ?? {})
			.map((app) => app.id)
			.filter((id): id is string => Boolean(id));
		const declaredSkillPaths = manifest.skills
			? (Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills]).map((path) => join(pluginRoot, path))
			: [join(pluginRoot, "skills")];
		const skillPaths = (await Promise.all(declaredSkillPaths.map((path) => directoryIfExists(path)))).filter(
			(path): path is string => Boolean(path),
		);
		const marketplace = pluginMarketplace(pluginRoot);
		const version = manifest.version ?? basename(pluginRoot);
		plugins.push({
			key: manifest.name,
			name: manifest.name,
			version,
			marketplace,
			rootPath: pluginRoot,
			skillPaths,
			connectorIds,
		});
	}
	return plugins.sort((left, right) => left.name.localeCompare(right.name));
}

async function directoryIfExists(path: string): Promise<string | undefined> {
	try {
		return (await stat(path)).isDirectory() ? path : undefined;
	} catch {
		return undefined;
	}
}

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

function normalizeMcpToolName(value: string): string {
	return value.replaceAll(".", "_");
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
	const name = tool.tool?.name ? normalizeMcpToolName(tool.tool.name) : undefined;
	if (!name) return undefined;
	const connectorId =
		tool.tool?._meta?.connector_id ?? tool.connector_id ?? tool.tool?._meta?.connector_name ?? "unknown";
	const linkId = tool.tool?._meta?.link_id;
	return [connectorId, linkId, name].filter(Boolean).join(":");
}

function normalizeCachedTool(tool: CodexAppsCachedTool, usedPiNames: Set<string>): CodexAppsToolRecord | undefined {
	const mcpToolName = tool.tool?.name ? normalizeMcpToolName(tool.tool.name) : undefined;
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

export async function discoverNodeReplTools(): Promise<
	{ client: CodexAppServerMcpClient; tools: CodexAppsToolRecord[] } | undefined
> {
	const command = await findCodexCliPath();
	if (!command) return undefined;
	const client = new CodexAppServerMcpClient("node_repl", {
		command,
		args: ["-c", "features.code_mode_host=true", "app-server", "--stdio"],
		cwd: process.cwd(),
		env: { CODEX_HOME: codexHome() },
	});
	try {
		const tools = await client.listTools();
		return { client, tools: tools.map(normalizeNodeReplTool) };
	} catch {
		client.close();
		return undefined;
	}
}

export async function discoverPluginMcpTools(
	plugins: CodexPluginRecord[],
): Promise<Array<{ client: LocalMcpClient; serverKey: string; tools: CodexAppsToolRecord[] }>> {
	const surfaces: Array<{ client: LocalMcpClient; serverKey: string; tools: CodexAppsToolRecord[] }> = [];
	for (const plugin of plugins) {
		if (plugin.key === "computer-use") continue;
		for (const server of await discoverLocalMcpServers(plugin.rootPath)) {
			const client = new LocalMcpClient(server.config);
			try {
				const tools = await client.listTools();
				const serverKey = `${plugin.key}:${server.name}`;
				surfaces.push({
					client,
					serverKey,
					tools: tools.map((tool) => normalizePluginMcpTool(plugin, serverKey, tool)),
				});
			} catch {
				client.close();
			}
		}
	}
	return surfaces;
}

function normalizeNodeReplTool(tool: LocalMcpTool): CodexAppsToolRecord {
	const isJavaScript = tool.name === "js";
	return {
		key: `computer-use:${tool.name}`,
		piToolName: isJavaScript ? "node_repl" : `node_repl_${safeToolName(tool.name)}`,
		mcpToolName: tool.name,
		title: isJavaScript ? "Run JavaScript" : humanizeIdentifier(tool.name),
		description: tool.description ?? `Call ${tool.name} on the Codex Node REPL server.`,
		inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
		connectorId: "computer-use",
		connectorName: "Computer Use",
		connectorDescription: "Control Mac apps through the Codex Computer Use runtime",
		readOnly: tool.annotations?.readOnlyHint === true,
		destructive: tool.annotations?.destructiveHint === true,
		openWorld: tool.annotations?.openWorldHint !== false,
		localServer: "node_repl",
		defaultEnabled: true,
	};
}

function normalizePluginMcpTool(plugin: CodexPluginRecord, serverKey: string, tool: LocalMcpTool): CodexAppsToolRecord {
	return {
		key: `${serverKey}:${tool.name}`,
		piToolName: `${safeToolName(plugin.name)}_${safeToolName(tool.name)}`,
		mcpToolName: tool.name,
		title: tool.name,
		description: tool.description ?? `Call ${tool.name} from the ${plugin.name} plugin.`,
		inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
		connectorId: plugin.name,
		connectorName: humanizeIdentifier(plugin.name),
		connectorDescription: `Tools provided by the ${humanizeIdentifier(plugin.name)} plugin`,
		readOnly: tool.annotations?.readOnlyHint === true,
		destructive: tool.annotations?.destructiveHint === true,
		openWorld: tool.annotations?.openWorldHint !== false,
		localServer: serverKey,
		defaultEnabled: true,
	};
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

export function buildCodexAppRecords(tools: CodexAppsToolRecord[], plugins: CodexPluginRecord[]): CodexAppRecord[] {
	const pluginByConnectorId = new Map<string, string>();
	for (const plugin of plugins) {
		pluginByConnectorId.set(plugin.name, plugin.key);
		for (const connectorId of plugin.connectorIds) pluginByConnectorId.set(connectorId, plugin.key);
	}

	const apps = new Map<string, CodexAppRecord>();
	for (const tool of tools) {
		const app = apps.get(tool.connectorId) ?? {
			connectorId: tool.connectorId,
			connectorName: tool.connectorName,
			connectorDescription: tool.connectorDescription,
			toolKeys: [],
			pluginKey: pluginByConnectorId.get(tool.connectorId),
		};
		app.toolKeys.push(tool.key);
		apps.set(tool.connectorId, app);
	}
	return [...apps.values()].sort((left, right) => left.connectorName.localeCompare(right.connectorName));
}

export function pluginSkillPaths(
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
	tools: CodexAppsToolRecord[] = [],
): string[] {
	const disabled = new Set(config.disabledPluginKeys ?? []);
	return plugins
		.filter((plugin) => !disabled.has(plugin.key))
		.filter((plugin) =>
			isCodexPluginEnabled(
				plugin.name,
				plugin.marketplace,
				plugin.rootPath,
				pluginAppEnabled(plugin, config, tools, disabledCodexAppToolKeys(tools, plugins, config)),
			),
		)
		.flatMap((plugin) =>
			plugin.key === "computer-use" ? [join(CODEX_NATIVE_SKILL_RESOURCES, "computer-use")] : plugin.skillPaths,
		);
}

function syncCodexPluginAliases(
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
	tools: CodexAppsToolRecord[],
): void {
	const disabledToolKeys = disabledCodexAppToolKeys(tools, plugins, config);
	setCodexPluginAliases(
		plugins
			.filter((plugin) => pluginEnabled(plugin, config))
			.filter((plugin) => {
				const appEnabled = pluginAppEnabled(plugin, config, tools, disabledToolKeys);
				return isCodexPluginEnabled(plugin.name, plugin.marketplace, plugin.rootPath, appEnabled);
			})
			.map((plugin) => plugin.name),
	);
}

export function discoverCodexSkills(
	pi: ExtensionAPI,
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
	tools: CodexAppsToolRecord[],
): CodexSkillRecord[] {
	const pluginRoots = plugins.map((plugin) => ({
		plugin,
		roots: pluginSkillPaths([plugin], config, tools).map((root) => root.replaceAll("\\", "/")),
	}));
	const skills: CodexSkillRecord[] = [];
	for (const command of pi.getCommands()) {
		if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
		const filePath = command.sourceInfo?.path;
		if (!filePath) continue;
		const normalizedPath = filePath.replaceAll("\\", "/");
		const plugin = pluginRoots.find(({ roots }) =>
			roots.some((root) => normalizedPath === root || normalizedPath.startsWith(`${root}/`)),
		);
		if (!plugin || skills.some((skill) => skill.name === command.name.slice("skill:".length))) continue;
		skills.push({
			name: command.name.slice("skill:".length),
			filePath,
			pluginKey: plugin.plugin.key,
		});
	}
	return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function pluginAppEnabled(
	plugin: CodexPluginRecord,
	config: CodexAppsConfig,
	tools: CodexAppsToolRecord[],
	disabledToolKeys: ReadonlySet<string>,
): boolean {
	return plugin.connectorIds.some((connectorId) =>
		tools.some((tool) => tool.connectorId === connectorId && isCodexToolEnabled(tool, config, disabledToolKeys)),
	);
}

function pluginMarketplace(pluginRoot: string): string {
	const bundled = pluginRoot.match(/\/\.tmp\/bundled-marketplaces\/([^/]+)\/plugins\//);
	if (bundled?.[1]) return bundled[1];
	if (pluginRoot.includes("/.tmp/plugins/plugins/")) return "tmp";
	return basename(dirname(dirname(pluginRoot)));
}

export function disabledCodexAppToolKeys(
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
): Set<string> {
	const disabledPlugins = new Set(config.disabledPluginKeys ?? []);
	const disabledConnectors = new Set(
		plugins
			.filter((plugin) => disabledPlugins.has(plugin.key))
			.flatMap((plugin) => [plugin.name, ...plugin.connectorIds]),
	);
	return new Set(tools.filter((tool) => disabledConnectors.has(tool.connectorId)).map((tool) => tool.key));
}

export function isCodexToolEnabled(
	tool: CodexAppsToolRecord,
	config: CodexAppsConfig,
	disabledToolKeys: ReadonlySet<string> = new Set(),
): boolean {
	if (disabledToolKeys.has(tool.key)) return false;
	if (config.enabledToolKeys) return config.enabledToolKeys.includes(tool.key);
	return tool.defaultEnabled === true || (config.defaultEnableReadOnly !== false && tool.readOnly);
}

export function activeCodexAppsToolNames(
	tools: CodexAppsToolRecord[],
	config: CodexAppsConfig,
	activeToolNames: string[],
	disabledToolKeys: ReadonlySet<string> = new Set(),
): string[] {
	const existing = activeToolNames.filter((name) => !name.startsWith(CODEX_APPS_TOOL_PREFIX));
	if (!config.enabled) return existing;
	return [
		...existing,
		...tools.filter((tool) => isCodexToolEnabled(tool, config, disabledToolKeys)).map((tool) => tool.piToolName),
	];
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

function mcpResultToAgentContent(
	value: unknown,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	const result = isRecord(value) && isRecord(value.result) ? value.result : value;
	if (isRecord(result) && Array.isArray(result.content)) {
		const content = result.content.flatMap((item) => {
			if (!isRecord(item)) return [];
			if (typeof item.text === "string")
				return [{ type: "text" as const, text: codexAppTextContentToText(item.text) }];
			if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
				return [{ type: "image" as const, data: item.data, mimeType: item.mimeType }];
			}
			return [];
		});
		if (content.length > 0) return content;
	}
	return [{ type: "text", text: mcpResultToText(value) }];
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
	localMcpClients?: ReadonlyMap<string, McpClient>,
	ctx?: ExtensionContext,
): Promise<unknown> {
	if (tool.localServer) {
		const client = localMcpClients?.get(tool.localServer);
		if (!client) throw new Error(`Local MCP server is unavailable: ${tool.localServer}`);
		return client.callTool(
			tool.mcpToolName,
			params,
			signal,
			(message) => ctx?.ui.confirm("Computer Use", message) ?? Promise.resolve(false),
		);
	}
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

export function createToolDefinition(
	tool: CodexAppsToolRecord,
	getConfig: () => CodexAppsConfig,
	localMcpClients: ReadonlyMap<string, McpClient>,
): ToolDefinition<any> {
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await callCodexAppsTool(tool, params, getConfig(), signal, localMcpClients, ctx);
			return {
				content: mcpResultToAgentContent(result),
				details: { tool, params, result },
			};
		},
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : textComponent("");
			text.setText(renderCodexAppCall(tool, args, theme, context?.isPartial !== false, context?.isError === true));
			return text;
		},
		renderResult(result, { expanded }, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : textComponent("");
			if (context?.isPartial) return text;
			const output = codexAppTextContentToText(result.content.find((item) => item.type === "text")?.text ?? "");
			if (tool.connectorId === "computer-use" && !expanded && !context?.isError) return new Container();
			const code = expanded && tool.connectorId === "computer-use" ? context.args?.code : undefined;
			const details = [
				typeof code === "string" && code.trim() ? `Code:\n${code}` : "",
				output.trim() ? `${code ? "Output:\n" : ""}${output}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
			if (!details) return new Container();
			text.setText(renderCodexAppResult(details, theme, { expanded }));
			return text;
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
	if (tool.connectorId === "computer-use") {
		const status = theme.fg(running ? "dim" : failed ? "error" : "success", running ? "•" : failed ? "✗" : "✓");
		const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : codexAppActionLabel(tool);
		return `${status} ${theme.bold("Computer Use")} ${theme.fg("dim", "·")} ${theme.fg("accent", title)}`;
	}
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
			return `${theme.fg("dim", prefix)}${theme.fg("dim", truncateToWidthCompat(line || " ", 120, "…"))}`;
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
	return `${label}${truncateToWidthCompat(raw.replace(/\s+/g, " "), 80, "…")}`.trim();
}

function humanizeIdentifier(value: string): string {
	const words = value
		.replace(/^_+/, "")
		.replace(/[_-]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
	return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

function codexToolsStatus(tools: CodexAppsToolRecord[], plugins: CodexPluginRecord[], config: CodexAppsConfig): string {
	const disabled = disabledCodexAppToolKeys(tools, plugins, config);
	const active = activeCodexAppsToolNames(tools, config, [], disabled).length;
	const enabledPlugins = plugins.filter((plugin) => !config.disabledPluginKeys?.includes(plugin.key)).length;
	return `${active}/${tools.length} tools · ${enabledPlugins}/${plugins.length} plugins`;
}

function pluginEnabled(plugin: CodexPluginRecord, config: CodexAppsConfig): boolean {
	return !config.disabledPluginKeys?.includes(plugin.key);
}

function setPluginEnabled(config: CodexAppsConfig, plugin: CodexPluginRecord, enabled: boolean): void {
	const disabled = new Set(config.disabledPluginKeys ?? []);
	if (enabled) disabled.delete(plugin.key);
	else disabled.add(plugin.key);
	config.disabledPluginKeys = [...disabled].sort();
}

function materializeToolKeys(
	tools: CodexAppsToolRecord[],
	config: CodexAppsConfig,
	disabledToolKeys: ReadonlySet<string>,
): Set<string> {
	return new Set(
		config.enabledToolKeys ??
			tools.filter((tool) => isCodexToolEnabled(tool, config, disabledToolKeys)).map((tool) => tool.key),
	);
}

function setAppEnabled(
	config: CodexAppsConfig,
	app: CodexAppRecord,
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
	enabled: boolean,
): void {
	if (enabled && app.pluginKey) {
		const plugin = plugins.find((candidate) => candidate.key === app.pluginKey);
		if (plugin) setPluginEnabled(config, plugin, true);
	}
	const disabledToolKeys = disabledCodexAppToolKeys(tools, plugins, config);
	const keys = materializeToolKeys(tools, config, disabledToolKeys);
	for (const key of app.toolKeys) {
		if (enabled) keys.add(key);
		else keys.delete(key);
	}
	config.enabledToolKeys = [...keys].sort();
}

function setToolEnabled(
	config: CodexAppsConfig,
	tool: CodexAppsToolRecord,
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
	enabled: boolean,
): void {
	const plugin = plugins.find(
		(candidate) => candidate.name === tool.connectorId || candidate.connectorIds.includes(tool.connectorId),
	);
	if (enabled && plugin) setPluginEnabled(config, plugin, true);
	const disabledToolKeys = disabledCodexAppToolKeys(tools, plugins, config);
	const keys = materializeToolKeys(tools, config, disabledToolKeys);
	if (enabled) keys.add(tool.key);
	else keys.delete(tool.key);
	config.enabledToolKeys = [...keys].sort();
}

export function migrateCodexAppsConfig(
	config: CodexAppsConfig,
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
): boolean {
	if (config.surfaceVersion === CODEX_APPS_SURFACE_VERSION) return false;
	config.surfaceVersion = CODEX_APPS_SURFACE_VERSION;
	if (!config.enabledToolKeys) return true;
	const computerUse = plugins.find((plugin) => plugin.name === "computer-use");
	if (!computerUse || config.disabledPluginKeys?.includes(computerUse.key)) return true;
	const enabled = new Set(config.enabledToolKeys);
	for (const tool of tools) {
		if (tool.connectorId === "computer-use" && tool.defaultEnabled) enabled.add(tool.key);
	}
	config.enabledToolKeys = [...enabled].sort();
	return true;
}

type CodexToolsPanelRow = {
	id: string;
	label: string;
	description: string;
	kind: "bridge" | "plugin" | "app" | "tool" | "skill";
	state: "on" | "off" | "partial";
	tool?: CodexAppsToolRecord;
	app?: CodexAppRecord;
	plugin?: CodexPluginRecord;
	skill?: CodexSkillRecord;
};

const CODEX_TOOLS_MAX_VISIBLE_ROWS = 14;
const CODEX_TOOLS_DESCRIPTION_LINES = 3;

export class CodexToolsPanel implements Component {
	private tabId = "main";
	private selectedIndex = 0;
	private filterActive = false;
	private filterQuery = "";
	private pendingSave = Promise.resolve();

	constructor(
		private readonly theme: Theme,
		private readonly tools: CodexAppsToolRecord[],
		private readonly plugins: CodexPluginRecord[],
		private readonly config: CodexAppsConfig,
		private readonly onConfig: (config: CodexAppsConfig) => Promise<void>,
		private readonly done: () => void,
		private readonly skills: CodexSkillRecord[] = [],
	) {}

	handleInput(data: string): void {
		if (this.filterActive) {
			this.handleFilterInput(data);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done();
			return;
		}
		if (data === "/") {
			this.filterActive = true;
			this.filterQuery = "";
			this.selectedIndex = 0;
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.left) || data === "h") {
			this.switchTab(-1);
			return;
		}
		if (matchesKey(data, Key.right) || data === "l") {
			this.switchTab(1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r" || matchesKey(data, Key.space) || data === " ")
			this.toggleSelected();
	}

	render(width: number): string[] {
		this.ensureTab();
		const rows = this.visibleRows();
		if (rows.length > 0) this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
		const tab = this.currentTab();
		const innerWidth = Math.max(1, width - 2);
		const lines = [
			this.theme.fg("accent", this.theme.bold("Codex Tools")),
			this.theme.fg(
				"dim",
				`${codexToolsStatus(this.tools, this.plugins, this.config)} · /codex-tools reload refreshes discovery`,
			),
			this.renderTabs(innerWidth),
			this.theme.fg(
				"dim",
				tab.id === "main" ? "Main: toggle the bridge, plugins, and apps." : (tab.app?.connectorDescription ?? ""),
			),
		];

		lines.push(
			this.filterActive
				? this.theme.fg("accent", `/${this.filterQuery}▌`)
				: this.theme.fg("dim", "h/l tabs · j/k move · enter/space toggle · / filter · esc/q close"),
		);
		lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));

		const start =
			rows.length === 0
				? 0
				: Math.max(
						0,
						Math.min(
							this.selectedIndex - Math.floor(CODEX_TOOLS_MAX_VISIBLE_ROWS / 2),
							rows.length - CODEX_TOOLS_MAX_VISIBLE_ROWS,
						),
					);
		const end = Math.min(start + CODEX_TOOLS_MAX_VISIBLE_ROWS, rows.length);
		for (let index = 0; index < CODEX_TOOLS_MAX_VISIBLE_ROWS; index++) {
			const row = rows[start + index];
			lines.push(row ? this.renderRow(row, start + index === this.selectedIndex, innerWidth) : "");
		}
		lines.push(
			rows.length === 0
				? this.theme.fg("muted", "  No matching items")
				: start > 0 || end < rows.length
					? this.theme.fg("dim", `  ${this.selectedIndex + 1}/${rows.length}`)
					: "",
		);
		lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));

		const selected = rows[this.selectedIndex];
		const descriptionLines = selected?.description
			? wrapTextWithAnsi(selected.description, Math.max(12, innerWidth - 4)).slice(0, CODEX_TOOLS_DESCRIPTION_LINES)
			: [];
		for (let index = 0; index < CODEX_TOOLS_DESCRIPTION_LINES; index++) {
			const line = descriptionLines[index];
			lines.push(line ? this.theme.fg("dim", `  ${line}`) : "");
		}
		return this.frame(width, lines);
	}

	private frame(width: number, lines: string[]): string[] {
		const innerWidth = Math.max(1, width - 2);
		const content = lines.map((line) => this.fitLine(line, innerWidth));
		const border = this.theme.fg("border", "│");
		return [
			this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
			...content.map((line) => `${border}${line}${border}`),
			this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
		];
	}

	private fitLine(line: string, width: number): string {
		const truncated = truncateToWidthCompat(line, width, "…");
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}

	invalidate(): void {}

	async waitForPendingSaves(): Promise<void> {
		await this.pendingSave;
	}

	private currentTab(): { id: string; label: string; app?: CodexAppRecord } {
		return this.tabs().find((tab) => tab.id === this.tabId) ?? { id: "main", label: "Main" };
	}

	private tabs(): Array<{ id: string; label: string; app?: CodexAppRecord }> {
		if (!this.config.enabled) return [{ id: "main", label: "Main" }];
		const disabled = disabledCodexAppToolKeys(this.tools, this.plugins, this.config);
		const enabledApps = buildCodexAppRecords(this.tools, this.plugins).filter((app) =>
			app.toolKeys.some((key) => {
				const tool = this.tools.find((candidate) => candidate.key === key);
				return tool ? isCodexToolEnabled(tool, this.config, disabled) : false;
			}),
		);
		return [
			{ id: "main", label: "Main" },
			...enabledApps.map((app) => ({ id: `app:${app.connectorId}`, label: app.connectorName, app })),
		];
	}

	private ensureTab(): void {
		if (this.tabs().some((tab) => tab.id === this.tabId)) return;
		this.tabId = "main";
		this.selectedIndex = 0;
	}

	private visibleRows(): CodexToolsPanelRow[] {
		const tab = this.currentTab();
		const rows = tab.id === "main" ? this.mainRows() : this.toolRows(tab.app!);
		if (!this.filterQuery) return rows;
		const query = this.filterQuery.toLowerCase().trim();
		return rows.filter((row) => `${row.label} ${row.description} ${row.id}`.toLowerCase().includes(query));
	}

	private mainRows(): CodexToolsPanelRow[] {
		const apps = buildCodexAppRecords(this.tools, this.plugins);
		return [
			{
				id: "__bridge__",
				label: "Codex Apps bridge",
				description:
					"Enable or disable all Codex app tools. Plugin skills remain controlled by their plugin toggles.",
				kind: "bridge",
				state: this.config.enabled ? "on" : "off",
			},
			...this.plugins.map((plugin) => ({
				id: `plugin:${plugin.key}`,
				label: `Plugin · ${humanizeIdentifier(plugin.name)}`,
				description: `${plugin.marketplace} · ${plugin.version} · ${plugin.skillPaths.length} skill root${plugin.skillPaths.length === 1 ? "" : "s"}`,
				kind: "plugin" as const,
				state: pluginEnabled(plugin, this.config) ? ("on" as const) : ("off" as const),
				plugin,
			})),
			...apps.map((app) => ({
				id: `app:${app.connectorId}`,
				label: `App · ${app.connectorName}`,
				description: `${app.connectorDescription || "Codex app"} · ${app.toolKeys.length} tools`,
				kind: "app" as const,
				state: appState(app, this.tools, this.plugins, this.config),
				app,
			})),
			...this.skills.map((skill) => ({
				id: `skill:${skill.name}`,
				label: `Skill · ${skill.name}`,
				description: `${skill.pluginKey} · ${skill.filePath}`,
				kind: "skill" as const,
				state: isSkillVisible(skill.name, this.config) ? ("on" as const) : ("off" as const),
				skill,
			})),
		];
	}

	private toolRows(app: CodexAppRecord): CodexToolsPanelRow[] {
		const disabled = disabledCodexAppToolKeys(this.tools, this.plugins, this.config);
		return app.toolKeys.flatMap((key) => {
			const tool = this.tools.find((candidate) => candidate.key === key);
			if (!tool) return [];
			return [
				{
					id: tool.key,
					label: tool.title,
					description: `${tool.readOnly ? "read-only" : "write"}${tool.destructive ? " · destructive" : ""} · ${tool.description}`,
					kind: "tool" as const,
					state: isCodexToolEnabled(tool, this.config, disabled) ? ("on" as const) : ("off" as const),
					tool,
				},
			];
		});
	}

	private renderTabs(width: number): string {
		return truncateToWidthCompat(
			this.tabs()
				.map((tab) =>
					tab.id === this.tabId
						? this.theme.fg("accent", `[ ${tab.label} ]`)
						: this.theme.fg("dim", `  ${tab.label}  `),
				)
				.join(this.theme.fg("dim", "│")),
			width,
			"…",
		);
	}

	private renderRow(row: CodexToolsPanelRow, selected: boolean, width: number): string {
		const marker = selected ? this.theme.fg("accent", "▸") : " ";
		const state =
			row.state === "on"
				? this.theme.fg("success", "on")
				: row.state === "off"
					? this.theme.fg("muted", "off")
					: this.theme.fg("warning", "partial");
		return truncateToWidthCompat(`${marker} ${row.label}  ${state}`, Math.max(12, width), "…");
	}

	private handleFilterInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.filterActive = false;
			this.filterQuery = "";
			this.selectedIndex = 0;
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r") {
			this.filterActive = false;
			return;
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f") {
			this.filterQuery = this.filterQuery.slice(0, -1);
			this.selectedIndex = 0;
			return;
		}
		if (data.length === 1 && data >= " ") {
			this.filterQuery += data;
			this.selectedIndex = 0;
		}
	}

	private moveSelection(delta: number): void {
		const rows = this.visibleRows();
		if (rows.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + rows.length) % rows.length;
	}

	private switchTab(delta: number): void {
		const tabs = this.tabs();
		const index = tabs.findIndex((tab) => tab.id === this.tabId);
		if (index < 0 || tabs.length < 2) return;
		this.tabId = tabs[(index + delta + tabs.length) % tabs.length]!.id;
		this.selectedIndex = 0;
		this.filterActive = false;
		this.filterQuery = "";
	}

	private toggleSelected(): void {
		const row = this.visibleRows()[this.selectedIndex];
		if (!row) return;
		if (row.kind === "bridge") this.config.enabled = !this.config.enabled;
		else if (row.kind === "plugin" && row.plugin)
			setPluginEnabled(this.config, row.plugin, !pluginEnabled(row.plugin, this.config));
		else if (row.kind === "app" && row.app)
			setAppEnabled(this.config, row.app, this.tools, this.plugins, row.state !== "on");
		else if (row.kind === "tool" && row.tool)
			setToolEnabled(this.config, row.tool, this.tools, this.plugins, row.state !== "on");
		else if (row.kind === "skill" && row.skill) setSkillVisible(this.config, row.skill.name, row.state !== "on");
		this.pendingSave = this.pendingSave.then(() => this.onConfig(this.config));
		this.ensureTab();
	}
}

function isSkillVisible(name: string, config: CodexAppsConfig): boolean {
	return !config.hiddenSkillNames?.includes(name);
}

function setSkillVisible(config: CodexAppsConfig, name: string, visible: boolean): void {
	const hidden = new Set(config.hiddenSkillNames ?? []);
	if (visible) hidden.delete(name);
	else hidden.add(name);
	config.hiddenSkillNames = [...hidden].sort();
}

function appState(
	app: CodexAppRecord,
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
): "on" | "off" | "partial" {
	const disabled = disabledCodexAppToolKeys(tools, plugins, config);
	const enabledCount = app.toolKeys.filter((key) => {
		const tool = tools.find((candidate) => candidate.key === key);
		return tool ? isCodexToolEnabled(tool, config, disabled) : false;
	}).length;
	return enabledCount === 0 ? "off" : enabledCount === app.toolKeys.length ? "on" : "partial";
}

async function showCodexToolsPanel(
	ctx: ExtensionContext,
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
	onConfig: (config: CodexAppsConfig) => Promise<void>,
	skills: CodexSkillRecord[],
): Promise<void> {
	let panel: CodexToolsPanel | undefined;
	await codexAppsTui.bind(ctx).overlays.openComponent<undefined>(
		(_tui, theme: Theme, _keybindings, done) => {
			panel = new CodexToolsPanel(theme, tools, plugins, config, onConfig, () => done(undefined), skills);
			return panel;
		},
		{ overlayOptions: { width: "90%", maxHeight: 30, margin: 1 } },
	);
	await panel?.waitForPendingSaves();
}

export default async function registerCodexAppsBridge(pi: ExtensionAPI) {
	let config = await loadConfig();
	const nodeRepl = await discoverNodeReplTools();
	const localMcpClients = new Map<string, McpClient>();
	if (nodeRepl) localMcpClients.set("node_repl", nodeRepl.client);
	let plugins = await discoverCodexPlugins();
	const pluginMcp = await discoverPluginMcpTools(plugins);
	for (const surface of pluginMcp) localMcpClients.set(surface.serverKey, surface.client);
	let tools = [
		...(await discoverCodexAppsTools()),
		...(nodeRepl?.tools ?? []),
		...pluginMcp.flatMap((surface) => surface.tools),
	];
	syncCodexPluginAliases(plugins, config, tools);
	if (migrateCodexAppsConfig(config, tools, plugins)) await saveConfig(config);
	const registeredKeys = new Set<string>();

	const registerDiscoveredTools = (nextTools: CodexAppsToolRecord[]) => {
		for (const tool of nextTools) {
			if (registeredKeys.has(tool.key)) continue;
			registeredKeys.add(tool.key);
			pi.registerTool(createToolDefinition(tool, () => config, localMcpClients));
		}
	};

	registerDiscoveredTools(tools);

	const applyActiveTools = (ctx?: ExtensionContext) => {
		const active = pi.getActiveTools();
		const disabledToolKeys = disabledCodexAppToolKeys(tools, plugins, config);
		const next = activeCodexAppsToolNames(tools, config, active, disabledToolKeys);
		if (active.length !== next.length || active.some((name, index) => name !== next[index])) pi.setActiveTools(next);
		if (ctx)
			codexAppsTui.bind(ctx).status.set("status", ctx.ui.theme.fg("dim", codexToolsStatus(tools, plugins, config)));
	};

	const persistAndApply = async (nextConfig: CodexAppsConfig) => {
		config = { ...nextConfig };
		await saveConfig(config);
		syncCodexPluginAliases(plugins, config, tools);
		applyActiveTools();
	};

	pi.registerCommand("codex-tools", {
		description: "Configure Codex app tools exposed through the Codex native bridge",
		handler: async (args, ctx) => {
			if (args.trim() === "reload") {
				try {
					tools = [...(await fetchCodexAppsToolsFromMcp(config, ctx.signal)), ...(nodeRepl?.tools ?? [])];
					plugins = await discoverCodexPlugins();
					syncCodexPluginAliases(plugins, config, tools);
					registerDiscoveredTools(tools);
					ctx.ui.notify(`Fetched ${tools.length} Codex app tools and found ${plugins.length} plugins.`, "info");
				} catch (error) {
					tools = [...(await discoverCodexAppsTools()), ...(nodeRepl?.tools ?? [])];
					plugins = await discoverCodexPlugins();
					syncCodexPluginAliases(plugins, config, tools);
					registerDiscoveredTools(tools);
					ctx.ui.notify(
						`Live fetch failed; loaded ${tools.length} cached Codex app tools and found ${plugins.length} plugins: ${
							error instanceof Error ? error.message : String(error)
						}`,
						"warning",
					);
				}
				applyActiveTools(ctx);
				return;
			}
			await showCodexToolsPanel(
				ctx,
				tools,
				plugins,
				{ ...config },
				persistAndApply,
				discoverCodexSkills(pi, plugins, config, tools),
			);
			applyActiveTools(ctx);
			await ctx.reload();
		},
	});

	pi.on("session_start", (_event, ctx) => applyActiveTools(ctx));
	pi.on("session_shutdown", () => {
		for (const client of localMcpClients.values()) client.close();
	});
	pi.on("resources_discover", async (_event, ctx) => {
		applyActiveTools(ctx);
		return { skillPaths: pluginSkillPaths(plugins, config, tools) };
	});
	pi.on("model_select", (_event, ctx) => applyActiveTools(ctx));
}
