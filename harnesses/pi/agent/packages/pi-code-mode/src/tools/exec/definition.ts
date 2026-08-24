import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CodeModeSettings, DEFAULT_CODE_MODE_SETTINGS } from "../../contributions/xsettings.ts";
import type { CodeModeToolDetails } from "../../protocol/types.ts";
import type { CodeModeRuntime } from "../../runtime/code-mode.ts";
import { renderCodeModeCall, renderCodeModeResult } from "../../ui/presentation.ts";
import { toCodeModeToolResult } from "../result.ts";
import { buildExecDescription } from "./description.ts";
import { EXEC_CONSTRAINED_SAMPLING } from "./grammar.ts";

export { buildExecDescription } from "./description.ts";

const EXEC_PARAMETERS = Type.Object({
	code: Type.String({ description: "JavaScript source. Do not include JSON wrappers or Markdown fences." }),
});

export function createExecTool(
	runtime: CodeModeRuntime,
	settings: Pick<CodeModeSettings, "defaultExecYieldMs" | "defaultOutputTokens"> = DEFAULT_CODE_MODE_SETTINGS,
): ToolDefinition<typeof EXEC_PARAMETERS, CodeModeToolDetails> {
	return {
		name: "exec",
		label: "exec",
		description: buildExecDescription([], settings),
		parameters: EXEC_PARAMETERS,
		constrainedSampling: EXEC_CONSTRAINED_SAMPLING,
		renderShell: "self",
		renderCall(args, theme, context) {
			return renderCodeModeCall("exec", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderCodeModeResult(result, options, theme, context);
		},
		async execute(id, params, signal, onUpdate, ctx) {
			const startedAtMs = Date.now();
			const response = await runtime.getClient().execute(
				params.code,
				runtime.context(ctx, id, onUpdate, {
					tool: "exec",
					input: { code: params.code },
					startedAtMs,
					maxOutputTokens: settings.defaultOutputTokens,
				}),
				runtime.collectAdapters(),
				signal,
				{ yieldTimeMs: settings.defaultExecYieldMs, maxOutputTokens: settings.defaultOutputTokens },
			);
			return toCodeModeToolResult(response, { tool: "exec", input: { code: params.code }, startedAtMs });
		},
	};
}
