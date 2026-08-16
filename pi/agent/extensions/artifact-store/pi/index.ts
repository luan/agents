// Whether exec_command routes its output through capture. Either extension loads without the other, so the coupling is this flag: artifact-store sets it at load, exec-command reads it per call.
const EXEC_COMMAND_WRAP_FLAG = Symbol.for("agents.artifact-store.exec-wrap-enabled");

export function markExecCaptureEnabled(): void {
	(globalThis as Record<symbol, unknown>)[EXEC_COMMAND_WRAP_FLAG] = true;
}

export function isExecCaptureEnabled(): boolean {
	return (globalThis as Record<symbol, unknown>)[EXEC_COMMAND_WRAP_FLAG] === true;
}

export function resetExecCaptureEnabled(): void {
	delete (globalThis as Record<symbol, unknown>)[EXEC_COMMAND_WRAP_FLAG];
}
