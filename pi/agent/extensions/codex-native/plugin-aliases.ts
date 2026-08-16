import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_PLUGIN_ALIASES = Symbol.for("pi.codex.pluginAliases");

type PluginAliasRegistry = typeof globalThis & {
	[CODEX_PLUGIN_ALIASES]?: Set<string>;
};

type PluginManifest = {
	name?: unknown;
	apps?: unknown;
};

type AppManifest = {
	apps?: Record<string, { id?: unknown }>;
};

export function setCodexPluginAliases(names: Iterable<string>): void {
	(globalThis as PluginAliasRegistry)[CODEX_PLUGIN_ALIASES] = new Set(names);
}

export function getCodexPluginAliases(): Set<string> {
	const registry = (globalThis as PluginAliasRegistry)[CODEX_PLUGIN_ALIASES];
	return registry ?? discoverCodexPluginAliases();
}

export function getCodexHiddenSkillNames(): Set<string> {
	const config = readJson(join(homedir(), ".pi", "agent", "codex-tools.json"));
	return new Set(
		Array.isArray(config?.hiddenSkillNames)
			? config.hiddenSkillNames.filter((name): name is string => typeof name === "string")
			: [],
	);
}

function discoverCodexPluginAliases(): Set<string> {
	const aliases = new Set<string>();
	const root = process.env.CODEX_HOME ?? join(homedir(), ".codex");
	const marketplaceRoot = join(root, "plugins", "cache");
	for (const marketplace of readDirectory(marketplaceRoot)) {
		for (const name of readDirectory(join(marketplaceRoot, marketplace))) {
			for (const version of readDirectory(join(marketplaceRoot, marketplace, name))) {
				addManifestAlias(
					join(marketplaceRoot, marketplace, name, version, ".codex-plugin", "plugin.json"),
					marketplace,
					aliases,
				);
			}
		}
	}
	for (const pluginsRoot of [
		{ path: join(root, ".tmp", "plugins", "plugins"), marketplace: "tmp" },
		{ path: join(root, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins"), marketplace: "openai-bundled" },
	]) {
		for (const name of readDirectory(pluginsRoot.path)) {
			addManifestAlias(
				join(pluginsRoot.path, name, ".codex-plugin", "plugin.json"),
				pluginsRoot.marketplace,
				aliases,
			);
		}
	}
	return aliases;
}

export function isCodexPluginEnabled(
	name: string,
	marketplace: string,
	pluginRoot: string,
	appEnabled = false,
): boolean {
	const piConfig = readJson(join(homedir(), ".pi", "agent", "codex-tools.json"));
	if (Array.isArray(piConfig?.disabledPluginKeys) && piConfig.disabledPluginKeys.some((key) => key === name)) {
		return false;
	}
	const root = codexHomeForPlugin(pluginRoot);
	const configured = readPluginConfig(root).get(`${name}@${marketplace}`);
	if (configured !== undefined) return configured;
	if (appEnabled) return true;
	return !isMarketplaceInventory(pluginRoot);
}

export function isCodexPluginInstalled(
	name: string,
	marketplace: string,
	pluginRoot: string,
	root = codexHomeForPlugin(pluginRoot),
): boolean {
	if (readText(join(root, "config.toml")) === undefined) return true;
	return readPluginConfig(root).has(`${name}@${marketplace}`);
}

function readDirectory(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function addManifestAlias(path: string, marketplace: string, aliases: Set<string>): void {
	try {
		const manifest = JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
		if (typeof manifest.name !== "string" || manifest.name.length === 0) return;
		if (!isCodexPluginInstalled(manifest.name, marketplace, path)) return;
		const appEnabled = pluginAppIds(manifest, path).some((id) => isConnectorEnabled(id));
		if (isCodexPluginEnabled(manifest.name, marketplace, path, appEnabled)) aliases.add(manifest.name);
	} catch {}
}

function pluginAppIds(manifest: PluginManifest, manifestPath: string): string[] {
	if (typeof manifest.apps === "object" && manifest.apps !== null) {
		return appIdsFromManifest(manifest.apps);
	}
	if (typeof manifest.apps !== "string") return [];
	try {
		return appIdsFromManifest(JSON.parse(readFileSync(join(manifestPath, "..", "..", manifest.apps), "utf8")));
	} catch {
		return [];
	}
}

function appIdsFromManifest(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	const apps = (value as AppManifest).apps;
	if (!apps || typeof apps !== "object") return [];
	return Object.values(apps)
		.map((app) => (typeof app.id === "string" ? app.id : undefined))
		.filter((id): id is string => Boolean(id));
}

/**
 * Whether a connector is switched on, read straight off the config.
 *
 * This used to scan the codex apps tool cache to find out whether any single
 * tool of the connector appeared in `enabledToolKeys`. Connector toggles are
 * now the unit the config stores, so the answer is two field reads and the
 * cache never has to be opened.
 */
function isConnectorEnabled(connectorId: string): boolean {
	const config = readJson(join(homedir(), ".pi", "agent", "codex-tools.json"));
	if (config?.enabled === false) return false;
	const disabled = Array.isArray(config?.disabledConnectorIds) ? config.disabledConnectorIds : [];
	return !disabled.includes(connectorId);
}

function readPluginConfig(root: string): Map<string, boolean> {
	const config = readText(join(root, "config.toml"));
	if (!config) return new Map();
	const settings = new Map<string, boolean>();
	let key: string | undefined;
	for (const line of config.split("\n")) {
		const table = line.match(/^\[plugins\."([^"]+)@([^"]+)"\]\s*$/);
		if (table) {
			key = `${table[1]}@${table[2]}`;
			continue;
		}
		if (!key) continue;
		const enabled = line.match(/^enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
		if (enabled) settings.set(key, enabled[1] === "true");
	}
	return settings;
}

function codexHomeForPlugin(pluginRoot: string): string {
	const match = pluginRoot.match(/^(.*\/\.codex)(?:\/|$)/);
	return match?.[1] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function isMarketplaceInventory(pluginRoot: string): boolean {
	return (
		pluginRoot.includes("/.codex/.tmp/plugins/plugins/") || pluginRoot.includes("/.codex/.tmp/bundled-marketplaces/")
	);
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function readJson(path: string): Record<string, unknown> | undefined {
	const text = readText(path);
	if (!text) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}
