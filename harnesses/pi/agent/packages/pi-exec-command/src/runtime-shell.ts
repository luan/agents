import { existsSync } from "node:fs";
import { join } from "node:path";

function firstExistingShell(candidates: readonly string[], fallback: string): string {
	return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}

function defaultWindowsShell(): string {
	const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
	const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const localAppData = process.env["LOCALAPPDATA"];
	const candidates = [`${programFiles}\\Git\\bin\\bash.exe`, `${programFilesX86}\\Git\\bin\\bash.exe`];
	if (localAppData) candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
	return firstExistingShell(candidates, "bash.exe");
}

export const DEFAULT_EXEC_SHELL =
	process.platform === "win32"
		? defaultWindowsShell()
		: process.platform === "darwin"
			? firstExistingShell(["/bin/zsh", "/bin/bash", "/bin/sh"], "/bin/sh")
			: firstExistingShell(["/bin/bash", "/bin/zsh", "/bin/sh"], "/bin/sh");

function shellName(shell: string | undefined): string | undefined {
	return shell?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
}

function translateWindowsPosixShell(shell: string): string {
	const marker = "\\bin\\bash.exe";
	if (!DEFAULT_EXEC_SHELL.toLowerCase().endsWith(marker)) return shell;
	const gitRoot = DEFAULT_EXEC_SHELL.slice(0, -marker.length);
	const relative = shell.replace(/^\/+/, "").replace(/\//g, "\\");
	for (const candidate of [join(gitRoot, `${relative}.exe`), join(gitRoot, relative)]) {
		if (existsSync(candidate)) return candidate;
	}
	return shell;
}

/** Resolve a shell that accepts the POSIX command grammar used by exec_command. */
export function resolveRuntimeShell(shell: string | undefined): string {
	if (!shell || shellName(shell) === "fish") return DEFAULT_EXEC_SHELL;
	if (process.platform === "win32" && shell.startsWith("/")) return translateWindowsPosixShell(shell);
	return shell;
}
