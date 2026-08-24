import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureContextWindowSourceRegistry, type ContextWindowPreset } from "pi-libcontext/sdk";

type SessionManager = ExtensionContext["sessionManager"];

export function registerRoleContextWindowSource(
	activeSessionManager: () => SessionManager | undefined,
	activePreset: () => ContextWindowPreset | undefined,
): () => void {
	try {
		return ensureContextWindowSourceRegistry().register({
			id: "pi-model-roles",
			preset: (ctx) => (ctx.sessionManager === activeSessionManager() ? activePreset() : undefined),
		});
	} catch {
		return () => {};
	}
}
