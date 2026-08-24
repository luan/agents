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
	for (let depth = 0; depth < 12; depth++) {
		if (existsSync(join(current, "Cargo.toml")) && existsSync(join(current, "crates", "view-image", "Cargo.toml"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

export function resolveViewImageBinary(environment: NodeJS.ProcessEnv = process.env): string {
	const configured = environment["PI_VIEW_IMAGE_BIN"]?.trim();
	if (environment["PI_VIEW_IMAGE_BIN"] !== undefined) {
		if (!configured) throw new Error("PI_VIEW_IMAGE_BIN is set but empty");
		if (!isExecutable(configured)) throw new Error(`PI_VIEW_IMAGE_BIN is not executable: ${configured}`);
		return configured;
	}
	const root = findWorkspaceRoot();
	if (!root) throw new Error("Cannot find the agents Cargo workspace for view_image");
	const binaryName = process.platform === "win32" ? "view_image.exe" : "view_image";
	const binary = [join(root, "target", "release", binaryName), join(root, "target", "debug", binaryName)].find(
		isExecutable,
	);
	if (!binary) throw new Error("view_image binary is not built; run `cargo build --release -p view-image`");
	return binary;
}
