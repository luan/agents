import { resolve } from "node:path";

export interface TerminalBridgeBinaryOptions {
	readonly root: string;
	readonly binaryName: string;
	readonly override?: string;
	isExecutable(path: string): boolean;
}

/** Resolve the shared native process/PTY bridge used by terminal surfaces and exec_command. */
export function resolveTerminalBridgeBinary(options: TerminalBridgeBinaryOptions): string {
	const candidates = options.override
		? [options.override]
		: [
				resolve(options.root, "target/release", options.binaryName),
				resolve(options.root, "target/debug", options.binaryName),
			];
	for (const candidate of candidates) {
		if (options.isExecutable(candidate)) return candidate;
	}
	throw new Error(
		options.override
			? `terminal bridge is not executable: ${options.override}`
			: "terminal bridge is missing. Run cargo build --release -p exec-command",
	);
}
