import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EXEC_COMMAND_SETTINGS, type ExecCommandSettings } from "../../contributions/xsettings.ts";
import type { ExecShellResolver } from "../../runtime-shell.ts";
import type { ExecCommandInput, UnifiedExecResult } from "../../session-manager.ts";
import { type ExecCommandPresentationArguments, normalizeExecCommandArguments } from "../presentation.ts";
import type { ExecRuntime } from "../runtime.ts";

export interface ExecCommandPreparationRuntime {
	configuredShell(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): string | undefined;
	resolveShell: ExecShellResolver;
}

export interface ExecCommandExecution {
	arguments: ExecCommandPresentationArguments;
	input: ExecCommandInput;
	result: UnifiedExecResult;
}

export async function executeExecCommand(
	runtime: ExecRuntime,
	prepared: Pick<ExecCommandExecution, "arguments" | "input">,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	onUpdate?: (execution: ExecCommandExecution) => void,
): Promise<ExecCommandExecution> {
	const result = await runtime.getManager().exec(prepared.input, ctx.cwd, signal, (progress) => {
		onUpdate?.({
			arguments: prepared.arguments,
			input: prepared.input,
			result: progress,
		});
	});
	return {
		arguments: prepared.arguments,
		input: prepared.input,
		result,
	};
}

export function prepareExecCommandExecution(
	params: ExecCommandInput,
	ctx: ExtensionContext,
	runtime: ExecCommandPreparationRuntime,
	settings?: Pick<ExecCommandSettings, "defaultLoginShell">,
): { arguments: ExecCommandPresentationArguments; input: ExecCommandInput } {
	const shell = runtime.resolveShell(params.shell ?? runtime.configuredShell(ctx));
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
