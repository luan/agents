import { existsSync } from "node:fs";
import { join } from "node:path";

function firstExistingShell(candidates: string[], fallback: string): string {
	return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}

// Exec sessions run POSIX command lines (sleep, printf, read, pipes), so even on
// Windows we need a POSIX shell. Git for Windows ships bash; prefer it at the
// standard install locations, then fall back to `bash` on PATH.
function defaultWindowsShell(): string {
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const localAppData = process.env.LOCALAPPDATA;
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

export function isFishShell(shell: string | undefined): boolean {
	const name = shell?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return name === "fish";
}

// Git for Windows reports $SHELL as a POSIX path (e.g. /usr/bin/bash) that Node
// cannot spawn. Translate it to the real .exe under the Git install when that
// file exists; otherwise return the original so a genuinely missing shell still
// surfaces as a spawn error rather than being silently replaced.
function translateWindowsPosixShell(shell: string): string {
	const marker = "\\bin\\bash.exe";
	if (!DEFAULT_EXEC_SHELL.toLowerCase().endsWith(marker)) return shell;
	const gitRoot = DEFAULT_EXEC_SHELL.slice(0, -marker.length);
	const rel = shell.replace(/^\/+/, "").replace(/\//g, "\\");
	for (const candidate of [join(gitRoot, `${rel}.exe`), join(gitRoot, rel)]) {
		if (existsSync(candidate)) return candidate;
	}
	return shell;
}

export function resolveRuntimeShell(shell: string | undefined): string {
	if (!shell || isFishShell(shell)) {
		return DEFAULT_EXEC_SHELL;
	}
	if (process.platform === "win32" && shell.startsWith("/")) {
		return translateWindowsPosixShell(shell);
	}
	return shell;
}
