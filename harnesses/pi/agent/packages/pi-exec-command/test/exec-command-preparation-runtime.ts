import type { ExecCommandPreparationRuntime } from "../src/tools/exec-command/execute.ts";

export const TEST_EXEC_SHELL = "/bin/sh";

export const TEST_EXEC_COMMAND_PREPARATION_RUNTIME: ExecCommandPreparationRuntime = {
	configuredShell: () => undefined,
	resolveShell: (shell) => (!shell || shell.replace(/\\/g, "/").split("/").pop() === "fish" ? TEST_EXEC_SHELL : shell),
};
