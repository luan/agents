import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const CONTEXT_WINDOW_PROTOCOL = "pi-context/window/v1";
const KEY = Symbol.for(CONTEXT_WINDOW_PROTOCOL);
export interface ContextWindowSnapshot {
	id: string;
	boundaryEntryId: string;
	checkpoint: string;
	providerCheckpoint?: string;
}
export interface ContextWindowProvider {
	snapshot(sessionId: string): ContextWindowSnapshot | undefined;
	project(sessionId: string, messages: AgentMessage[]): AgentMessage[];
	entries(sessionId: string): readonly SessionEntry[] | undefined;
}
interface Registry extends ContextWindowProvider {
	protocol: typeof CONTEXT_WINDOW_PROTOCOL;
	version: 1;
	register(provider: ContextWindowProvider): () => void;
}
// type-boundary: shared capabilities may originate in another extension realm; validate their public methods once.
type CapabilityValue = unknown;
function registry(): Registry {
	const slots = globalThis as Record<symbol, CapabilityValue>;
	const value = slots[KEY];
	if (value && typeof value === "object") {
		const candidate = value as Partial<Registry>;
		if (
			candidate.protocol === CONTEXT_WINDOW_PROTOCOL &&
			candidate.version === 1 &&
			typeof candidate.register === "function" &&
			typeof candidate.snapshot === "function" &&
			typeof candidate.project === "function" &&
			typeof candidate.entries === "function"
		)
			return candidate as Registry;
	}
	const providers = new Set<ContextWindowProvider>();
	const created: Registry = {
		protocol: CONTEXT_WINDOW_PROTOCOL,
		version: 1,
		snapshot: (id) => [...providers].map((provider) => provider.snapshot(id)).find(Boolean),
		project(id, messages) {
			for (const provider of providers) if (provider.entries(id)) return provider.project(id, messages);
			return messages;
		},
		entries: (id) => [...providers].map((provider) => provider.entries(id)).find(Boolean),
		register(provider) {
			providers.add(provider);
			return () => {
				providers.delete(provider);
			};
		},
	};
	slots[KEY] = created;
	return created;
}
export function registerContextWindowProvider(provider: ContextWindowProvider): () => void {
	return registry().register(provider);
}
export function getContextWindow(sessionId: string): ContextWindowSnapshot | undefined {
	return registry().snapshot(sessionId);
}
