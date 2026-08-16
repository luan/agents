import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, artifactsDirForSessionFile } from "./artifact-store.ts";

function scratchDir(): string {
	return join(mkdtempSync(join(tmpdir(), "artifact-store-")), "session");
}

describe("ArtifactStore ids", () => {
	it("hands out distinct ids when the first mints race", async () => {
		// The seeding scan yields at its readdir. Without a shared init promise
		// every racer would finish the scan against an empty directory and reseed
		// the counter to 0, so two artifacts would claim id 0 and the second write
		// would silently replace the first.
		const store = new ArtifactStore(scratchDir());
		const ids = await Promise.all(Array.from({ length: 16 }, (_, index) => store.mint(`body ${index}`, "exec")));

		expect(new Set(ids).size).toBe(16);
		expect(await store.listIds()).toEqual(
			ids
				.map(Number)
				.sort((a, b) => a - b)
				.map(String),
		);
	});

	it("continues past the artifacts a previous session left behind", async () => {
		const dir = scratchDir();
		const first = new ArtifactStore(dir);
		await first.mint("one", "read");
		await first.mint("two", "read");

		// A resume constructs a new store over the same directory.
		const resumed = new ArtifactStore(dir);
		expect(await resumed.mint("three", "read")).toBe("2");
		expect(await resumed.read((await resumed.resolve("0"))!)).toBe("one");
	});
});

describe("ArtifactStore storage", () => {
	it("round-trips through a file named after the tool", async () => {
		const dir = scratchDir();
		const store = new ArtifactStore(dir);
		const id = await store.mint("captured output", "exec_command (nested)");

		const artifact = await store.resolve(id!);
		expect(artifact?.path).toBe(join(dir, "0.exec_command_nested.log"));
		expect(await store.read(artifact!)).toBe("captured output");
	});

	it("keeps artifacts in memory for a session with no file", async () => {
		const store = new ArtifactStore();
		const id = await store.mint("no session on disk", "search result");

		const artifact = await store.resolve(id!);
		expect(artifact?.path).toBeUndefined();
		expect(await store.read(artifact!)).toBe("no session on disk");
	});

	it("replaces accumulated process output without changing its id", async () => {
		const store = new ArtifactStore();
		const id = await store.mint("first chunk", "write_stdin");

		expect(await store.replace(id!, "first chunk\nsecond chunk")).toBe(true);
		expect(await store.read((await store.resolve(id!))!)).toBe("first chunk\nsecond chunk");
		expect(await store.replace("missing", "ignored")).toBe(false);
	});

	it("returns undefined rather than throwing when the store cannot be written", async () => {
		// The minter runs midway through returning an already-truncated tool
		// result. A store that cannot be written must cost the recovery pointer in
		// the truncation notice, never the tool call itself.
		const blocked = join(mkdtempSync(join(tmpdir(), "artifact-store-")), "not-a-dir");
		writeFileSync(blocked, "");
		const store = new ArtifactStore(blocked);

		expect(await store.mint("body", "exec")).toBeUndefined();
	});
});

describe("artifactsDirForSessionFile", () => {
	it("strips the transcript extension so artifacts sit beside the session", () => {
		expect(artifactsDirForSessionFile("/s/2026-08-12T00-00-00-000Z_abc.jsonl")).toBe(
			"/s/2026-08-12T00-00-00-000Z_abc",
		);
	});
});
