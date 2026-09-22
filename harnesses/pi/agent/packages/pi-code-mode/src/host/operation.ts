import type { CodeModeHostSession } from "./session.js";

/** Cancellation abandons this caller's wait without cancelling the shared host startup. */
export async function startSession(session: CodeModeHostSession, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	if (!signal) return session.start();
	const cancelled = Promise.withResolvers<never>();
	const abort = () => cancelled.reject(abortError());
	signal.addEventListener("abort", abort, { once: true });
	try {
		await Promise.race([session.start(), cancelled.promise]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export function cancelOperation(session: CodeModeHostSession, id: number): Error {
	const error = abortError();
	try {
		session.send({ type: "operation/cancel", id });
	} catch {
		// Host teardown is already authoritative.
	}
	session.rejectOperation(id, error);
	return error;
}

export function operationAbort(session: CodeModeHostSession, id: number): () => void {
	return () => {
		cancelOperation(session, id);
	};
}

export function abortError(): Error {
	const error = new Error("Code-mode operation aborted");
	error.name = "AbortError";
	return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
