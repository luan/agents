import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROTOCOL = "pi-context/checkpoint/v1";
const KEY = Symbol.for(PROTOCOL);
export type PrepareCheckpoint = (
	ctx: ExtensionContext,
	messages: AgentMessage[],
	signal: AbortSignal,
) => Promise<string | undefined>;
interface Registry {
	protocol: typeof PROTOCOL;
	version: 1;
	prepare: PrepareCheckpoint;
	register(prepare: PrepareCheckpoint): () => void;
}
// type-boundary: optional checkpoint registry shared across extension realms; validate its version and callable surface.
type CapabilityValue = unknown;
export function registerContextCheckpoint(prepare: PrepareCheckpoint): () => void {
	const slots = globalThis as Record<symbol, CapabilityValue>;
	const candidate = slots[KEY] as Partial<Registry> | undefined;
	let registry: Registry;
	if (
		candidate?.protocol === PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.prepare === "function" &&
		typeof candidate.register === "function"
	) {
		registry = candidate as Registry;
	} else {
		const providers = new Set<PrepareCheckpoint>();
		registry = {
			protocol: PROTOCOL,
			version: 1,
			async prepare(ctx, messages, signal) {
				for (const provider of providers) {
					const result = await provider(ctx, messages, signal);
					if (result !== undefined) return result;
				}
			},
			register(provider) {
				providers.add(provider);
				return () => {
					providers.delete(provider);
				};
			},
		};
		slots[KEY] = registry;
	}
	return registry.register(prepare);
}
