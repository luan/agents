import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getCodexNativeSettings } from "./xsettings.ts";
import { conversationToolAllowed } from "../provider/conversation-policy.ts";

export const MODEL_TOOL_POLICY = Symbol.for("pi-model-tool-policy/v1");
export interface ModelToolPolicy {
	protocol: "pi-model-tool-policy/v1";
	version: 1;
	allows(sessionId: string, toolName: string): boolean | undefined;
}
export function isNonRootAgent(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "session.identity/v1" &&
			entry.data &&
			typeof entry.data === "object" &&
			"agentName" in entry.data &&
			entry.data.agentName !== "/root",
	);
}
export function registerModelToolPolicy(pi: Pick<ExtensionAPI, "on">): () => void {
	let context: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
	});
	pi.on("model_select", (_event, ctx) => {
		context = ctx;
	});
	const slots = globalThis as Record<symbol, PolicyValue>;
	const candidate = slots[MODEL_TOOL_POLICY];
	const previous = isModelToolPolicy(candidate) ? candidate : undefined;
	const policy: ModelToolPolicy = {
		protocol: "pi-model-tool-policy/v1",
		version: 1,
		allows(sessionId, toolName) {
			if (context?.sessionManager.getSessionId() !== sessionId || context.model?.api !== "openai-codex-responses")
				return previous?.allows(sessionId, toolName);
			return conversationToolAllowed(
				toolName,
				context.model.id,
				isNonRootAgent(context.sessionManager.getBranch()),
				getCodexNativeSettings(sessionId),
			);
		},
	};
	slots[MODEL_TOOL_POLICY] = policy;
	return () => {
		context = undefined;
		if (slots[MODEL_TOOL_POLICY] === policy) slots[MODEL_TOOL_POLICY] = previous;
	};
}

// type-boundary: optional model policy installed by another extension realm; validate its structural contract before chaining.
type PolicyValue = unknown;
function isModelToolPolicy(value: PolicyValue): value is ModelToolPolicy {
	if (!value || typeof value !== "object") return false;
	const policy = value as Partial<ModelToolPolicy>;
	return policy.protocol === "pi-model-tool-policy/v1" && policy.version === 1 && typeof policy.allows === "function";
}
