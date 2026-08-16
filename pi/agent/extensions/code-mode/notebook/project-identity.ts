import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

/**
 * Notebook state lives beside the agent, never inside the user's repository.
 * Callers pass `getAgentDir()` from `@earendil-works/pi-coding-agent`.
 */
export function notebookStorageRoot(agentDir: string): string {
	return join(agentDir, "notebook");
}

/** The worktree root. `.git` is a directory in the main worktree and a file in a linked one. */
export function resolveNotebookProject(cwd: string): string {
	let current = resolve(cwd);
	const root = parse(current).root;
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		if (current === root) return resolve(cwd);
		current = dirname(current);
	}
}

export function notebookProjectKey(project: string): string {
	return createHash("sha256").update(resolve(project)).digest("hex");
}

export function notebookSessionKey(project: string, session: string): string {
	return createHash("sha256")
		.update(`${resolve(project)}\0${session}`)
		.digest("hex");
}
