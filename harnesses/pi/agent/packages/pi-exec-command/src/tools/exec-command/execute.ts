import { resolve } from "node:path";
import { type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EXEC_COMMAND_SETTINGS, type ExecCommandSettings } from "../../contributions/xsettings.ts";
import { resolveRuntimeShell } from "../../runtime-shell.ts";
import type { ExecCommandInput, UnifiedExecResult } from "../../session-manager.ts";
import { type ExecCommandPresentationArguments, normalizeExecCommandArguments } from "../presentation.ts";
import type { ExecRuntime } from "../runtime.ts";

function configuredShell(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): string | undefined {
	return SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	}).getShellPath();
}

export interface ExecCommandExecution {
	arguments: ExecCommandPresentationArguments;
	input: ExecCommandInput;
	result: UnifiedExecResult;
}

export async function executeExecCommand(
	runtime: ExecRuntime,
	params: ExecCommandInput,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	settings?: Pick<ExecCommandSettings, "defaultLoginShell">,
	onUpdate?: (execution: ExecCommandExecution) => void,
): Promise<ExecCommandExecution> {
	const shell = resolveRuntimeShell(params.shell ?? configuredShell(ctx) ?? process.env["SHELL"]);
	const input = {
		...params,
		shell,
		login: params.login ?? settings?.defaultLoginShell ?? DEFAULT_EXEC_COMMAND_SETTINGS.defaultLoginShell,
	};
	const workingDirectory = resolve(ctx.cwd, params.workdir ?? ".");
	const result = await runtime.getManager().exec(input, ctx.cwd, signal, (progress) => {
		onUpdate?.({
			arguments: normalizeExecCommandArguments(input, workingDirectory, shell),
			input,
			result: progress,
		});
	});
	return {
		arguments: normalizeExecCommandArguments(input, workingDirectory, shell),
		input,
		result,
	};
}

export function prepareExecCommandExecution(
	params: ExecCommandInput,
	ctx: ExtensionContext,
	settings?: Pick<ExecCommandSettings, "defaultLoginShell">,
): { arguments: ExecCommandPresentationArguments; input: ExecCommandInput } {
	const shell = resolveRuntimeShell(params.shell ?? configuredShell(ctx) ?? process.env["SHELL"]);
	const input = {
		...params,
		shell,
		login: params.login ?? settings?.defaultLoginShell ?? DEFAULT_EXEC_COMMAND_SETTINGS.defaultLoginShell,
	};
	return {
		arguments: normalizeExecCommandArguments(input, resolve(ctx.cwd, params.workdir ?? "."), shell),
		input,
	};
}
