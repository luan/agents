// type-boundary: optional provider-owned pi-model-tool-policy/v1 capability; validate its version and callable surface.
type PolicyValue = unknown;
interface ModelToolPolicy {
	protocol: "pi-model-tool-policy/v1";
	version: 1;
	allows(sessionId: string, toolName: string): boolean | undefined;
}
export function requireModelTool(sessionId: string, toolName: string): void {
	const value = (globalThis as Record<symbol, PolicyValue>)[Symbol.for("pi-model-tool-policy/v1")];
	if (!value || typeof value !== "object") return;
	const policy = value as Partial<ModelToolPolicy>;
	if (policy.protocol !== "pi-model-tool-policy/v1" || policy.version !== 1 || typeof policy.allows !== "function")
		return;
	if (policy.allows(sessionId, toolName) === false)
		throw new Error(`${toolName} is not enabled for this model and session`);
}
