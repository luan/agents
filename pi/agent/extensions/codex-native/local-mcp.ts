import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCodexCliPath } from "./app-server-mcp.ts";

export type LocalMcpTool = {
	name: string;
	description?: string;
	inputSchema?: unknown;
};

const execFileAsync = promisify(execFile);

export type ConfiguredMcpServer = {
	name: string;
	enabled: boolean;
};

export async function discoverConfiguredMcpServers(): Promise<ConfiguredMcpServer[]> {
	try {
		const { stdout } = await execFileAsync(resolveCodexCliPath(), ["mcp", "list", "--json"], {
			env: process.env,
			timeout: 2000,
		});
		const entries = JSON.parse(stdout) as unknown;
		if (!Array.isArray(entries)) throw new Error("codex mcp list returned a non-array response");
		return entries.flatMap((entry): ConfiguredMcpServer[] => {
			if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.enabled !== "boolean") return [];
			return [
				{
					name: entry.name,
					enabled: entry.enabled,
				},
			];
		});
	} catch (error) {
		console.warn(
			`Codex MCP configuration discovery failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type LocalMcpManifest = {
	mcpServers?: Record<string, { command?: string; url?: string }>;
};

// Spawned servers only: an entry with a `url` instead of a `command` is a connector `discoverCodexAppsTools` already registers, so returning it would register it twice.
// Names are all that comes back, because calls go through the codex app-server, which spawns the server itself. The manifest's `command`, `env` and `env_vars` have no reader here.
export async function discoverLocalMcpServers(pluginRoot: string): Promise<string[]> {
	const manifest = await readJson<LocalMcpManifest>(join(pluginRoot, ".mcp.json"));
	return Object.entries(manifest?.mcpServers ?? {})
		.filter(([, server]) => Boolean(server.command))
		.map(([name]) => name);
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}
