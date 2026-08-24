import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_EXEC_COMMAND_SETTINGS, type ExecCommandSettings } from "../../contributions/xsettings.ts";
import { renderExecResult, renderWriteStdinCall } from "../../ui/presentation.ts";
import { type ExecToolPresentationDetails, normalizeWriteStdinArguments } from "../presentation.ts";
import { createExecToolResult } from "../result.ts";
import type { ExecRuntime } from "../runtime.ts";
import { executeWriteStdin } from "./execute.ts";

function writeStdinParameters(settings: Pick<ExecCommandSettings, "defaultOutputTokens">) {
	return Type.Object({
		session_id: Type.Number({ description: "Identifier of the running unified exec session." }),
		chars: Type.Optional(
			Type.String({ description: "Bytes to write to stdin. Defaults to empty, which polls without writing." }),
		),
		yield_time_ms: Type.Optional(
			Type.Number({
				description:
					"Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 30000-300000 ms by default.",
			}),
		),
		max_output_tokens: Type.Optional(
			Type.Number({
				description: `Output token budget. Defaults to ${settings.defaultOutputTokens} tokens; larger requests may be capped by policy.`,
				default: settings.defaultOutputTokens,
			}),
		),
	});
}

export const WRITE_STDIN_PARAMETERS = writeStdinParameters(DEFAULT_EXEC_COMMAND_SETTINGS);

export function createWriteStdinTool(
	runtime: ExecRuntime,
	settings: Pick<ExecCommandSettings, "defaultOutputTokens"> = DEFAULT_EXEC_COMMAND_SETTINGS,
): ToolDefinition<typeof WRITE_STDIN_PARAMETERS, ExecToolPresentationDetails> {
	return {
		name: "write_stdin",
		label: "write_stdin",
		description: "Writes characters to an existing unified exec session and returns recent output.",
		parameters: writeStdinParameters(settings),
		renderShell: "self",
		renderCall(args, theme, context) {
			return renderWriteStdinCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderExecResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			const manager = runtime.getManager();
			const command = manager.getSessionCommand(params.session_id);
			const tty = manager.getSessionTty?.(params.session_id) ?? true;
			onUpdate?.(
				createExecToolResult({
					tool: "write_stdin",
					phase: "partial",
					arguments: normalizeWriteStdinArguments(params, tty),
					command,
				}),
			);
			const execution = await executeWriteStdin(runtime, params, signal, (progress) => {
				onUpdate?.(
					createExecToolResult({
						tool: "write_stdin",
						phase: "partial",
						arguments: progress.arguments,
						command: progress.command,
						result: progress.result,
					}),
				);
			});
			return createExecToolResult({
				tool: "write_stdin",
				phase: "final",
				arguments: execution.arguments,
				command: execution.command,
				result: execution.result,
			});
		},
	};
}
