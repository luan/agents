import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodexProviderRuntime } from "./runtime.ts";
import { REASONING_ENTRY } from "./reasoning-updates.ts";
import { PERSISTENT_ENTRY } from "./persistent-mode.ts";

let registeredRuntime: CodexProviderRuntime | undefined;

export function registerOpenAICodexProvider(pi: ExtensionAPI): CodexProviderRuntime {
	let activeSessionId: string | undefined;
	pi.on("session_start", (_event, ctx) => {
		activeSessionId = ctx.sessionManager.getSessionId();
	});
	pi.on("session_shutdown", () => {
		activeSessionId = undefined;
	});
	const runtime = new CodexProviderRuntime({
		recordReasoningContext: (sessionId, entry) => {
			if (sessionId !== activeSessionId) throw new Error("Reasoning configuration belongs to a different Pi session");
			pi.appendEntry(REASONING_ENTRY, entry);
		},
		recordPersistentContext: (sessionId, entry) => {
			if (sessionId !== activeSessionId) throw new Error("Persistent context belongs to a different Pi session");
			pi.appendEntry(PERSISTENT_ENTRY, entry);
		},
	});
	registeredRuntime = runtime;
	pi.registerProvider(runtime.provider);
	return runtime;
}

export function closeOpenAICodexProvider(): void {
	registeredRuntime?.shutdown();
}

export { CodexProviderRuntime } from "./runtime.ts";
export type {
	CodexCompactionPrewarmInput,
	CodexRuntimePlan,
	CodexRuntimeState,
	CodexProviderRuntimeOptions,
} from "./runtime.ts";
export { buildRequestBody } from "./request-body.ts";
export { parseSSE } from "./sse.ts";
export { buildCachedWebSocketRequestBody } from "./websocket-continuation.ts";
export type { ResponsesBody } from "./types.ts";
