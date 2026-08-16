import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolRegistrarFor } from "../../shared/tool-registry.ts";
import { ASK_TOOL_DESCRIPTION } from "./ask-tool-helpers";
import { askToolPresentation } from "./ask-tool-presentation";
import { executeAskTool } from "./ask-tool-runtime";
import { AskParamsSchema } from "./schema";
import type { AskParams } from "./types";

export function registerAskTool(pi: ExtensionAPI) {
	toolRegistrarFor(pi)({
		name: "ask_user",
		label: "Ask User",
		...askToolPresentation,
		description: ASK_TOOL_DESCRIPTION,
		promptSnippet:
			"Clarify ambiguous or preference-sensitive decisions with a short interactive interview before proceeding",
		parameters: AskParamsSchema,
		execute: (_toolCallId, params, _signal, _onUpdate, ctx) => executeAskTool(pi, params as AskParams, ctx),
	});
}
