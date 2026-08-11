import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Test support: writes an executable stub and returns its path, reusing it across runs.
 *
 * macOS charges roughly 350ms to exec a file it has never seen, and about 15ms every time after.
 * A stub written into a fresh temp directory is new on every run, so each test that execs one pays
 * that toll again. Keying the directory by content hash keeps the toll to once per machine per stub
 * while still handing out a fresh path whenever the stub body changes.
 */
export function fixtureScript(name: string, body: string): string {
	const path = join(tmpdir(), "pi-fixture-scripts", Bun.hash(body).toString(16), name);
	if (existsSync(path)) return path;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body, "utf8");
	chmodSync(path, 0o755);
	return path;
}

/** The directory holding a stub, for callers that pass it as a command search path. */
export function fixtureScriptDir(path: string): string {
	return dirname(path);
}
