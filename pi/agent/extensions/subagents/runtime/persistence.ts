import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";

const REGISTRY_VERSION = 1;

export type PersistedAgent = Omit<AgentRecord, "abortController" | "outputCleanup" | "promise" | "runtime" | "session">;

type Registry = {
	version: typeof REGISTRY_VERSION;
	agents: PersistedAgent[];
};
function readRegistry(path: string): PersistedAgent[] {
	if (!existsSync(path)) return [];
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Registry;
		return data.version === REGISTRY_VERSION && Array.isArray(data.agents) ? data.agents : [];
	} catch {
		return [];
	}
}

function registryRoot(): string {
	return join(getAgentDir(), "sessions", "subagents");
}

function registryDir(rootSessionId: string): string {
	return join(registryRoot(), rootSessionId);
}

export function childSessionDir(rootSessionId: string, agentId: string): string {
	return join(registryDir(rootSessionId), "sessions", encodeURIComponent(agentId));
}

function registryPath(rootSessionId: string): string {
	return join(registryDir(rootSessionId), "registry.json");
}

export function toPersistedAgent(record: AgentRecord): PersistedAgent {
	const { abortController: _, outputCleanup: __, promise: ___, runtime: ____, session: _____, ...persisted } = record;
	return persisted;
}

export function readAgentRegistry(rootSessionId: string): PersistedAgent[] {
	return readRegistry(registryPath(rootSessionId));
}

export function readAllAgentRegistries(root = registryRoot()): PersistedAgent[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? readRegistry(join(root, entry.name, "registry.json")) : [],
	);
}

export function writeAgentRegistry(rootSessionId: string, records: Iterable<AgentRecord>): void {
	const dir = registryDir(rootSessionId);
	mkdirSync(dir, { recursive: true });
	const path = registryPath(rootSessionId);
	const temporaryPath = `${path}.tmp`;
	const registry: Registry = {
		version: REGISTRY_VERSION,
		agents: [...records].filter((record) => record.rootSessionId === rootSessionId).map(toPersistedAgent),
	};
	writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporaryPath, path);
}
