import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CODE_MODE_HOST_ENV = "PI_CODE_MODE_HOST_BINARY";

export function resolveCodeModeHostBinary(
	environment = process.env,
	startPaths: readonly string[] = [process.cwd(), dirname(fileURLToPath(import.meta.url))],
): string {
	const override = environment[CODE_MODE_HOST_ENV]?.trim();
	if (override) return requireExecutable(resolve(override));
	for (const start of startPaths) {
		let current = resolve(start);
		for (;;) {
			const candidate = join(current, "target", "release", executableName());
			if (existsSync(candidate)) return requireExecutable(candidate);
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	throw new Error(
		`Code Mode host not found at target/release/${executableName()}. Build it with cargo build --release -p code-mode-host or set ${CODE_MODE_HOST_ENV}.`,
	);
}

function executableName(): string {
	return process.platform === "win32" ? "code-mode-host.exe" : "code-mode-host";
}

function requireExecutable(path: string): string {
	if (!existsSync(path)) throw new Error(`Code Mode host does not exist: ${path}`);
	if (process.platform !== "win32") accessSync(path, constants.X_OK);
	return path;
}
