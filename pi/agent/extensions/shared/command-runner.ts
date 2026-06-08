import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type CommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type RunCommandOptions = {
	signal?: AbortSignal;
	input?: string;
	allowNonZero?: boolean;
	extraSearchPaths?: readonly string[];
};

export function formatCommand(command: string, args: readonly string[]): string {
	return [command, ...args.map((arg) => (/[\s\t]/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

function isRunCommandOptions(value: unknown): value is RunCommandOptions {
	return Boolean(value && typeof value === "object" && !("aborted" in (value as Record<string, unknown>)));
}

function expandPathEntry(entry: string): string | undefined {
	if (entry === "~") return process.env.HOME;
	if (entry.startsWith("~/")) return process.env.HOME ? join(process.env.HOME, entry.slice(2)) : undefined;
	return entry;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveCommand(command: string, extraSearchPaths: readonly string[] = []): string | undefined {
	if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) return command;
	const paths = [...(process.env.PATH ?? "").split(delimiter), ...extraSearchPaths]
		.map(expandPathEntry)
		.filter((entry): entry is string => Boolean(entry));
	for (const searchPath of new Set(paths)) {
		const candidate = join(searchPath, command);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

export function runCommand(
	command: string,
	args: string[],
	cwd: string,
	signalOrOptions?: AbortSignal | RunCommandOptions,
	input?: string,
): Promise<CommandResult> {
	const options = isRunCommandOptions(signalOrOptions) ? signalOrOptions : { signal: signalOrOptions, input };
	const resolvedCommand = resolveCommand(command, options.extraSearchPaths) ?? command;
	try {
		accessSync(cwd, constants.R_OK);
	} catch {
		return Promise.reject(new Error(`Working directory not found: ${cwd}`));
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdinError: NodeJS.ErrnoException | undefined;
		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const resolveOnce = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const child = spawn(resolvedCommand, args, {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		child.on("error", (error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				rejectOnce(new Error(`${command} not found on PATH`));
				return;
			}
			rejectOnce(error);
		});
		child.stdin.on("error", (error) => {
			stdinError = error as NodeJS.ErrnoException;
			if (stdinError.code === "EPIPE" || stdinError.code === "ERR_STREAM_DESTROYED") return;
			rejectOnce(stdinError);
		});

		const onAbort = () => child.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		if (options.input === undefined) child.stdin.end();
		else child.stdin.end(options.input);

		child.on("close", (exitCode) => {
			options.signal?.removeEventListener("abort", onAbort);
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (exitCode === 0 || options.allowNonZero) {
				resolveOnce({ stdout, stderr, exitCode: exitCode ?? 0 });
				return;
			}
			const stdinMessage = stdinError ? `: ${stdinError.message}` : "";
			rejectOnce(
				new Error(
					`${formatCommand(command, args)} failed with exit code ${exitCode ?? 1}${stderr.trim() ? `: ${stderr.trim()}` : stdinMessage}`,
				),
			);
		});
	});
}
