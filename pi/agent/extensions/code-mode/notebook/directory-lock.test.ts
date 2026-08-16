import { expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireDirectoryLock } from "./directory-lock.ts";

it("reclaims a stale owner without deleting a replacement lock", async () => {
	const root = join(tmpdir(), `pi-notebook-lock-${process.pid}-${Date.now()}`);
	const path = join(root, "lock");
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "stale.owner"), "stale\n");
	const old = new Date(Date.now() - 60_000);
	utimesSync(join(path, "stale.owner"), old, old);
	utimesSync(path, old, old);
	try {
		const lock = await acquireDirectoryLock(path, { waitMs: 1_000, staleMs: 1_000, pollMs: 1 });
		expect(lock).toBeTruthy();
		const [owner] = readdirSync(path);
		expect(owner).toMatch(/\.owner$/);
		// Another process replaces the whole lock directory before this holder releases.
		unlinkSync(join(path, owner));
		rmdirSync(path);
		mkdirSync(path);
		writeFileSync(join(path, "replacement.owner"), "replacement\n");
		lock?.release();
		expect(existsSync(join(path, "replacement.owner"))).toBe(true);

		const legacyPath = join(root, "legacy.lock");
		writeFileSync(legacyPath, "old file lock\n");
		utimesSync(legacyPath, old, old);
		const migrated = await acquireDirectoryLock(legacyPath, { waitMs: 1_000, staleMs: 1_000, pollMs: 1 });
		expect(migrated).toBeTruthy();
		migrated?.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps a live lease beyond its stale window", async () => {
	const root = join(tmpdir(), `pi-notebook-live-lock-${process.pid}-${Date.now()}`);
	const path = join(root, "lock");
	let lock: Awaited<ReturnType<typeof acquireDirectoryLock>>;
	let replacement: Awaited<ReturnType<typeof acquireDirectoryLock>>;
	mkdirSync(root, { recursive: true });
	try {
		lock = await acquireDirectoryLock(path, { waitMs: 1_000, staleMs: 90, pollMs: 5 });
		expect(lock).toBeTruthy();
		// The heartbeat runs every 30ms, so 220ms of holding must not look abandoned.
		await delay(220);
		await expect(acquireDirectoryLock(path, { waitMs: 60, staleMs: 90, pollMs: 5 })).rejects.toThrow(
			/timed out waiting for lock/,
		);
		lock?.release();
		lock = undefined;
		replacement = await acquireDirectoryLock(path, { waitMs: 1_000, staleMs: 90, pollMs: 5 });
		expect(replacement).toBeTruthy();
		replacement?.release();
		replacement = undefined;
	} finally {
		lock?.release();
		replacement?.release();
		rmSync(root, { recursive: true, force: true });
	}
});

it("stops waiting when the caller says so", async () => {
	const root = join(tmpdir(), `pi-notebook-stop-lock-${process.pid}-${Date.now()}`);
	const path = join(root, "lock");
	mkdirSync(root, { recursive: true });
	try {
		const held = await acquireDirectoryLock(path, { waitMs: 1_000, staleMs: 60_000, pollMs: 5 });
		expect(held).toBeTruthy();
		expect(
			await acquireDirectoryLock(path, { waitMs: 1_000, staleMs: 60_000, pollMs: 5, stopWaiting: () => true }),
		).toBeUndefined();
		held?.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
