import type { SyntaxValidator } from "./types";

/**
 * Return true only when a host validator parsed this format and found no errors.
 * Unknown formats cannot authorize OMP's syntax-based boundary repairs.
 */
export function parsesCleanly(path: string | undefined, text: string, validator?: SyntaxValidator): boolean {
	if (path === undefined || validator === undefined) return false;
	return validator({ path, text }).kind === "valid";
}
