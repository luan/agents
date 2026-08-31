import { win32 } from "node:path";

export interface ExecShellEnvironment {
	readonly platform: NodeJS.Platform;
	readonly variables: Readonly<Record<string, string | undefined>>;
	exists(path: string): boolean;
}

export type ExecShellResolver = (shell?: string) => string;

function firstExistingShell(
	candidates: readonly string[],
	fallback: string,
	exists: (path: string) => boolean,
): string {
	return candidates.find(exists) ?? fallback;
}

function defaultWindowsShell(environment: ExecShellEnvironment): string {
	const programFiles = environment.variables["ProgramFiles"] ?? "C:\\Program Files";
	const programFilesX86 = environment.variables["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const localAppData = environment.variables["LOCALAPPDATA"];
	const candidates = [`${programFiles}\\Git\\bin\\bash.exe`, `${programFilesX86}\\Git\\bin\\bash.exe`];
	if (localAppData) candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
	return firstExistingShell(candidates, "bash.exe", environment.exists);
}

function defaultExecShell(environment: ExecShellEnvironment): string {
	if (environment.platform === "win32") return defaultWindowsShell(environment);
	return environment.platform === "darwin"
		? firstExistingShell(["/bin/zsh", "/bin/bash", "/bin/sh"], "/bin/sh", environment.exists)
		: firstExistingShell(["/bin/bash", "/bin/zsh", "/bin/sh"], "/bin/sh", environment.exists);
}

function shellName(shell: string | undefined): string | undefined {
	return shell?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
}

function translateWindowsPosixShell(shell: string, fallback: string, exists: (path: string) => boolean): string {
	const marker = "\\bin\\bash.exe";
	if (!fallback.toLowerCase().endsWith(marker)) return shell;
	const gitRoot = fallback.slice(0, -marker.length);
	const relative = shell.replace(/^\/+/, "").replace(/\//g, "\\");
	for (const candidate of [win32.join(gitRoot, `${relative}.exe`), win32.join(gitRoot, relative)]) {
		if (exists(candidate)) return candidate;
	}
	return shell;
}

/** Create a deterministic resolver for the POSIX command grammar used by exec_command. */
export function createExecShellResolver(environment: ExecShellEnvironment): ExecShellResolver {
	const fallback = defaultExecShell(environment);
	const environmentShell = environment.variables["SHELL"];
	return (shell) => {
		const selected = shell ?? environmentShell;
		if (!selected || shellName(selected) === "fish") return fallback;
		if (environment.platform === "win32" && selected.startsWith("/")) {
			return translateWindowsPosixShell(selected, fallback, environment.exists);
		}
		return selected;
	};
}
