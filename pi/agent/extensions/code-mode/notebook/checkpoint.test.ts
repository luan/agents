import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	garbageCollectSupersededNotebookCheckpoints,
	resolveNotebookCheckpointMaxBytes,
	sessionCheckpointProjectExclusions,
	writeNotebookCheckpoint,
} from "./checkpoint.ts";
import { notebookSessionKey, notebookStorageRoot } from "./project-identity.ts";
import type { NotebookKernelExecutor } from "./project-state-format.ts";

it("collects only superseded epochs of the same session", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-notebook-gc-"));
	const project = join(agentDir, "project");
	const currentSession = "session-a\0current";
	const current = checkpointDirectory(agentDir, project, currentSession);
	const superseded = writeCheckpoint(agentDir, project, "session-a\0old");
	const otherSession = writeCheckpoint(agentDir, project, "session-b\0old");
	mkdirSync(current, { recursive: true });
	try {
		garbageCollectSupersededNotebookCheckpoints({ project, session: currentSession, agentDir });
		expect(existsSync(superseded)).toBe(false);
		expect(existsSync(otherSession)).toBe(true);
		expect(existsSync(current)).toBe(true);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

it("keeps its project baseline and never removes a payload outside its directory", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-notebook-checkpoint-"));
	const project = join(agentDir, "project");
	const session = "session";
	const directory = checkpointDirectory(agentDir, project, session);
	mkdirSync(directory, { recursive: true });
	// A traversing payload name must be rejected before it reaches `Deno.remove`.
	writeFileSync(
		join(directory, "checkpoint.json"),
		JSON.stringify({
			schema: 1,
			project,
			session,
			deno: "2.9.5",
			v8: "test",
			payload: "../../outside.bin",
			createdAt: new Date().toISOString(),
			entries: [],
			skipped: [],
		}),
	);
	const removed: string[] = [];
	const kernel = fakeKernel(removed);
	try {
		const manifest = await writeNotebookCheckpoint(
			kernel,
			{ project, session, agentDir },
			new Set(),
			8 * 1024 * 1024,
			{
				generation: "baseline",
				entries: [{ name: "deletedLater", hash: "hash" }],
			},
		);
		expect(manifest.projectNames).toEqual(["deletedLater"]);
		expect(manifest.projectGeneration).toBe("baseline");
		expect(removed).toEqual([]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

it("excludes project names when the session delta is a generation behind", () => {
	const project = { generation: "new", entries: [{ name: "shared", hash: "hash" }] };
	expect([
		...sessionCheckpointProjectExclusions({ projectGeneration: "old", projectNames: ["deleted"] }, project),
	]).toEqual(["shared", "deleted"]);
	expect([...sessionCheckpointProjectExclusions({ projectGeneration: "new" }, project)]).toEqual([]);
});

it("clamps the checkpoint cap to 8 MiB..256 MiB of the heap", () => {
	expect(resolveNotebookCheckpointMaxBytes(16)).toBe(8 * 1024 * 1024);
	expect(resolveNotebookCheckpointMaxBytes(512)).toBe(64 * 1024 * 1024);
	expect(resolveNotebookCheckpointMaxBytes(65_536)).toBe(256 * 1024 * 1024);
});

/** Runs the generated Deno source against a filesystem-backed stand-in for the `Deno` namespace. */
function fakeKernel(removed: string[]): NotebookKernelExecutor {
	return {
		complete: async () => [],
		execute: async (source: string) => {
			const deno = {
				version: { deno: "2.9.5", v8: "test" },
				async open(path: string) {
					writeFileSync(path, Buffer.alloc(0));
					return {
						async write(bytes: Uint8Array) {
							appendFileSync(path, bytes);
							return bytes.byteLength;
						},
						close() {},
					};
				},
				async writeTextFile(path: string, text: string) {
					writeFileSync(path, text);
				},
				async rename(from: string, to: string) {
					renameSync(from, to);
				},
				async remove(path: string) {
					removed.push(path);
					rmSync(path, { force: true });
				},
			};
			const run = new Function("Deno", "crypto", `return (async () => ${source})()`);
			await run(deno, { randomUUID });
			return { status: "ok" as const };
		},
	};
}

function writeCheckpoint(agentDir: string, project: string, session: string): string {
	const directory = checkpointDirectory(agentDir, project, session);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "checkpoint.json"),
		`${JSON.stringify({
			schema: 1,
			project,
			session,
			deno: "test",
			v8: "test",
			payload: "checkpoint-00000000-0000-4000-8000-000000000000.bin",
			createdAt: new Date().toISOString(),
			entries: [],
			skipped: [],
		})}\n`,
	);
	return directory;
}

function checkpointDirectory(agentDir: string, project: string, session: string): string {
	return join(notebookStorageRoot(agentDir), "sessions", notebookSessionKey(project, session));
}
