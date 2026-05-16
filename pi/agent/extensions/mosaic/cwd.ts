import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function resolveAgentCwd(input: unknown, baseCwd: string): string | undefined {
	if (input == null) return undefined;
	if (typeof input !== "string" || input.trim() === "") throw new Error("`cwd` must be a non-empty string.");
	const candidate = input.trim();
	const resolved = isAbsolute(candidate) ? candidate : resolve(baseCwd, candidate);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		throw new Error(`Agent cwd does not exist or is not a directory: ${resolved}`);
	}
	return resolved;
}
