import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file sits at pi/agent/extensions/shared/, so the workspace root is four levels up.
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Path to a Cargo binary built by `just build` into the workspace `target/release`. */
export function workspaceBinary(name: string): string {
	return join(WORKSPACE_ROOT, "target", "release", process.platform === "win32" ? `${name}.exe` : name);
}
