export const DEFAULT_EXEC_SHELL = "/bin/bash";

export function isFishShell(shell: string | undefined): boolean {
	const name = shell?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return name === "fish";
}

export function resolveRuntimeShell(shell: string | undefined): string {
	if (!shell) {
		return DEFAULT_EXEC_SHELL;
	}
	return isFishShell(shell) ? DEFAULT_EXEC_SHELL : shell;
}
