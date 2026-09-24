import type { ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

// Session identity is a persisted, provider-independent contract used by context recovery and user interaction extensions.
const ENTRY = "session.identity/v1";
// type-boundary: parent session custom entries are untyped; only the root identity is copied after validation.
type IdentityValue = unknown;
function rootId(entries: readonly SessionEntry[], fallback: string): string {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const value: IdentityValue = entry.data;
		if (value && typeof value === "object" && "rootSessionId" in value && typeof value.rootSessionId === "string")
			return value.rootSessionId;
	}
	return fallback;
}
export function appendAgentIdentity(
	manager: SessionManager,
	parent: ExtensionContext,
	agentName: string,
	interactive: boolean,
): void {
	manager.appendCustomEntry(ENTRY, {
		version: 1,
		rootSessionId: rootId(parent.sessionManager.getBranch(), parent.sessionManager.getSessionId()),
		agentName,
		rootSessionFile: rootFile(parent.sessionManager.getBranch()) ?? parent.sessionManager.getSessionFile(),
		interactive,
	});
}

function rootFile(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const value: IdentityValue = entry.data;
		if (value && typeof value === "object" && "rootSessionFile" in value && typeof value.rootSessionFile === "string")
			return value.rootSessionFile;
	}
}
