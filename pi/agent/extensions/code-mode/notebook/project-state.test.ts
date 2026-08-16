import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROJECT_STATE_SCHEMA,
	type ProjectStateCandidate,
	type ProjectStateManifest,
	readProjectConflictRecord,
	readProjectStateManifest,
} from "./project-state-format.ts";
import { mergeProjectState } from "./project-state-merge.ts";
import { parseProjectBindingNames } from "./project-state-runtime.ts";

it("rejects a manifest whose binding name is executable", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-notebook-project-format-"));
	const path = join(root, "project.json");
	try {
		writeFileSync(
			path,
			JSON.stringify({
				schema: PROJECT_STATE_SCHEMA,
				project: "/project",
				generation: "generation",
				deno: "2.9.5",
				v8: "test",
				payload: "project-00000000-0000-0000-0000-000000000000.bin",
				createdAt: "2026-01-01T00:00:00.000Z",
				sourceSession: "session",
				entries: [
					{
						name: "safe);globalThis.injected=true;//",
						kind: "value",
						offset: 0,
						length: 0,
						hash: hash(Buffer.alloc(0)),
					},
				],
				skipped: [],
			}),
		);
		expect(readProjectStateManifest(path)).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("rejects a conflict payload outside its own record", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-notebook-project-conflict-"));
	const path = join(root, "conflict.json");
	try {
		for (const payload of ["../../outside.bin", "123-00000000-0000-0000-0000-000000000000.bin"]) {
			writeFileSync(
				path,
				JSON.stringify({ schema: PROJECT_STATE_SCHEMA, entries: [{ name: "safe" }], deletions: [], payload }),
			);
			expect(readProjectConflictRecord(path)).toBeUndefined();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("preserves a concurrent same-name edit and settles on the next merge", () => {
	const base = Buffer.from("base");
	const current = Buffer.from("current");
	const candidate = Buffer.from("candidate");
	const manifest = projectManifest("current-generation", current);
	const merged = mergeProjectState({
		baseline: { generation: "base-generation", entries: [{ name: "shared", hash: hash(base) }] },
		current: manifest,
		candidate: projectCandidate(candidate),
		candidatePayload: candidate,
		currentPayload: current,
	});

	expect(merged.conflicts).toEqual(["shared"]);
	expect(merged.payload.toString()).toBe("current");
	expect(merged.baseline.entries).toEqual([{ name: "shared", hash: hash(candidate) }]);
	expect(merged.entries.map(({ name, kind, hash: entryHash }) => ({ name, kind, entryHash }))).toEqual([
		{ name: "shared", kind: "function", entryHash: hash(current) },
	]);

	const repeated = mergeProjectState({
		baseline: merged.baseline,
		current: manifest,
		candidate: projectCandidate(candidate),
		candidatePayload: candidate,
		currentPayload: current,
	});
	expect(repeated.conflicts).toEqual([]);
	expect(repeated.payload.toString()).toBe("current");
});

it("applies an uncontested edit and keeps the pin", () => {
	const previous = Buffer.from("previous");
	const payload = Buffer.from("value");
	const merged = mergeProjectState({
		baseline: { generation: "current", entries: [{ name: "shared", hash: hash(previous) }] },
		current: projectManifest("current", previous, true),
		candidate: projectCandidate(payload, "value"),
		candidatePayload: payload,
		currentPayload: previous,
	});

	expect(merged.changed).toBe(true);
	expect(merged.conflicts).toEqual([]);
	expect(merged.appliedNames).toEqual(["shared"]);
	expect(merged.baseline.entries).toEqual([{ name: "shared", hash: hash(payload) }]);
	expect(merged.entries[0]?.pinned).toBe(true);
	expect(merged.entries[0]?.updatedAt).toBeTruthy();
	expect(merged.payload.toString()).toBe("value");
});

it("refuses to pin a binding the merge did not retain", () => {
	const payload = Buffer.from("value");
	expect(() =>
		mergeProjectState({
			baseline: { generation: "root", entries: [] },
			candidate: projectCandidate(payload, "value"),
			candidatePayload: payload,
			currentPayload: Buffer.alloc(0),
			pins: { names: ["missing"], pinned: true },
		}),
	).toThrow(/Durable notebook bindings not found: missing/);
});

it("reads the binding list back off the marker line only", () => {
	const marker = "__MARKER__";
	expect(
		parseProjectBindingNames({ status: "ok", output: `noise\n${marker}["b","a","a"]\ntrailing` }, marker),
	).toEqual(["a", "b"]);
	expect(() => parseProjectBindingNames({ status: "ok", output: "no marker" }, marker)).toThrow(/returned no result/);
	expect(() => parseProjectBindingNames({ status: "ok", output: `${marker}["a);drop"]` }, marker)).toThrow(
		/invalid project binding list/,
	);
	expect(() => parseProjectBindingNames({ status: "error", errorText: "boom" }, marker)).toThrow(/boom/);
});

function projectCandidate(payload: Buffer, kind: "value" | "function" = "function"): ProjectStateCandidate {
	return {
		deno: "2.9.5",
		v8: "test",
		entries: [{ name: "shared", kind, offset: 0, length: payload.length }],
		skipped: [],
	};
}

function projectManifest(generation: string, payload: Buffer, pinned = false): ProjectStateManifest {
	return {
		schema: PROJECT_STATE_SCHEMA,
		project: "/project",
		generation,
		deno: "2.9.5",
		v8: "test",
		payload: "project-test.bin",
		createdAt: "2026-01-01T00:00:00.000Z",
		sourceSession: "session",
		entries: [
			{
				name: "shared",
				kind: "function",
				offset: 0,
				length: payload.length,
				hash: hash(payload),
				...(pinned ? { pinned: true as const } : {}),
			},
		],
		skipped: [],
	};
}

function hash(payload: Buffer): string {
	return createHash("sha256").update(payload).digest("hex");
}
