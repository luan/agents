import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface CheckpointRegistry {
	protocol: "pi-context/checkpoint/v1";
	version: 1;
	prepare(ctx: ExtensionContext, messages: AgentMessage[], signal: AbortSignal): Promise<string | undefined>;
}
// type-boundary: optional provider checkpoint capability; validate the protocol, callable surface and opaque string result.
type CapabilityValue = unknown;
export async function prepareProviderCheckpoint(
	ctx: ExtensionContext,
	messages: AgentMessage[],
	signal: AbortSignal,
): Promise<string | undefined> {
	const value = (globalThis as Record<symbol, CapabilityValue>)[Symbol.for("pi-context/checkpoint/v1")];
	if (!value || typeof value !== "object") return;
	const registry = value as Partial<CheckpointRegistry>;
	if (
		registry.protocol !== "pi-context/checkpoint/v1" ||
		registry.version !== 1 ||
		typeof registry.prepare !== "function"
	)
		return;
	const result: CapabilityValue = await registry.prepare(ctx, messages, signal);
	if (result === undefined || typeof result === "string") return result;
	throw new Error("The provider returned an invalid context checkpoint; the outgoing window is intact");
}
