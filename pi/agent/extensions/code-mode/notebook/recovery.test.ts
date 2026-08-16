import { expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readNotebookNpmImports, recordNotebookNpmImports } from "./npm-imports.ts";
import { NotebookRecoveryController, type NotebookRecoveryHost } from "./recovery.ts";

function identity(): { project: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-notebook-recovery-"));
	return { project: join(root, "project"), agentDir: join(root, "agent") };
}

function host(overrides: Partial<NotebookRecoveryHost>, calls: string[], id: ReturnType<typeof identity>) {
	return {
		identity: () => id,
		journal: () => ({ path: join(id.project, "journal.ipynb"), cells: [] }),
		deno: async () => {
			calls.push("deno");
			return "/nonexistent/deno";
		},
		restoredBindings: () => new Set<string>(),
		profileActive: () => false,
		stopWithoutCheckpoint: async () => {
			calls.push("stop");
			return "cell-3";
		},
		resetProjectState: async () => {
			calls.push("resetProjectState");
			return { generation: "gen-2", previousBindings: 2 };
		},
		removeCheckpoint: () => void calls.push("removeCheckpoint"),
		startClean: async () => void calls.push("startClean"),
		checkpointEmpty: async () => void calls.push("checkpointEmpty"),
		...overrides,
	} satisfies NotebookRecoveryHost;
}

it("resets project state, the npm inventory, and the checkpoint, then restarts clean", async () => {
	const id = identity();
	recordNotebookNpmImports(id, ["npm:ky@1.7.2"]);
	const calls: string[] = [];
	const result = await new NotebookRecoveryController({ maxBytes: 1024 }, host({}, calls, id)).reset();

	// A package approved before the reset must be approved again after it.
	expect(readNotebookNpmImports(id)).toEqual([]);
	expect(calls).toEqual(["stop", "resetProjectState", "removeCheckpoint", "startClean", "checkpointEmpty"]);
	expect(result.message).toContain("discarded 2 project bindings and terminated cell-3");
	expect(result.message).toContain("Saved notebooks and named profiles were preserved");
	expect(result.details).toMatchObject({
		projectGeneration: "gen-2",
		discardedProjectBindings: 2,
		terminatedCell: "cell-3",
	});
});

it("says nothing about a terminated cell when none was running", async () => {
	const id = identity();
	const calls: string[] = [];
	const result = await new NotebookRecoveryController(
		{ maxBytes: 1024 },
		host(
			{
				stopWithoutCheckpoint: async () => undefined,
				resetProjectState: async () => ({ generation: "gen-1", previousBindings: 1 }),
			},
			calls,
			id,
		),
	).reset();
	expect(result.message).toContain("discarded 1 project binding.");
	expect(result.details["terminatedCell"]).toBeUndefined();
});

it("refuses to reset an aborted request before it touches anything", async () => {
	const id = identity();
	const calls: string[] = [];
	const controller = new NotebookRecoveryController({ maxBytes: 1024 }, host({}, calls, id));
	await expect(controller.reset(AbortSignal.abort())).rejects.toThrow();
	expect(calls).toEqual([]);
});

it("reports an unreadable journal instead of starting Deno", async () => {
	const id = identity();
	const calls: string[] = [];
	const controller = new NotebookRecoveryController(
		{ maxBytes: 1024 },
		host(
			{
				journal: () => {
					throw new Error("Notebook journal is invalid");
				},
			},
			calls,
			id,
		),
	);
	const result = await controller.diagnostics();
	expect(result.message).toContain("could not read the journal: Notebook journal is invalid");
	expect(calls).toEqual([]);
});

it("diagnoses an empty journal without starting a Deno LSP", async () => {
	const id = identity();
	const calls: string[] = [];
	const result = await new NotebookRecoveryController({ maxBytes: 1024 }, host({}, calls, id)).diagnostics();
	expect(result.message).toContain("No code cells to diagnose");
	expect(calls).toEqual(["deno"]);
});
