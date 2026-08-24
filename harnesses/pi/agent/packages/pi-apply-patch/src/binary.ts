import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findWorkspaceRoot(): string | undefined {
	let current = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 12; depth += 1) {
		if (existsSync(join(current, "Cargo.toml")) && existsSync(join(current, "crates", "apply-patch", "Cargo.toml"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

export function resolveApplyPatchBinary(environment: NodeJS.ProcessEnv = process.env): string {
	const configured = environment["PI_APPLY_PATCH_BIN"]?.trim();
	if (environment["PI_APPLY_PATCH_BIN"] !== undefined) {
		if (!configured) throw new Error("PI_APPLY_PATCH_BIN is set but empty");
		if (!isExecutable(configured)) throw new Error(`PI_APPLY_PATCH_BIN is not executable: ${configured}`);
		return configured;
	}

	const root = findWorkspaceRoot();
	if (!root) throw new Error("Cannot find the agents Cargo workspace for apply_patch");
	const binaryName = process.platform === "win32" ? "apply_patch.exe" : "apply_patch";
	const binary = join(root, "target", "release", binaryName);
	if (!isExecutable(binary)) {
		throw new Error("apply_patch binary is not built; run `cargo build --release -p apply-patch`");
	}
	return binary;
}
