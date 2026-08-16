import type { ArtifactSession } from "../../shared/artifact-store.ts";
import { activeSessionId } from "../../shared/session-context.ts";

// Jiti evaluates this module per importer. One global map keeps those copies consistent without mixing in-process sessions.
const ARTIFACT_SESSIONS = Symbol.for("agents.artifactSessions");
const globalState = globalThis as typeof globalThis & {
	[ARTIFACT_SESSIONS]?: Map<string, ArtifactSession>;
};
const sessions = globalState[ARTIFACT_SESSIONS] ?? new Map<string, ArtifactSession>();
globalState[ARTIFACT_SESSIONS] = sessions;

function sessionKey(sessionId?: string): string | undefined {
	return sessionId || activeSessionId();
}

export function getCurrentArtifactSessionId(sessionId?: string): string | undefined {
	return sessionKey(sessionId) && getCurrentArtifactSession(sessionId).sessionId;
}

export function getCurrentArtifactSession(sessionId?: string): ArtifactSession {
	const key = sessionKey(sessionId);
	return key ? (sessions.get(key) ?? {}) : {};
}

export function setCurrentArtifactSession(session: ArtifactSession, sessionId = session.sessionId): void {
	const key = sessionKey(sessionId);
	if (key) sessions.set(key, { ...session, sessionId: key });
}

export function clearCurrentArtifactSession(sessionId?: string): void {
	const key = sessionKey(sessionId);
	if (key) sessions.delete(key);
}
