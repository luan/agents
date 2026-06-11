import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __pkg_dir = dirname(fileURLToPath(import.meta.url));

export type PiToolResponse = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

export type CoreResponse = PiToolResponse & {
	ok?: boolean;
	isError?: boolean;
};

function executableNames(name: string): string[] {
	return process.platform === "win32" ? [name, `${name}.exe`] : [name];
}

export function resolveCoreBin(): string | null {
	const bin = process.env.CONTEXT_GUARD_BIN?.trim();
	if (bin) return bin;

	if (process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN !== "1") {
		for (const name of executableNames("context-guard")) {
			for (const rel of [`../../../../../target/debug/${name}`, `../../../../../target/release/${name}`]) {
				const candidate = resolve(__pkg_dir, rel);
				if (existsSync(candidate)) return candidate;
			}
		}
	}

	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of executableNames("context-guard")) {
			const candidate = resolve(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}

	return null;
}

function missingCoreResponse(): CoreResponse {
	return {
		content: [
			{
				type: "text",
				text:
					"Context Guard core binary not found. Build `cargo build -p context-guard` in the agents workspace " +
					"or set CONTEXT_GUARD_BIN=/path/to/context-guard.",
			},
		],
		isError: true,
	};
}

export async function invokeCore(
	command: string,
	params: Record<string, unknown> = {},
	signal?: AbortSignal,
): Promise<CoreResponse> {
	const bin = resolveCoreBin();
	if (!bin) {
		return missingCoreResponse();
	}

	if (signal?.aborted) {
		return {
			content: [{ type: "text", text: "Context Guard core cancelled" }],
			isError: true,
		};
	}

	return new Promise((resolvePromise) => {
		const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let cancelled = false;
		const settle = (response: CoreResponse) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abortListener);
			resolvePromise(response);
		};
		const killChild = (killSignal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) {
					process.kill(-child.pid, killSignal);
					return;
				}
			} catch {
				// Fall back to direct child termination below.
			}
			child.kill(killSignal);
		};
		const abortListener = () => {
			cancelled = true;
			killChild("SIGTERM");
			setTimeout(() => {
				killChild("SIGKILL");
			}, 500).unref?.();
			settle({
				content: [{ type: "text", text: "Context Guard core cancelled" }],
				isError: true,
			});
		};

		signal?.addEventListener("abort", abortListener, { once: true });

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (err) => {
			settle({
				content: [{ type: "text", text: `Context Guard core error: ${err.message}` }],
				isError: true,
			});
		});
		child.on("close", (code) => {
			if (cancelled || signal?.aborted) {
				settle({
					content: [{ type: "text", text: "Context Guard core cancelled" }],
					isError: true,
				});
				return;
			}
			if (code !== 0) {
				settle({
					content: [{ type: "text", text: `Context Guard core exited ${code}: ${stderr.trim()}`.trim() }],
					isError: true,
				});
				return;
			}

			try {
				settle(JSON.parse(stdout) as CoreResponse);
			} catch (err) {
				settle({
					content: [
						{
							type: "text",
							text: `Context Guard core returned invalid JSON: ${err instanceof Error ? err.message : err}`,
						},
					],
					isError: true,
				});
			}
		});

		child.stdin.end(JSON.stringify({ command, params }));
	});
}

export function invokeCoreSync(command: string, params: Record<string, unknown> = {}): CoreResponse {
	const bin = resolveCoreBin();
	if (!bin) {
		return missingCoreResponse();
	}

	const result = spawnSync(bin, [], {
		input: JSON.stringify({ command, params }),
		encoding: "utf8",
	});

	if (result.error) {
		return {
			content: [{ type: "text", text: `Context Guard core error: ${result.error.message}` }],
			isError: true,
		};
	}

	if (result.status !== 0) {
		return {
			content: [
				{
					type: "text",
					text: `Context Guard core exited ${result.status}: ${(result.stderr ?? "").trim()}`.trim(),
				},
			],
			isError: true,
		};
	}

	try {
		return JSON.parse(result.stdout ?? "") as CoreResponse;
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `Context Guard core returned invalid JSON: ${err instanceof Error ? err.message : err}`,
				},
			],
			isError: true,
		};
	}
}

export function parseCoreJson<T>(response: CoreResponse): T | null {
	if (response.isError) return null;
	const text = response.content[0]?.text;
	if (!text) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}
