import { spawn } from "node:child_process";

export type CtResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export function formatCommand(command: string, args: string[]): string {
	return [command, ...args.map((arg) => (/[\s\t]/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

export function runCommand(
	command: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	input?: string,
): Promise<CtResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
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
				reject(new Error(`${command} not found on PATH`));
				return;
			}
			reject(error);
		});

		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });

		if (input === undefined) {
			child.stdin.end();
		} else {
			child.stdin.end(input);
		}

		child.on("close", (exitCode) => {
			signal?.removeEventListener("abort", onAbort);
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (exitCode === 0) {
				resolve({ stdout, stderr, exitCode: 0 });
				return;
			}
			reject(
				new Error(
					`${formatCommand(command, args)} failed with exit code ${exitCode ?? 1}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
				),
			);
		});
	});
}
