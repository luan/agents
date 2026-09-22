import { createHash } from "node:crypto";
import type { AcquiredWebSocket, ProviderEnv, SessionWebSocketCacheEntry, WebSocketLike } from "./types.ts";
import {
	closeWebSocketSilently,
	connectWebSocket,
	isWebSocketReusable,
	resolveWebSocketProxyForTarget,
} from "./websocket-connection.ts";
import { clearCanonicalSessions } from "./session-continuity.ts";

const websocketSessionCache = new Map<string, Map<string, SessionWebSocketCacheEntry>>();
const websocketSseFallbackSessions = new Set<string>();
const CONTINUATION_HEADERS = new Set([
	"openai-beta",
	"session-id",
	"thread-id",
	"x-client-request-id",
	"x-codex-beta-features",
]);

function routeIdentityHeaders(headers: Headers): [string, string][] {
	return [...headers.entries()]
		.filter(([name]) => !CONTINUATION_HEADERS.has(name.toLowerCase()))
		.sort(([left], [right]) => left.localeCompare(right));
}

async function websocketRouteKey(
	url: string,
	headers: Headers,
	accountId: string,
	env: ProviderEnv | undefined,
): Promise<string> {
	const proxy = await resolveWebSocketProxyForTarget(url, env);
	const handshakeIdentity = JSON.stringify([
		accountId,
		new URL(url).href,
		proxy ?? null,
		routeIdentityHeaders(headers),
	]);
	return createHash("sha256").update(handshakeIdentity).digest("base64url");
}

export function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

export function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (sessionId) websocketSseFallbackSessions.add(sessionId);
}

function closeWebSocketSessions(sessionId: string | undefined): void {
	const closeEntry = (entry: SessionWebSocketCacheEntry) => {
		closeWebSocketSilently(entry.socket, 1000, "session_shutdown");
	};

	if (sessionId) {
		for (const entry of websocketSessionCache.get(sessionId)?.values() ?? []) closeEntry(entry);
		websocketSessionCache.delete(sessionId);
		return;
	}

	for (const routeEntries of websocketSessionCache.values()) {
		for (const entry of routeEntries.values()) closeEntry(entry);
	}
	websocketSessionCache.clear();
}

export function resetOpenAICodexWebSocketSessions(sessionId?: string): void {
	closeWebSocketSessions(sessionId);
	clearCanonicalSessions(sessionId);
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	closeWebSocketSessions(sessionId);
	clearCanonicalSessions(sessionId);
	if (sessionId) {
		websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	websocketSseFallbackSessions.clear();
}

function transientConnection(socket: WebSocketLike): AcquiredWebSocket {
	return { socket, reused: false, release: () => closeWebSocketSilently(socket) };
}

function retainedConnection(
	entry: SessionWebSocketCacheEntry,
	sessionId: string,
	routeKey: string,
	reused: boolean,
): AcquiredWebSocket {
	entry.busy = true;
	let released = false;
	return {
		socket: entry.socket,
		entry,
		reused,
		release: ({ keep } = {}) => {
			if (released) return;
			released = true;
			const entries = websocketSessionCache.get(sessionId);
			const owned = entries?.get(routeKey) === entry;
			if (keep && owned && isWebSocketReusable(entry.socket)) {
				entry.busy = false;
				return;
			}
			closeWebSocketSilently(entry.socket);
			if (owned) entries.delete(routeKey);
			if (entries?.size === 0) websocketSessionCache.delete(sessionId);
		},
	};
}

export async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	accountId: string,
	signal: AbortSignal | undefined,
	connectTimeoutMs?: number,
	env?: ProviderEnv,
): Promise<AcquiredWebSocket> {
	if (signal?.aborted) throw new Error("Request was aborted");
	if (!sessionId) return transientConnection(await connectWebSocket(url, headers, signal, connectTimeoutMs, env));

	const routeKey = await websocketRouteKey(url, headers, accountId, env);
	if (signal?.aborted) throw new Error("Request was aborted");
	let entries = websocketSessionCache.get(sessionId);
	const cached = entries?.get(routeKey);
	if (cached && !cached.busy) {
		if (isWebSocketReusable(cached.socket)) return retainedConnection(cached, sessionId, routeKey, true);
		closeWebSocketSilently(cached.socket);
		entries?.delete(routeKey);
	}

	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
	entries = websocketSessionCache.get(sessionId);
	// Another concurrent acquisition may have established the retained lane while this one connected.
	if (entries?.has(routeKey)) return transientConnection(socket);
	if (!entries) {
		entries = new Map();
		websocketSessionCache.set(sessionId, entries);
	}
	const entry: SessionWebSocketCacheEntry = { socket, busy: true };
	entries.set(routeKey, entry);
	return retainedConnection(entry, sessionId, routeKey, false);
}
