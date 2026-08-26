export interface RelatedSession {
	readonly sessionId: string;
	readonly path: string;
}

interface SessionHierarchyCapability {
	readonly protocol: "pi-subagents/session-hierarchy/v1";
	readonly version: 1;
	descendants(sessionId: string): readonly RelatedSession[] | undefined;
}

const SESSION_HIERARCHY = Symbol.for("pi-subagents/session-hierarchy/v1");

// type-boundary: the optional subagent capability is an untyped global structural boundary validated here.
type UntrustedCapability = unknown;

function capability(): SessionHierarchyCapability | undefined {
	const value = (globalThis as Record<PropertyKey, UntrustedCapability>)[SESSION_HIERARCHY];
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<SessionHierarchyCapability>;
	return candidate.protocol === "pi-subagents/session-hierarchy/v1" &&
		candidate.version === 1 &&
		typeof candidate.descendants === "function"
		? (candidate as SessionHierarchyCapability)
		: undefined;
}

export function relatedSessions(sessionId: string): readonly RelatedSession[] {
	const entries = capability()?.descendants(sessionId);
	if (!entries) return [{ sessionId, path: "/root" }];
	const valid = entries.filter(
		(entry) =>
			entry &&
			typeof entry === "object" &&
			typeof entry.sessionId === "string" &&
			typeof entry.path === "string" &&
			(entry.path === "/root" || entry.path.startsWith("/root/")),
	);
	return valid.some((entry) => entry.sessionId === sessionId) ? valid : [{ sessionId, path: "/root" }];
}
