import { AsyncLocalStorage } from "node:async_hooks";

const SESSION_CONTEXT = Symbol.for("agents.sessionContext");
const globalState = globalThis as typeof globalThis & {
	[SESSION_CONTEXT]?: AsyncLocalStorage<string>;
};
const storage = globalState[SESSION_CONTEXT] ?? new AsyncLocalStorage<string>();
globalState[SESSION_CONTEXT] = storage;

export function sessionIdFromContext(context: unknown): string | undefined {
	const sessionManager = (context as { sessionManager?: { getSessionId?: () => unknown } } | undefined)
		?.sessionManager;
	const sessionId = sessionManager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}

export function activeSessionId(): string | undefined {
	return storage.getStore();
}

export function runInSession<T>(context: unknown, operation: () => T): T {
	const sessionId = typeof context === "string" ? context : sessionIdFromContext(context);
	return sessionId ? storage.run(sessionId, operation) : operation();
}
