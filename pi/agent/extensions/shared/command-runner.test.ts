import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommand, runCommand } from "./command-runner.ts";

const originalHome = process.env.HOME;
const originalPath = process.env.PATH;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
});

describe("command runner", () => {
	it("resolves commands from caller-provided search paths when the process PATH is sparse", () => {
		const home = join(tmpdir(), `pi-command-runner-home-${crypto.randomUUID()}`);
		const bin = join(home, ".zerobrew", "bin");
		const rg = join(bin, "rg");
		mkdirSync(bin, { recursive: true });
		writeFileSync(rg, "#!/bin/sh\nexit 0\n");
		chmodSync(rg, 0o755);
		process.env.HOME = home;
		process.env.PATH = "";

		expect(resolveCommand("rg", ["~/.zerobrew/bin"])).toBe(rg);
	});

	it("runs resolved commands with stdout, stderr, and exit status", async () => {
		const dir = join(tmpdir(), `pi-command-runner-cwd-${crypto.randomUUID()}`);
		mkdirSync(dir, { recursive: true });
		const bin = join(dir, "bin");
		const tool = join(bin, "tool");
		mkdirSync(bin);
		writeFileSync(tool, "#!/bin/sh\nprintf out\nprintf err >&2\nexit 7\n");
		chmodSync(tool, 0o755);
		process.env.PATH = "";

		const result = await runCommand("tool", [], dir, { allowNonZero: true, extraSearchPaths: [bin] });

		expect(result).toEqual({ stdout: "out", stderr: "err", exitCode: 7 });
	});

	it("rejects oversized command output before converting it to a string", async () => {
		const dir = join(tmpdir(), `pi-command-runner-output-${crypto.randomUUID()}`);
		mkdirSync(dir, { recursive: true });
		const bin = join(dir, "bin");
		const tool = join(bin, "noisy");
		mkdirSync(bin);
		writeFileSync(tool, "#!/bin/sh\nprintf 1234567890\n");
		chmodSync(tool, 0o755);
		process.env.PATH = "";

		await expect(runCommand("noisy", [], dir, { extraSearchPaths: [bin], maxOutputBytes: 4 })).rejects.toThrow(
			/exceeded 4 bytes of output/,
		);
	});

	it("reports a missing working directory without blaming the command PATH", async () => {
		await expect(runCommand("rg", [], join(tmpdir(), `missing-${crypto.randomUUID()}`))).rejects.toThrow(
			/Working directory not found/,
		);
	});
});
