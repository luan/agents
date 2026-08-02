import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";

const REGISTRY_VERSION = 1;

export type PersistedAgent = Omit<AgentRecord, "abortController" | "outputCleanup" | "promise" | "runtime" | "session">;

type Registry = {
	version: typeof REGISTRY_VERSION;
	agents: PersistedAgent[];
};

function registryDir(rootSessionId: string): string {
	return join(getAgentDir(), "sessions", "subagents", rootSessionId);
}

export function childSessionDir(rootSessionId: string, agentId: string): string {
	return join(registryDir(rootSessionId), "sessions", encodeURIComponent(agentId));
}

export function registryPath(rootSessionId: string): string {
	return join(registryDir(rootSessionId), "registry.json");
}

export function toPersistedAgent(record: AgentRecord): PersistedAgent {
	const { abortController: _, outputCleanup: __, promise: ___, runtime: ____, session: _____, ...persisted } = record;
	return persisted;
}

export function readAgentRegistry(rootSessionId: string): PersistedAgent[] {
	const path = registryPath(rootSessionId);
	if (!existsSync(path)) return [];
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Registry;
		if (data.version !== REGISTRY_VERSION || !Array.isArray(data.agents)) return [];
		return data.agents;
	} catch {
		return [];
	}
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
