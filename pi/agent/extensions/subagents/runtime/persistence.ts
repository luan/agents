import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgentRecord, agentKey } from "./types.js";

const REGISTRY_VERSION = 1;
export const MAX_RETAINED_TERMINAL_AGENTS = 100;
export const TERMINAL_AGENT_RETENTION_MS = 10 * 60_000;
const REGISTRY_LOCK_TIMEOUT_MS = 2_000;
const STALE_REGISTRY_LOCK_MS = 30_000;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

export type PersistedAgent = Omit<
	AgentRecord,
	"abortController" | "attachedRuntime" | "outputCleanup" | "promise" | "runtime" | "session"
>;

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

export function retainAgentRecords<T extends PersistedAgent>(
	records: T[],
	maxRetained = MAX_RETAINED_TERMINAL_AGENTS,
	now = Date.now(),
): T[] {
	const cutoff = now - TERMINAL_AGENT_RETENTION_MS;
	const retainedTerminal = new Set(
		records
			.filter((record) => record.status !== "running" && record.status !== "queued")
			.sort((left, right) => (right.completedAt ?? right.startedAt) - (left.completedAt ?? left.startedAt))
			.filter((record, index) => index < maxRetained && (record.completedAt ?? record.startedAt) >= cutoff),
	);
	return records.filter(
		(record) => record.status === "running" || record.status === "queued" || retainedTerminal.has(record),
	);
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

function registryPath(rootSessionId: string, root = registryRoot()): string {
	return join(root, rootSessionId, "registry.json");
}

export function toPersistedAgent(record: AgentRecord): PersistedAgent {
	const {
		abortController: _,
		attachedRuntime: __,
		outputCleanup: ___,
		promise: ____,
		runtime: _____,
		session: ______,
		...persisted
	} = record;
	return persisted;
}

function withRegistryLock<T>(path: string, action: () => T): T {
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
	let lock: number;
	for (;;) {
		try {
			lock = openSync(lockPath, "wx", 0o600);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > STALE_REGISTRY_LOCK_MS) unlinkSync(lockPath);
			} catch {}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for agent registry lock: ${path}`);
			Atomics.wait(lockWait, 0, 0, 10);
		}
	}
	try {
		return action();
	} finally {
		closeSync(lock);
		try {
			unlinkSync(lockPath);
		} catch {}
	}
}

function writeRegistryUnlocked(path: string, agents: PersistedAgent[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp`;
	const registry: Registry = { version: REGISTRY_VERSION, agents };
	writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporaryPath, path);
}

export function readAgentRegistry(rootSessionId: string): PersistedAgent[] {
	return readRegistry(registryPath(rootSessionId));
}

export function readRetainedAgentRegistries(
	root = registryRoot(),
	maxRetained = MAX_RETAINED_TERMINAL_AGENTS,
	now = Date.now(),
): PersistedAgent[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isDirectory()) return [];
		const path = join(root, entry.name, "registry.json");
		try {
			return withRegistryLock(path, () => {
				const records = readRegistry(path);
				const retained = retainAgentRecords(records, maxRetained, now);
				if (retained.length !== records.length) writeRegistryUnlocked(path, retained);
				return retained;
			});
		} catch {
			return readRegistry(path);
		}
	});
}

export function writeAgentRegistry(rootSessionId: string, records: Iterable<AgentRecord>, root = registryRoot()): void {
	const incoming = [...records].filter((record) => record.rootSessionId === rootSessionId);
	const path = registryPath(rootSessionId, root);
	withRegistryLock(path, () => {
		const agents = new Map(readRegistry(path).map((record) => [agentKey(rootSessionId, record.id), record]));
		for (const record of incoming) {
			const key = agentKey(rootSessionId, record.id);
			agents.set(key, { ...agents.get(key), ...toPersistedAgent(record) });
		}
		writeRegistryUnlocked(path, [...agents.values()]);
	});
}

export function removeAgentRegistryRecord(rootSessionId: string, id: string, root = registryRoot()): void {
	const path = registryPath(rootSessionId, root);
	withRegistryLock(path, () => {
		const agents = readRegistry(path).filter((record) => record.id !== id);
		writeRegistryUnlocked(path, agents);
	});
}
