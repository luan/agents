import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ActivityAnimationOverrides } from "pi-libtui";
import { Type } from "typebox";
import { DEFAULT_EXEC_COMMAND_SETTINGS, type ExecCommandSettings } from "../../contributions/xsettings.ts";
import { renderExecCommandCall, renderExecResult } from "../../ui/presentation.ts";
import type { ExecToolPresentationDetails } from "../presentation.ts";
import { createExecToolResult } from "../result.ts";
import type { ExecRuntime } from "../runtime.ts";
import { type ExecCommandPreparationRuntime, executeExecCommand, prepareExecCommandExecution } from "./execute.ts";

function execCommandParameters(
	settings: Pick<ExecCommandSettings, "defaultOutputTokens" | "defaultExecYieldMs" | "defaultLoginShell">,
) {
	return Type.Object({
		cmd: Type.String({ description: "Shell command to execute." }),
		workdir: Type.Optional(
			Type.String({ description: "Working directory for the command. Defaults to the turn cwd." }),
		),
		shell: Type.Optional(
			Type.String({
				description:
					"Shell binary to launch. Defaults to Pi's configured shell, then $SHELL; Fish falls back to a compatible POSIX shell.",
			}),
		),
		tty: Type.Optional(
			Type.Boolean({ description: "True allocates a PTY for the command; false or omitted uses plain pipes." }),
		),
		yield_time_ms: Type.Optional(
			Type.Number({
				description: `Wait before yielding output. Defaults to ${settings.defaultExecYieldMs} ms; effective range is 250-30000 ms.`,
				default: settings.defaultExecYieldMs,
			}),
		),
		max_output_tokens: Type.Optional(
			Type.Number({
				description: `Output token budget. Defaults to ${settings.defaultOutputTokens} tokens; larger requests may be capped by policy.`,
				default: settings.defaultOutputTokens,
			}),
		),
		login: Type.Optional(
			Type.Boolean({
				description: `True runs the shell with -l/-i semantics; false disables them. Defaults to ${settings.defaultLoginShell}.`,
				default: settings.defaultLoginShell,
			}),
		),
	});
}

export const EXEC_COMMAND_PARAMETERS = execCommandParameters(DEFAULT_EXEC_COMMAND_SETTINGS);

export function createExecCommandTool(
	runtime: ExecRuntime,
	preparationRuntime: ExecCommandPreparationRuntime,
	settings: Pick<
		ExecCommandSettings,
		"defaultOutputTokens" | "defaultExecYieldMs" | "defaultLoginShell" | "activityIndicator"
	> = DEFAULT_EXEC_COMMAND_SETTINGS,
): ToolDefinition<typeof EXEC_COMMAND_PARAMETERS, ExecToolPresentationDetails> {
	const animation = execCommandAnimation(settings);
	return {
		name: "exec_command",
		label: "exec_command",
		description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
		parameters: execCommandParameters(settings),
		renderShell: "self",
		renderCall(args, theme, context) {
			return renderExecCommandCall(args, theme, context, animation);
		},
		renderResult(result, options, theme, context) {
			return renderExecResult(result, options, theme, context, animation, () => runtime.getManager());
		},
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args as never;
			const input = { ...(args as Record<string, unknown>) };
			if (!("cmd" in input) && typeof input["command"] === "string") input["cmd"] = input["command"];
			if (!("workdir" in input) && typeof input["cwd"] === "string") input["workdir"] = input["cwd"];
			return input as never;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const prepared = prepareExecCommandExecution(params, ctx, preparationRuntime, settings);
			onUpdate?.(
				createExecToolResult({
					tool: "exec_command",
					phase: "partial",
					arguments: prepared.arguments,
					command: params.cmd,
				}),
			);
			const execution = await executeExecCommand(runtime, prepared, ctx, signal, (progress) => {
				onUpdate?.(
					createExecToolResult({
						tool: "exec_command",
						phase: "partial",
						arguments: progress.arguments,
						command: params.cmd,
						result: progress.result,
					}),
				);
			});
			return createExecToolResult({
				tool: "exec_command",
				phase: "final",
				arguments: execution.arguments,
				command: params.cmd,
				result: execution.result,
			});
		},
	};
}

function execCommandAnimation(
	settings: Pick<ExecCommandSettings, "activityIndicator">,
): Readonly<ActivityAnimationOverrides> {
	return settings.activityIndicator === "inherit" ? {} : { indicatorStyle: settings.activityIndicator };
}
