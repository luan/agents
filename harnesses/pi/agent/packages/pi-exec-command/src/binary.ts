import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { resolveTerminalBridgeBinary } from "pi-libtui";

export function resolveExecCommandBinary(options: { readonly override?: string } = {}): string {
	return resolveTerminalBridgeBinary({
		root: resolve(import.meta.dirname, "../../../../../.."),
		binaryName: process.platform === "win32" ? "exec_command_bridge.exe" : "exec_command_bridge",
		override: options.override ?? process.env["PI_TERMINAL_BRIDGE_BINARY"] ?? process.env["PI_EXEC_COMMAND_BINARY"],
		isExecutable: (path) => {
			try {
				accessSync(path, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
	});
}
