import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CodeModeSettings, DEFAULT_CODE_MODE_SETTINGS } from "../../contributions/xsettings.ts";
import { DEFAULT_CODE_MODE_OUTPUT_TOKENS, MAX_CODE_MODE_OUTPUT_TOKENS } from "../../host/protocol.ts";
import type { CodeModeToolDetails } from "../../protocol/types.ts";
import type { CodeModeRuntime } from "../../runtime/code-mode.ts";
import { renderCodeModeCall, renderCodeModeResult } from "../../ui/presentation.ts";
import { toCodeModeToolResult } from "../result.ts";

function waitParameters(defaultWaitYieldMs: number, defaultOutputTokens: number) {
	return Type.Object({
		cell_id: Type.String({ description: "Identifier of the running exec cell." }),
		yield_time_ms: Type.Optional(
			Type.Integer({
				minimum: 0,
				default: defaultWaitYieldMs,
				description: `Wait before yielding more output. Defaults to ${defaultWaitYieldMs} ms.`,
			}),
		),
		max_tokens: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_CODE_MODE_OUTPUT_TOKENS,
				default: defaultOutputTokens,
				description: `Output token budget for this wait call. Defaults to ${defaultOutputTokens} tokens.`,
			}),
		),
		terminate: Type.Optional(
			Type.Boolean({ description: "True stops the running exec cell; false or omitted waits for output." }),
		),
	});
}

const WAIT_PARAMETERS = waitParameters(10_000, DEFAULT_CODE_MODE_OUTPUT_TOKENS);

export function createWaitTool(
	runtime: CodeModeRuntime,
	settings: Pick<CodeModeSettings, "defaultWaitYieldMs" | "defaultOutputTokens"> = DEFAULT_CODE_MODE_SETTINGS,
): ToolDefinition<typeof WAIT_PARAMETERS, CodeModeToolDetails> {
	return {
		name: "wait",
		label: "wait",
		description: `Waits on a yielded \`exec\` cell and returns new output or completion.
- Use \`wait\` only after \`exec\` returns \`Script running with cell ID ...\`.
- \`cell_id\` identifies the running \`exec\` cell to resume.
- \`yield_time_ms\` controls how long to wait for more output before yielding again. Defaults to ${settings.defaultWaitYieldMs} ms.
- \`max_tokens\` limits how much new output this wait call returns. Defaults to ${settings.defaultOutputTokens} tokens.
- \`terminate: true\` stops the running cell; false or omitted waits for output.
- \`wait\` returns only the new output since the last yield, or the final completion or termination result for that cell.
- If the cell is still running, \`wait\` may yield again with the same \`cell_id\`.
- If the cell has already finished, \`wait\` returns the completed result and closes the cell.`,
		parameters: waitParameters(settings.defaultWaitYieldMs, settings.defaultOutputTokens),
		renderShell: "self",
		renderCall(args, theme, context) {
			return renderCodeModeCall("wait", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderCodeModeResult(result, options, theme, context);
		},
		async execute(id, params, signal, onUpdate, ctx) {
			const startedAtMs = Date.now();
			const input = {
				cell_id: params.cell_id,
				yield_time_ms: params.yield_time_ms ?? settings.defaultWaitYieldMs,
				max_tokens: params.max_tokens ?? settings.defaultOutputTokens,
				terminate: params.terminate ?? false,
			};
			const context = runtime.context(ctx, id, onUpdate, {
				tool: "wait",
				input,
				startedAtMs,
				maxOutputTokens: input.max_tokens,
			});
			const response = params.terminate
				? await runtime.getClient().terminate(params.cell_id, context, signal)
				: await runtime
						.getClient()
						.wait(params.cell_id, params.yield_time_ms ?? settings.defaultWaitYieldMs, context, signal);
			return toCodeModeToolResult(response, {
				requestedTokens: input.max_tokens,
				tool: "wait",
				input,
				startedAtMs,
			});
		},
	};
}
