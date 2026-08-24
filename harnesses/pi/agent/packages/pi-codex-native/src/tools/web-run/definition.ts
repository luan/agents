import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveWebRunBinary, runWebRunBinary } from "./native.ts";
import { renderWebRunCall, renderWebRunResult } from "./presentation.ts";
import { createWebRunResult, type WebRunToolDetails } from "./result.ts";
import { WEB_RUN_SCHEMA, type WebRunParameters } from "./schema.ts";

export { resolveWebRunBinary } from "./native.ts";
export type { WebRunResult, WebRunToolDetails } from "./result.ts";

export const WEB_RUN_TOOL_NAME = "web__run";

function assertCodexModel(ctx: ExtensionContext): string {
	const model = ctx.model;
	if (!model || model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
		throw new Error("web__run requires an openai-codex model with the openai-codex-responses API");
	}
	if (!model.id.trim()) throw new Error("The openai-codex model has no model id");
	return model.id;
}

export function createWebRunTool(): ToolDefinition<typeof WEB_RUN_SCHEMA, WebRunToolDetails> {
	return {
		name: WEB_RUN_TOOL_NAME,
		label: WEB_RUN_TOOL_NAME,
		description:
			"Search and inspect the web, images, finance, weather, sports, and time. Use this when current web information or direct source attribution is required.",
		parameters: WEB_RUN_SCHEMA,
		prepareArguments: (args) => (args && typeof args === "object" ? (args as WebRunParameters) : {}),
		renderShell: "self",
		renderCall(params, theme, context) {
			return renderWebRunCall(params as WebRunParameters, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderWebRunResult(result, theme, context, options.expanded);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const startedAtMs = Date.now();
			const model = assertCodexModel(ctx);
			const binary = resolveWebRunBinary();
			const sessionId = ctx.sessionManager?.getSessionId?.();
			const input = { ...(params as WebRunParameters), ...(sessionId ? { id: sessionId } : {}), model };
			const stdout = await runWebRunBinary(binary, input, signal);
			return createWebRunResult({
				stdout,
				request: params as WebRunParameters,
				model,
				...(sessionId ? { sessionId } : {}),
				startedAtMs,
			});
		},
	};
}
