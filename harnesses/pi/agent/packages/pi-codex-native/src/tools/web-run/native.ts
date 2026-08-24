import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebRunParameters } from "./schema.ts";

const MAX_DIAGNOSTIC_CHARS = 8_192;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

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
		if (existsSync(join(current, "Cargo.toml")) && existsSync(join(current, "crates", "web-run", "Cargo.toml")))
			return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

export function resolveWebRunBinary(): string {
	const configured = process.env["PI_CODEX_WEB_RUN_BIN"];
	if (configured !== undefined) {
		const path = configured.trim();
		if (!path) throw new Error("PI_CODEX_WEB_RUN_BIN is set but empty");
		if (!isExecutable(path)) throw new Error(`PI_CODEX_WEB_RUN_BIN is not executable: ${path}`);
		return path;
	}
	const root = findWorkspaceRoot();
	if (!root) throw new Error("Cannot find the agents Cargo workspace for web_run");
	const binary = [join(root, "target", "release", "web_run"), join(root, "target", "debug", "web_run")].find(
		isExecutable,
	);
	if (!binary) throw new Error("web_run binary is not built; run `cargo build -p web-run`");
	return binary;
}

export function boundedWebRunDiagnostic(value: string): string {
	const normalized = value.trim();
	return normalized.length <= MAX_DIAGNOSTIC_CHARS ? normalized : `${normalized.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}

export function runWebRunBinary(binary: string, input: WebRunParameters, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ["-"], { stdio: ["pipe", "pipe", "pipe"], signal });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (callback: () => void) => {
			if (!settled) {
				settled = true;
				callback();
			}
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > MAX_STDOUT_BYTES) {
				child.kill();
				finish(() => reject(new Error(`web_run stdout exceeded ${MAX_STDOUT_BYTES} bytes`)));
			} else stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_DIAGNOSTIC_CHARS + 1) stderr += chunk;
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) =>
			finish(() =>
				code === 0
					? resolve(stdout)
					: reject(new Error(boundedWebRunDiagnostic(stderr) || `web_run exited with code ${code ?? "unknown"}`)),
			),
		);
		child.stdin.on("error", (error) => {
			child.kill();
			finish(() => reject(error));
		});
		child.stdin.end(JSON.stringify(input));
	});
}
