import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredPiValues, syncPiSettingsJson } from "../src/config/pi-settings.ts";

describe("Pi settings mirror", () => {
	test("reads owner-prefixed Pi values from category tables", () => {
		expect(
			configuredPiValues({
				appearance: { pi: { theme: "tokyo-night", terminal: { showImages: false } } },
				interaction: { pi: { steeringMode: "all" } },
			}),
		).toEqual({
			theme: "tokyo-night",
			"terminal.showImages": false,
			steeringMode: "all",
		});
	});

	test("updates xsettings-owned values and preserves bootstrap settings", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-"));
		try {
			const path = join(agentDir, "settings.json");
			await writeFile(path, `${JSON.stringify({ packages: ["packages/pi-xsettings"], theme: "dark" })}\n`);

			expect(await syncPiSettingsJson({ theme: "tokyo-night", "terminal.showImages": false }, agentDir)).toBe(true);

			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				packages: ["packages/pi-xsettings"],
				theme: "tokyo-night",
				terminal: { showImages: false },
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("creates settings.json for a standalone agent directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-xsettings-empty-"));
		try {
			expect(await syncPiSettingsJson({ theme: "dark" }, directory)).toBe(true);
			expect(JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("updates a managed settings link in place and removes stale owned values", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-settings-link-"));
		const repositoryFile = join(directory, "repository-settings.json");
		const agentDir = join(directory, "agent");
		try {
			await mkdir(agentDir);
			await writeFile(
				repositoryFile,
				`${JSON.stringify({ packages: ["packages/pi-xsettings"], theme: "dark", quietStartup: true })}\n`,
			);
			await symlink(repositoryFile, join(agentDir, "settings.json"));

			expect(await syncPiSettingsJson({ theme: "light" }, agentDir)).toBe(true);
			expect((await lstat(join(agentDir, "settings.json"))).isSymbolicLink()).toBe(true);
			expect(JSON.parse(await readFile(repositoryFile, "utf8"))).toEqual({
				packages: ["packages/pi-xsettings"],
				theme: "light",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
