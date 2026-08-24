import type { UnifiedExecResult, WriteStdinInput } from "../../session-manager.ts";
import { normalizeWriteStdinArguments, type WriteStdinPresentationArguments } from "../presentation.ts";
import type { ExecRuntime } from "../runtime.ts";

export interface WriteStdinExecution {
	arguments: WriteStdinPresentationArguments;
	command?: string;
	result: UnifiedExecResult;
}

export async function executeWriteStdin(
	runtime: ExecRuntime,
	input: WriteStdinInput,
	signal?: AbortSignal,
	onUpdate?: (execution: WriteStdinExecution) => void,
): Promise<WriteStdinExecution> {
	const manager = runtime.getManager();
	const command = manager.getSessionCommand(input.session_id);
	const tty = manager.getSessionTty?.(input.session_id) ?? true;
	const result = await manager.write(input, signal, (progress) => {
		onUpdate?.({ arguments: normalizeWriteStdinArguments(input, tty), command, result: progress });
	});
	return { arguments: normalizeWriteStdinArguments(input, tty), command, result };
}
