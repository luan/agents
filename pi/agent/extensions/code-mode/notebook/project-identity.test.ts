import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	notebookProjectKey,
	notebookSessionKey,
	notebookStorageRoot,
	resolveNotebookProject,
} from "./project-identity.ts";

it("follows the Git worktree root out of a nested package directory", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-notebook-project-"));
	try {
		// A linked worktree has `.git` as a file, not a directory.
		writeFileSync(join(root, ".git"), "gitdir: /tmp/example\n");
		const nested = join(root, "packages", "example");
		mkdirSync(nested, { recursive: true });
		expect(resolveNotebookProject(nested)).toBe(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("falls back to the cwd when no worktree root exists above it", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-notebook-no-git-"));
	try {
		expect(resolveNotebookProject(root)).toBe(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("keys state beside the agent, never inside the repository", () => {
	expect(notebookStorageRoot("/agent")).toBe("/agent/notebook");
	expect(notebookProjectKey("/project")).toMatch(/^[0-9a-f]{64}$/);
	expect(notebookProjectKey("/project/.")).toBe(notebookProjectKey("/project"));
	expect(notebookSessionKey("/project", "a")).not.toBe(notebookSessionKey("/project", "b"));
});
