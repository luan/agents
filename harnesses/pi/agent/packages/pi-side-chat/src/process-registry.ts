import type { PtyProcess } from "pi-libtui";

const PROCESS_REGISTRY_KEY = Symbol.for("pi-side-chat/process-registry/v1");

interface ProcessRegistry {
	readonly version: 1;
	readonly sessions: Map<string, Map<string, PtyProcess>>;
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator narrows the registry.
type UntrustedRegistryValue = unknown;

function isProcessRegistry(value: UntrustedRegistryValue): value is ProcessRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ProcessRegistry>;
	return candidate.version === 1 && candidate.sessions instanceof Map;
}

export function claimSideChatProcesses(
	sessionKey: string,
	scope: typeof globalThis = globalThis,
): readonly [Map<string, PtyProcess>, () => void] {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[PROCESS_REGISTRY_KEY];
	const registry: ProcessRegistry = isProcessRegistry(existing) ? existing : { version: 1, sessions: new Map() };
	if (registry !== existing) slots[PROCESS_REGISTRY_KEY] = registry;
	let processes = registry.sessions.get(sessionKey);
	if (!processes) {
		processes = new Map();
		registry.sessions.set(sessionKey, processes);
	}
	return [processes, () => registry.sessions.delete(sessionKey)];
}
