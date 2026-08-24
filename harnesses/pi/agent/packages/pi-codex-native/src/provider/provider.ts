import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodexProviderRuntime } from "./runtime.ts";

let registeredRuntime: CodexProviderRuntime | undefined;

export function registerOpenAICodexProvider(pi: ExtensionAPI): CodexProviderRuntime {
	const runtime = new CodexProviderRuntime();
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
