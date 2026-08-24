import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";

const BINARY_NAME = process.platform === "win32" ? "exec_command_bridge.exe" : "exec_command_bridge";

export function resolveExecCommandBinary(options: { root?: string; override?: string } = {}): string {
	const override = options.override ?? process.env["PI_EXEC_COMMAND_BINARY"];
	const root = options.root ?? resolve(import.meta.dirname, "../../../../../..");
	const candidates = override
		? [override]
		: [resolve(root, "target/release", BINARY_NAME), resolve(root, "target/debug", BINARY_NAME)];
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Try the next owned build location.
		}
	}
	throw new Error(
		override
			? `PI_EXEC_COMMAND_BINARY is not executable: ${override}`
			: `exec_command_bridge is missing. Run cargo build --release -p exec-command`,
	);
}
