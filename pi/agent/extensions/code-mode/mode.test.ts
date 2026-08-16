import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("keeps the enabled toggle after a write", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-code-mode-runtime-"));
	const modulePath = join(directory, "mode.ts");
	const stateKey = Symbol.for("agents.codeMode");
	delete (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey];

	try {
		await writeFile(modulePath, await readFile(new URL("./mode.ts", import.meta.url), "utf8"));
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

test("saves the next runtime while the active one stays pinned for this process", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-code-mode-backend-"));
	const modulePath = join(directory, "mode.ts");
	const stateKey = Symbol.for("agents.codeMode");
	delete (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey];

	try {
		await writeFile(modulePath, await readFile(new URL("./mode.ts", import.meta.url), "utf8"));
		await writeFile(join(directory, "config.json"), '{"enabled":true,"runtime":"rust"}\n');

		const settings = await import(`${pathToFileURL(modulePath).href}?backend-initial`);
		expect(settings.getActiveCodeModeRuntime()).toBe("rust");

		settings.setCodeModeRuntime("notebook");
		expect(settings.getCodeModeRuntime()).toBe("notebook");
		// A live kernel must not change backend underneath a running cell.
		expect(settings.getActiveCodeModeRuntime()).toBe("rust");

		// The pin lives on globalThis for the process lifetime. A fresh module at a fresh path with the
		// slot cleared is the only way to model the next pi process; bun serves a query-string variant
		// from cache.
		delete (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey];
		const nextProcessPath = join(directory, "mode-next-runtime.ts");
		await writeFile(nextProcessPath, await readFile(new URL("./mode.ts", import.meta.url), "utf8"));
		const reloaded = await import(pathToFileURL(nextProcessPath).href);
		expect(reloaded.getActiveCodeModeRuntime()).toBe("notebook");
	} finally {
		delete (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey];
		await rm(directory, { force: true, recursive: true });
	}
});

test("an unknown runtime in config.json falls back to rust", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-code-mode-bad-"));
	const modulePath = join(directory, "mode.ts");
	const stateKey = Symbol.for("agents.codeMode");
	delete (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey];

	try {
		await writeFile(modulePath, await readFile(new URL("./mode.ts", import.meta.url), "utf8"));
		await writeFile(join(directory, "config.json"), '{"enabled":true,"runtime":"bun"}\n');
		const settings = await import(`${pathToFileURL(modulePath).href}?backend-unknown`);
		expect(settings.getActiveCodeModeRuntime()).toBe("rust");
	} finally {
		delete (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey];
		await rm(directory, { force: true, recursive: true });
	}
});
