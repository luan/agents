import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listNotebookProfiles,
	type NotebookProfileCapture,
	notebookProfileBindingNames,
	readNotebookProfile,
	writeNotebookProfile,
} from "./profile-state.ts";
import { assertSafeProfileDirectory, profileStatePaths, readProfileStateManifest } from "./profile-state-format.ts";

const MAX_BYTES = 1024 * 1024;

function agentDir(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-notebook-profile-")), "agent");
}

function capture(overrides: Partial<NotebookProfileCapture> = {}): NotebookProfileCapture {
	const payload = Buffer.from("alphabeta");
	return {
		deno: "2.9.5",
		v8: "14.0",
		payload,
		entries: [
			{ name: "alpha", kind: "value", offset: 0, length: 5 },
			{ name: "beta", kind: "function", offset: 5, length: 4 },
		],
		skipped: [{ name: "socket", reason: "not serializable" }],
		...overrides,
	};
}

function save(dir: string, name = "work"): void {
	writeNotebookProfile({ name, agentDir: dir, sourceProject: "/repo", capture: capture() });
}

it("writes a profile and reads back its bytes", () => {
	const dir = agentDir();
	const summary = writeNotebookProfile({ name: "work", agentDir: dir, sourceProject: "/repo", capture: capture() });
	expect(summary).toMatchObject({ name: "work", values: 1, definitions: 1, skipped: 1 });

	const snapshot = readNotebookProfile("work", dir, MAX_BYTES);
	expect(snapshot.payload.toString()).toBe("alphabeta");
	expect(snapshot.manifest.entries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
	expect(notebookProfileBindingNames("work", dir, MAX_BYTES)).toEqual(["alpha", "beta"]);
});

it("rejects a capture the kernel got wrong", () => {
	const dir = agentDir();
	const cases: Array<[Partial<NotebookProfileCapture>, string]> = [
		[{ entries: [{ name: "1bad", kind: "value", offset: 0, length: 9 }] }, "binding name"],
		[
			{
				entries: [
					{ name: "alpha", kind: "value", offset: 0, length: 5 },
					{ name: "alpha", kind: "value", offset: 5, length: 4 },
				],
			},
			"twice",
		],
		[{ entries: [{ name: "alpha", kind: "value", offset: 1, length: 8 }] }, "not contiguous"],
		[{ entries: [{ name: "alpha", kind: "value", offset: 0, length: 99 }] }, "not contiguous"],
		[{ entries: [{ name: "alpha", kind: "value", offset: 0, length: 5 }] }, "unclaimed payload bytes"],
	];
	for (const [overrides, message] of cases) {
		expect(() =>
			writeNotebookProfile({ name: "work", agentDir: dir, sourceProject: "/repo", capture: capture(overrides) }),
		).toThrow(message);
	}
});

it("rejects a profile name that is not a plain identifier-safe name", () => {
	const dir = agentDir();
	for (const name of ["", "../escape", "with/slash", "-leading", "a".repeat(65)]) {
		expect(() => writeNotebookProfile({ name, agentDir: dir, sourceProject: "/repo", capture: capture() })).toThrow(
			"Notebook profile name must be",
		);
	}
});

it("rejects a tampered payload before any caller sees it", () => {
	const dir = agentDir();
	save(dir);
	const paths = profileStatePaths("work", dir);
	const manifest = readProfileStateManifest(paths.manifest, "work")!;
	writeFileSync(join(paths.directory, manifest.payload), "alphaBETA");
	expect(() => readNotebookProfile("work", dir, MAX_BYTES)).toThrow("payload is missing or invalid");
	expect(notebookProfileBindingNames("work", dir, MAX_BYTES)).toEqual([]);
});

it("rejects a payload larger than the budget", () => {
	const dir = agentDir();
	save(dir);
	expect(() => readNotebookProfile("work", dir, 4)).toThrow("payload is missing or invalid");
});

it("rejects a manifest with a bad schema, a renamed profile, or a payload path", () => {
	const dir = agentDir();
	save(dir);
	const paths = profileStatePaths("work", dir);
	const valid = JSON.parse(readFileSync(paths.manifest, "utf8")) as Record<string, unknown>;

	for (const broken of [
		{ ...valid, schema: 2 },
		{ ...valid, name: "other" },
		{ ...valid, payload: "../escape.bin" },
		{ ...valid, payload: "profile.txt" },
		{ ...valid, entries: [{ name: "alpha", kind: "value", offset: 0, length: 5, hash: "nothex" }] },
		{ ...valid, entries: [{ name: "alpha", kind: "mystery", offset: 0, length: 5, hash: "a".repeat(64) }] },
		{ ...valid, skipped: [{ name: "socket" }] },
	]) {
		writeFileSync(paths.manifest, JSON.stringify(broken));
		expect(readProfileStateManifest(paths.manifest, "work")).toBeUndefined();
		expect(() => readNotebookProfile("work", dir, MAX_BYTES)).toThrow("not found or invalid");
	}
});

it("rejects a symlinked manifest", () => {
	const dir = agentDir();
	const paths = profileStatePaths("linked", dir);
	mkdirSync(paths.directory, { recursive: true });
	const target = join(mkdtempSync(join(tmpdir(), "pi-notebook-profile-target-")), "profile.json");
	writeFileSync(target, "{}");
	symlinkSync(target, paths.manifest);
	expect(readProfileStateManifest(paths.manifest, "linked")).toBeUndefined();
});

it("refuses profile storage that leaves the agent directory or crosses a symlink", () => {
	const dir = agentDir();
	mkdirSync(dir, { recursive: true });
	expect(() => assertSafeProfileDirectory(join(dir, "..", "elsewhere"), dir)).toThrow("escaped agent storage");
	expect(() => assertSafeProfileDirectory(dir, dir)).toThrow("escaped agent storage");

	const elsewhere = mkdtempSync(join(tmpdir(), "pi-notebook-profile-out-"));
	symlinkSync(elsewhere, join(dir, "notebook"));
	expect(() => assertSafeProfileDirectory(profileStatePaths("work", dir).directory, dir)).toThrow("symlinked path");
});

it("lists valid profiles sorted and skips broken ones", () => {
	const dir = agentDir();
	save(dir, "zeta");
	save(dir, "alpha");
	const brokenPaths = profileStatePaths("broken", dir);
	mkdirSync(brokenPaths.directory, { recursive: true });
	writeFileSync(brokenPaths.manifest, "{ not json");
	expect(listNotebookProfiles(dir).map((profile) => profile.name)).toEqual(["alpha", "zeta"]);
	expect(listNotebookProfiles(join(dir, "missing"))).toEqual([]);
});

it("drops the previous payload when a profile is saved again", () => {
	const dir = agentDir();
	save(dir);
	const first = readProfileStateManifest(profileStatePaths("work", dir).manifest, "work")!;
	save(dir);
	const second = readProfileStateManifest(profileStatePaths("work", dir).manifest, "work")!;
	expect(second.payload).not.toBe(first.payload);
	expect(() => readFileSync(join(profileStatePaths("work", dir).directory, first.payload))).toThrow();
	expect(readNotebookProfile("work", dir, MAX_BYTES).payload.toString()).toBe("alphabeta");
});
