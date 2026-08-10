import { createHash } from "node:crypto";
import { join } from "node:path";

function normalizeProjectPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const withoutTrailingSlash = /^\/+$/u.test(normalized) ? "/" : normalized.replace(/\/+$/u, "");
	return process.platform === "darwin" || process.platform === "win32"
		? withoutTrailingSlash.toLowerCase()
		: withoutTrailingSlash;
}

export function resolveContentStorePath(opts: { projectDir: string; contentDir: string }): string {
	const hash = createHash("sha256").update(normalizeProjectPath(opts.projectDir)).digest("hex").slice(0, 16);
	return join(opts.contentDir, `${hash}.v2.db`);
}
