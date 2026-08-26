export const SESSION_HIERARCHY_PROTOCOL = "pi-subagents/session-hierarchy/v1" as const;
export const SESSION_HIERARCHY = Symbol.for(SESSION_HIERARCHY_PROTOCOL);

export interface SessionHierarchyEntry {
	readonly sessionId: string;
	readonly path: string;
}

export type SessionHierarchyProvider = (sessionId: string) => readonly SessionHierarchyEntry[] | undefined;

interface SessionHierarchyRegistry {
	readonly protocol: typeof SESSION_HIERARCHY_PROTOCOL;
	readonly version: 1;
	descendants(sessionId: string): readonly SessionHierarchyEntry[] | undefined;
	register(provider: SessionHierarchyProvider): () => void;
}

// type-boundary: Symbol.for can contain a value from another extension realm; this validator narrows the capability.
type UntrustedRegistryValue = unknown;

function isRegistry(value: UntrustedRegistryValue): value is SessionHierarchyRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SessionHierarchyRegistry>;
	return (
		candidate.protocol === SESSION_HIERARCHY_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.descendants === "function" &&
		typeof candidate.register === "function"
	);
}

function registry(): SessionHierarchyRegistry {
	const slots = globalThis as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[SESSION_HIERARCHY];
	if (isRegistry(existing)) return existing;
	const providers: SessionHierarchyProvider[] = [];
	const created: SessionHierarchyRegistry = {
		protocol: SESSION_HIERARCHY_PROTOCOL,
		version: 1,
		descendants(sessionId) {
			for (const provider of providers) {
				try {
					const entries = provider(sessionId);
					if (entries) return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
				} catch {
					// A stale provider must not hide a healthy session hierarchy registered after it.
				}
			}
			return undefined;
		},
		register(provider) {
			providers.push(provider);
			return () => {
				const index = providers.lastIndexOf(provider);
				if (index >= 0) providers.splice(index, 1);
			};
		},
	};
	slots[SESSION_HIERARCHY] = created;
	return created;
}

export function registerSessionHierarchyProvider(provider: SessionHierarchyProvider): () => void {
	return registry().register(provider);
}
