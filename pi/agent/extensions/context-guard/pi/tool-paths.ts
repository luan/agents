import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveContentStorePath } from "../session/paths.js";
import { getPiSessionDir } from "./index.js";

export function getSessionDir(): string {
	return getPiSessionDir();
}

export function getProjectDir(): string {
	const candidates = [
		process.env.PI_WORKSPACE_DIR,
		process.env.PI_PROJECT_DIR,
		process.env.CONTEXT_GUARD_PROJECT_DIR,
		process.env.PWD,
		process.cwd(),
	];

	for (const candidate of candidates) {
		if (typeof candidate === "string") {
			const trimmed = candidate.trim();
			if (trimmed) return trimmed;
		}
	}

	return process.cwd();
}

export function getStorePath(projectDir = getProjectDir()): string {
	const dir = join(dirname(getSessionDir()), "content");
	mkdirSync(dir, { recursive: true });
	return resolveContentStorePath({ projectDir, contentDir: dir });
}
