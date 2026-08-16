import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CodexAppServerMcpClient, type CodexAppServerMcpServer } from "./app-server-mcp.ts";
import { codexAppTextContentToText, humanizeIdentifier, structuredContentToText } from "./codex-app-content.ts";
import { type ConfiguredMcpServer, discoverLocalMcpServers, type LocalMcpTool } from "./local-mcp";
import { NODE_REPL_SERVER, primeNodeReplKernel } from "./node-repl-shim.ts";
import { isCodexPluginEnabled, isCodexPluginInstalled, setCodexPluginAliases } from "./plugin-aliases";

const CODEX_APPS_TOOL_PREFIX = "codex_apps_";
const DEFAULT_CODEX_APPS_MCP_URL = "https://chatgpt.com/backend-api/codex/apps";
const CODEX_APPS_CONFIG_PATH = join(homedir(), ".pi", "agent", "codex-tools.json");
const CODEX_APPS_CACHE_DIR = join(homedir(), ".codex", "cache", "codex_apps_tools");
const CODEX_AUTH_PATH = join(codexHome(), "auth.json");

/**
 * What the Codex settings Apps, MCP, and Skills tabs decide, now that connector tools are nested.
 *
 * Code-mode took every connector off the model's direct surface, so a
 * registered tool costs nothing per request and per-tool enablement stopped
 * buying anything — `tool-policy` intersects the active set with
 * `["exec", "wait", "ask_user"]` on every lifecycle event, so no list this
 * extension computed could survive to reach the provider anyway. What survives
 * here gates two costs that are still real:
 *
 *   - `enabled` and `disabledConnectorIds` gate *registration*, which is what
 *     decides membership of `ALL_TOOLS`. That array is the model's only way to
 *     find a nested tool, so a connector the human does not use is not free:
 *     it is noise in the one place discovery happens, and it fails at call time
 *     if the connector was never linked.
 *   - `disabledPluginKeys` and `hiddenSkillNames` gate skills, which are
 *     resident prompt and autocomplete surface and never became cheap.
 */
export type CodexAppsConfig = {
	enabled: boolean;
	endpointUrl?: string;
	disabledConnectorIds?: string[];
	disabledPluginKeys?: string[];
	hiddenSkillNames?: string[];
	surfaceVersion?: number;
};

const CODEX_APPS_SURFACE_VERSION = 2;

type CodexPluginManifest = {
	name?: string;
	version?: string;
	skills?: string | string[];
	apps?: string | { apps?: Record<string, { id?: string }> };
	interface?: { displayName?: string };
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
	displayName?: string;
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
export type CodexSkillCommand = {
	name: string;
	source?: string;
	sourceInfo?: { path?: string };
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
		_meta?: {
			connector_id?: string;
			connector_name?: string;
			connector_description?: string;
			link_id?: string;
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
	mcpServerName?: string;
};

export type CodexAppsResultTool = Omit<CodexAppsToolRecord, "description" | "inputSchema" | "connectorDescription">;

export type CodexMcpServerStatus = {
	name: string;
	configured?: ConfiguredMcpServer;
	appServer?: CodexAppServerMcpServer;
};

export type CodexMcpDiscovery = {
	client?: CodexAppServerMcpClient;
	tools: CodexAppsToolRecord[];
	servers: CodexMcpServerStatus[];
};

export type CodexAppsRuntimeState = {
	config: CodexAppsConfig;
	plugins: CodexPluginRecord[];
	tools: CodexAppsToolRecord[];
	mcpServers: CodexMcpServerStatus[];
	client?: CodexAppServerMcpClient;
};

type CodexAuth = {
	tokens?: {
		access_token?: string;
		account_id?: string;
	};
};

const defaultConfig: CodexAppsConfig = { enabled: true };

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
			displayName: manifest.interface?.displayName,
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

export async function systemSkillPaths(root = codexHome()): Promise<string[]> {
	const path = await directoryIfExists(join(root, "skills", ".system"));
	return path ? [path] : [];
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

export async function loadConfig(): Promise<CodexAppsConfig> {
	return { ...defaultConfig, ...((await readJsonFile<CodexAppsConfig>(CODEX_APPS_CONFIG_PATH)) ?? {}) };
}

export async function saveConfig(config: CodexAppsConfig): Promise<void> {
	await mkdir(dirname(CODEX_APPS_CONFIG_PATH), { recursive: true });
	await writeFile(CODEX_APPS_CONFIG_PATH, JSON.stringify(config, null, 2).concat("\n"));
}

export function codexAuthPath(): string {
	return CODEX_AUTH_PATH;
}

export function codexAuthAvailable(): boolean {
	return Boolean(readJsonFileSync<CodexAuth>(CODEX_AUTH_PATH));
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

// Starting the app-server is the cost, so a run with no enabled MCP server returns without starting codex.
// Discovery doubles as a health check: a server codex could not start reports no tools and drops out of `ALL_TOOLS` rather than failing at call time.
// The client is returned, not kept, because the same connection serves every later call.
export async function discoverPluginMcpTools(
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
	createClient: () => CodexAppServerMcpClient = () => new CodexAppServerMcpClient(),
	configuredMcpServers: ConfiguredMcpServer[] = [],
): Promise<CodexMcpDiscovery> {
	const owners = new Map<string, CodexPluginRecord>();
	for (const plugin of plugins) {
		if (!pluginEnabled(plugin, config)) continue;
		for (const server of await discoverLocalMcpServers(plugin.rootPath)) owners.set(server, plugin);
	}
	const configuredByName = new Map(configuredMcpServers.map((server) => [server.name, server]));
	const serverNames = new Set(
		[...configuredByName.values()]
			.filter((server) => server.enabled)
			.map((server) => server.name)
			.concat([...owners.keys()])
			.filter((server) => configuredByName.get(server)?.enabled !== false),
	);
	if (serverNames.size === 0) return { tools: [], servers: mcpServerStatuses(configuredByName, new Map()) };

	const client = createClient();
	try {
		const appServers = await client.listServers();
		const usedPiNames = new Set<string>();
		const tools = [...serverNames].flatMap((server) => {
			const appServer = appServers.get(server);
			const configured = configuredByName.get(server);
			if (!appServer || appServer.enabled === false) return [];
			return appServer.tools
				.map((tool) =>
					configured
						? normalizeConfiguredMcpTool(server, tool)
						: normalizePluginMcpTool(owners.get(server)!, server, tool),
				)
				.map((tool) => uniquifyMcpToolName(tool, usedPiNames));
		});
		return { client, tools, servers: mcpServerStatuses(configuredByName, appServers, serverNames) };
	} catch (error) {
		client.close();
		console.warn(`Codex app-server MCP discovery failed: ${error instanceof Error ? error.message : String(error)}`);
		return { tools: [], servers: mcpServerStatuses(configuredByName, new Map(), serverNames) };
	}
}

export async function discoverCodexAppsRuntimeState(
	config: CodexAppsConfig,
	configuredMcpServers: ConfiguredMcpServer[] = [],
): Promise<CodexAppsRuntimeState> {
	const plugins = await discoverCodexPlugins();
	const mcp = await discoverPluginMcpTools(plugins, config, undefined, configuredMcpServers);
	return {
		config,
		plugins,
		tools: [...(await discoverCodexAppsTools()), ...mcp.tools],
		mcpServers: mcp.servers,
		client: mcp.client,
	};
}
function mcpServerStatuses(
	configured: Map<string, ConfiguredMcpServer>,
	appServers: Map<string, CodexAppServerMcpServer>,
	requested: Iterable<string> = [],
): CodexMcpServerStatus[] {
	const names = new Set([...configured.keys(), ...requested]);
	return [...names].map((name) => ({ name, configured: configured.get(name), appServer: appServers.get(name) }));
}

export function codexConfigPath(): string {
	return join(codexHome(), "config.toml");
}

// Every warning here names the key and the file to edit. `codex mcp` has no enable/disable subcommand, so the
// config file is the only remedy, and a warning that names a state without naming one costs attention and buys
// nothing. The empty-server text is the diagnosis that was actually missing: `computer-use` shipped
// `cwd = "."` with a relative `command`, which resolves against pi's working directory, so codex could never
// start it — an absolute `cwd` turns the same entry into 10 working tools.
export function codexMcpWarnings(servers: CodexMcpServerStatus[]): string[] {
	return servers.flatMap(({ name, configured, appServer }) => {
		if (configured?.enabled && !appServer)
			return [
				`Codex MCP server ${name} is declared in ${codexConfigPath()} but the codex app-server never listed it. Check [mcp_servers.${name}] for a misspelled name, then restart pi.`,
			];
		if (
			configured?.enabled !== false &&
			appServer &&
			appServer.serverInfo === null &&
			appServer.tools.length === 0 &&
			appServer.enabled !== false
		)
			return [
				`Codex MCP server ${name} started with no tools. Check command and cwd under [mcp_servers.${name}] in ${codexConfigPath()}: a relative command with cwd = "." resolves against pi's working directory, not the server's own.`,
			];
		return [];
	});
}

function normalizePluginMcpTool(plugin: CodexPluginRecord, server: string, tool: LocalMcpTool): CodexAppsToolRecord {
	const connectorName = plugin.displayName ?? humanizeIdentifier(plugin.name);
	return {
		key: `${plugin.key}:${server}:${tool.name}`,
		// Codex names these tools `mcp__<server>__<tool>` and the model has seen
		// them under those names, including in the cells it writes.
		piToolName: `mcp__${safeToolName(server)}__${safeToolName(tool.name)}`,
		mcpToolName: tool.name,
		title: tool.name,
		description: tool.description ?? `Call ${tool.name} from the ${plugin.name} plugin.`,
		inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
		connectorId: plugin.name,
		connectorName,
		connectorDescription: `Tools provided by the ${connectorName} plugin`,
		mcpServerName: server,
	};
}
function normalizeConfiguredMcpTool(server: string, tool: LocalMcpTool): CodexAppsToolRecord {
	const connectorName = humanizeIdentifier(server);
	return {
		key: `codex-config:${server}:${tool.name}`,
		piToolName: `mcp__${safeToolName(server)}__${safeToolName(tool.name)}`,
		mcpToolName: tool.name,
		title: tool.name,
		description: tool.description ?? `Call ${tool.name} from the ${server} MCP server.`,
		inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
		connectorId: `mcp:${server}`,
		connectorName,
		connectorDescription: `Tools provided by the ${connectorName} MCP server`,
		mcpServerName: server,
	};
}

function uniquifyMcpToolName(tool: CodexAppsToolRecord, usedPiNames: Set<string>): CodexAppsToolRecord {
	if (!usedPiNames.has(tool.piToolName)) {
		usedPiNames.add(tool.piToolName);
		return tool;
	}
	let piToolName = `${tool.piToolName}_${shortHash(tool.key)}`;
	while (usedPiNames.has(piToolName)) piToolName += "_";
	usedPiNames.add(piToolName);
	return { ...tool, piToolName };
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

export function pluginSkillPaths(plugins: CodexPluginRecord[], config: CodexAppsConfig): string[] {
	return enabledPlugins(plugins, config).flatMap((plugin) => plugin.skillPaths);
}

function enabledPlugins(plugins: CodexPluginRecord[], config: CodexAppsConfig): CodexPluginRecord[] {
	return plugins
		.filter((plugin) => pluginEnabled(plugin, config))
		.filter((plugin) =>
			isCodexPluginEnabled(plugin.name, plugin.marketplace, plugin.rootPath, pluginAppEnabled(plugin, config)),
		);
}

export function syncCodexPluginAliases(plugins: CodexPluginRecord[], config: CodexAppsConfig): void {
	setCodexPluginAliases(enabledPlugins(plugins, config).map((plugin) => plugin.name));
}

export function discoverCodexSkills(
	commands: readonly CodexSkillCommand[],
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
): CodexSkillRecord[] {
	const pluginRoots = plugins.map((plugin) => ({
		plugin,
		roots: pluginSkillPaths([plugin], config).map((root) => root.replaceAll("\\", "/")),
	}));
	const skills: CodexSkillRecord[] = [];
	for (const command of commands) {
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

function pluginAppEnabled(plugin: CodexPluginRecord, config: CodexAppsConfig): boolean {
	return plugin.connectorIds.some((connectorId) => isConnectorEnabled(connectorId, config));
}

function pluginMarketplace(pluginRoot: string): string {
	const bundled = pluginRoot.match(/\/\.tmp\/bundled-marketplaces\/([^/]+)\/plugins\//);
	if (bundled?.[1]) return bundled[1];
	if (pluginRoot.includes("/.tmp/plugins/plugins/")) return "tmp";
	return basename(dirname(dirname(pluginRoot)));
}

// Connectors are on by default and named individually to switch off: a spare one costs discovery noise, not resident tokens. A plugin toggle covers the connectors it owns.
export function isConnectorEnabled(
	connectorId: string,
	config: CodexAppsConfig,
	disabledConnectorIds: ReadonlySet<string> = new Set(config.disabledConnectorIds ?? []),
): boolean {
	return config.enabled && !disabledConnectorIds.has(connectorId);
}

/** Every connector id switched off, whether by its own toggle or by its plugin's. */
export function disabledConnectorIds(plugins: CodexPluginRecord[], config: CodexAppsConfig): Set<string> {
	const disabledPlugins = new Set(config.disabledPluginKeys ?? []);
	return new Set([
		...(config.disabledConnectorIds ?? []),
		...plugins
			.filter((plugin) => disabledPlugins.has(plugin.key))
			.flatMap((plugin) => [plugin.name, ...plugin.connectorIds]),
	]);
}

export function enabledCodexAppsTools(
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
): CodexAppsToolRecord[] {
	const disabled = disabledConnectorIds(plugins, config);
	return tools.filter((tool) => isConnectorEnabled(tool.connectorId, config, disabled));
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

async function callCodexAppsTool(
	tool: CodexAppsToolRecord,
	params: Record<string, unknown>,
	config: CodexAppsConfig,
	signal?: AbortSignal,
	appServer?: CodexAppServerMcpClient,
): Promise<unknown> {
	if (tool.mcpServerName) {
		if (!appServer) throw new Error(`Codex app-server is unavailable for ${tool.mcpServerName}`);
		if (tool.mcpServerName === NODE_REPL_SERVER) await primeNodeReplKernel(appServer, tool.mcpToolName, signal);
		return appServer.callTool(tool.mcpServerName, tool.mcpToolName, params, signal);
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

// A returned result is not a tool declaration. `description` and `inputSchema` are how the model finds a tool,
// and it has already found this one; carrying them back cost 12,491 tokens for 4 `codex_apps_notion_search`
// calls whose real content was 4 tokens each. `details` is also persisted per call in the session JSONL, where
// `slack_update_canvas`'s 12,701-character description would be rewritten on every use.
export function resultToolIdentity(tool: CodexAppsToolRecord): CodexAppsResultTool {
	return {
		key: tool.key,
		piToolName: tool.piToolName,
		mcpToolName: tool.mcpToolName,
		title: tool.title,
		connectorId: tool.connectorId,
		connectorName: tool.connectorName,
		...(tool.mcpServerName ? { mcpServerName: tool.mcpServerName } : {}),
	};
}

export function createToolDefinition(
	tool: CodexAppsToolRecord,
	getConfig: () => CodexAppsConfig,
	getAppServer: () => CodexAppServerMcpClient | undefined,
): ToolDefinition<any> {
	return {
		name: tool.piToolName,
		label: tool.title,
		description: `${tool.description}\n\nCodex app: ${tool.connectorName}.`,
		promptSnippet: `Call ${tool.title} from the Codex ${tool.connectorName} app.`,
		promptGuidelines: [
			`Use ${tool.piToolName} only when the user asks for information or actions that require the ${tool.connectorName} Codex app.`,
		],
		parameters: Type.Unsafe(tool.inputSchema as Record<string, unknown>),
		async execute(_toolCallId, params, signal) {
			const result = await callCodexAppsTool(tool, params, getConfig(), signal, getAppServer());
			return {
				content: mcpResultToAgentContent(result),
				details: { tool: resultToolIdentity(tool), params, result },
			};
		},
	};
}

export function codexToolsStatus(
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
	mcpServers: CodexMcpServerStatus[] = [],
): string {
	const enabled = enabledCodexAppsTools(tools, plugins, config).length;
	const enabledPluginCount = plugins.filter((plugin) => pluginEnabled(plugin, config)).length;
	const mcpStatus = mcpServers.length
		? ` · ${mcpServers.filter((server) => server.configured?.enabled !== false).length}/${mcpServers.length} MCP servers`
		: "";
	return `${enabled}/${tools.length} tools · ${enabledPluginCount}/${plugins.length} plugins${mcpStatus}`;
}

/** Toggle `key` out of (present=true) or into (present=false) a sorted membership list. */
function toggleMember(list: string[] | undefined, key: string, present: boolean): string[] {
	const set = new Set(list ?? []);
	if (present) set.delete(key);
	else set.add(key);
	return [...set].sort();
}

export function pluginEnabled(plugin: CodexPluginRecord, config: CodexAppsConfig): boolean {
	return !config.disabledPluginKeys?.includes(plugin.key);
}

export function setPluginEnabled(config: CodexAppsConfig, plugin: CodexPluginRecord, enabled: boolean): void {
	config.disabledPluginKeys = toggleMember(config.disabledPluginKeys, plugin.key, enabled);
}

export function setConnectorEnabled(
	config: CodexAppsConfig,
	app: CodexAppRecord,
	plugins: CodexPluginRecord[],
	enabled: boolean,
): void {
	if (enabled && app.pluginKey) {
		const plugin = plugins.find((candidate) => candidate.key === app.pluginKey);
		if (plugin) setPluginEnabled(config, plugin, true);
	}
	config.disabledConnectorIds = toggleMember(config.disabledConnectorIds, app.connectorId, enabled);
}

// `enabledToolKeys` and `defaultEnableReadOnly` are dropped rather than translated, and `enabled` is forced back on: both answered which connector tools were worth a
// resident schema, and code-mode removed that cost. Inheriting an old `enabled: false` would hide every connector for an expired reason.
export function migrateCodexAppsConfig(config: CodexAppsConfig): boolean {
	if (config.surfaceVersion === CODEX_APPS_SURFACE_VERSION) return false;
	const legacy = config as CodexAppsConfig & { enabledToolKeys?: unknown; defaultEnableReadOnly?: unknown };
	delete legacy.enabledToolKeys;
	delete legacy.defaultEnableReadOnly;
	config.enabled = true;
	config.surfaceVersion = CODEX_APPS_SURFACE_VERSION;
	return true;
}

export function isSkillVisible(name: string, config: CodexAppsConfig): boolean {
	return !config.hiddenSkillNames?.includes(name);
}

export function setSkillVisible(config: CodexAppsConfig, name: string, visible: boolean): void {
	config.hiddenSkillNames = toggleMember(config.hiddenSkillNames, name, visible);
}
