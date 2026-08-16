import { expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotebookProfileController, type NotebookProfileHost } from "./profile-lifecycle.ts";
import { type NotebookProfileCapture, type NotebookProfileSnapshot, writeNotebookProfile } from "./profile-state.ts";

const MAX_BYTES = 1024 * 1024;

function capture(): NotebookProfileCapture {
	return {
		deno: "2.9.5",
		v8: "14.0",
		payload: Buffer.from("alphabeta"),
		entries: [
			{ name: "alpha", kind: "value", offset: 0, length: 5 },
			{ name: "beta", kind: "function", offset: 5, length: 4 },
		],
		skipped: [],
	};
}

interface Recorder {
	agentDir: string;
	calls: string[];
	restored: NotebookProfileSnapshot[];
	live: Set<string>;
	activeCell: string | undefined;
	restoreError: Error | undefined;
	host: NotebookProfileHost;
}

function recorder(): Recorder {
	const state: Recorder = {
		agentDir: join(mkdtempSync(join(tmpdir(), "pi-notebook-profile-life-")), "agent"),
		calls: [],
		restored: [],
		live: new Set<string>(),
		activeCell: undefined,
		restoreError: undefined,
		host: undefined as unknown as NotebookProfileHost,
	};
	state.host = {
		activeCellId: () => state.activeCell,
		checkpoint: async () => void state.calls.push("checkpoint"),
		markChanged: () => void state.calls.push("markChanged"),
		storage: () => ({ agentDir: state.agentDir, maxBytes: MAX_BYTES }),
		project: () => "/repo",
		liveBindings: async () => state.live,
		capture: async (names) => {
			state.calls.push(`capture:${names.join(",")}`);
			return capture();
		},
		restore: async (snapshot) => {
			state.calls.push("restore");
			if (state.restoreError) throw state.restoreError;
			state.restored.push(snapshot);
		},
		rollback: async () => void state.calls.push("rollback"),
	};
	return state;
}

it("saves a profile from the live bindings after a checkpoint", async () => {
	const state = recorder();
	state.live = new Set(["beta", "alpha"]);
	const result = await new NotebookProfileController(state.host).save("work");
	expect(result.message).toContain("Saved notebook profile work: 1 value(s), 1 definition(s)");
	expect(state.calls).toEqual(["checkpoint", "capture:alpha,beta"]);
});

it("loads a profile by value and never replays cells", async () => {
	const state = recorder();
	writeNotebookProfile({ name: "work", agentDir: state.agentDir, sourceProject: "/repo", capture: capture() });
	const result = await new NotebookProfileController(state.host).load("work");
	expect(result.details["loaded"]).toEqual(["alpha", "beta"]);
	// A cell replay would re-run side effects. Only restore and checkpoint may run.
	expect(state.calls).toEqual(["checkpoint", "restore", "markChanged", "checkpoint"]);
	expect(state.restored[0]!.payload.toString()).toBe("alphabeta");
});

it("refuses a save or a load while a cell is running", async () => {
	const state = recorder();
	state.activeCell = "cell-7";
	const controller = new NotebookProfileController(state.host);
	await expect(controller.save("work")).rejects.toThrow(
		'Cannot save a notebook profile while exec cell "cell-7" is running',
	);
	await expect(controller.load("work")).rejects.toThrow(
		'Cannot load a notebook profile while exec cell "cell-7" is running',
	);
	expect(state.calls).toEqual([]);
});

it("refuses to load over a live binding of the same name", async () => {
	const state = recorder();
	writeNotebookProfile({ name: "work", agentDir: state.agentDir, sourceProject: "/repo", capture: capture() });
	state.live = new Set(["beta"]);
	await expect(new NotebookProfileController(state.host).load("work")).rejects.toThrow(
		"conflicts with existing bindings: beta",
	);
	expect(state.calls).not.toContain("restore");
});

it("rolls back when a restore fails", async () => {
	const state = recorder();
	writeNotebookProfile({ name: "work", agentDir: state.agentDir, sourceProject: "/repo", capture: capture() });
	state.restoreError = new Error("kernel died");
	await expect(new NotebookProfileController(state.host).load("work")).rejects.toThrow(
		"Notebook profile could not be loaded: kernel died",
	);
	expect(state.calls).toEqual(["checkpoint", "restore", "rollback"]);
});

it("reports a missing profile instead of touching the kernel", async () => {
	const state = recorder();
	await expect(new NotebookProfileController(state.host).load("absent")).rejects.toThrow(
		"not found or invalid: absent",
	);
	expect(state.calls).toEqual(["checkpoint"]);
});

it("lists profiles with an optional glob and refuses an empty one", () => {
	const state = recorder();
	for (const name of ["draft-one", "release-two"]) {
		writeNotebookProfile({ name, agentDir: state.agentDir, sourceProject: "/repo", capture: capture() });
	}
	const controller = new NotebookProfileController(state.host);
	expect(controller.list().message).toContain("draft-one");
	expect(controller.list("draft-*").message).toContain("draft-one");
	expect(controller.list("draft-*").message).not.toContain("release-two");
	expect(controller.list("nothing").message).toBe('No notebook profiles match "nothing"');
	expect(() => controller.list("")).toThrow("Notebook glob is required");
});
