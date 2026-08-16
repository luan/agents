import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("persists the enabled toggle across a reload and ignores a stray on-disk runtime key", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-code-mode-runtime-"));
	const modulePath = join(directory, "mode.ts");
	const stateKey = Symbol.for("agents.codeMode");
	delete (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey];

	try {
		await writeFile(modulePath, await readFile(new URL("./mode.ts", import.meta.url), "utf8"));
		// An upgraded user's config.json still carries the deleted "runtime" key; it must be tolerated, not read.
		await writeFile(join(directory, "config.json"), '{"enabled":true,"runtime":"rust"}\n');

		const settings = await import(`${pathToFileURL(modulePath).href}?initial`);
		expect(settings.isCodeModeEnabled()).toBe(true);

		settings.setCodeModeEnabled(false);
		expect(settings.isCodeModeEnabled()).toBe(false);

		const reloaded = await import(`${pathToFileURL(modulePath).href}?reload`);
		expect(reloaded.isCodeModeEnabled()).toBe(false);
	} finally {
		delete (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey];
		await rm(directory, { force: true, recursive: true });
	}
});
