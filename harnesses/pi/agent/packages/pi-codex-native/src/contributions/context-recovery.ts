import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface WindowSnapshot {
	id: string;
	boundaryEntryId: string;
	checkpoint: string;
	providerCheckpoint?: string;
}
interface WindowRegistry {
	protocol: "pi-context/window/v1";
	version: 1;
	entries(sessionId: string): readonly SessionEntry[] | undefined;
	snapshot(sessionId: string): WindowSnapshot | undefined;
}
// type-boundary: optional context-window capability from an independently installed extension; validate the version and callable surface.
type CapabilityValue = unknown;
function registry(): WindowRegistry | undefined {
	const value = (globalThis as Record<symbol, CapabilityValue>)[Symbol.for("pi-context/window/v1")];
	if (!value || typeof value !== "object") return;
	const candidate = value as Partial<WindowRegistry>;
	if (
		candidate.protocol === "pi-context/window/v1" &&
		candidate.version === 1 &&
		typeof candidate.entries === "function" &&
		typeof candidate.snapshot === "function"
	)
		return candidate as WindowRegistry;
}
export function contextRecoveryActive(sessionId: string): boolean {
	return registry()?.entries(sessionId) !== undefined;
}
export function recoveryWindow(sessionId: string | undefined): WindowSnapshot | undefined {
	return sessionId ? registry()?.snapshot(sessionId) : undefined;
}
export function verifyRecoveryRequest(sessionId: string | undefined, input: readonly CapabilityValue[]): void {
	const window = recoveryWindow(sessionId);
	if (!window) return;
	if (!JSON.stringify(input).includes(`Current window: ${window.id}`))
		throw new Error("Context window recovery failed; refusing to send stale conversation history");
}
