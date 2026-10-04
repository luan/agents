import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchSettings } from "../src/runtime/settings-watch.ts";

test("stopping a watcher suppresses failures from an in-flight refresh", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-settings-watch-"));
	let stop = () => {};
	try {
		const path = join(directory, "xsettings.toml");
		await writeFile(path, "");
		const started = Promise.withResolvers<void>();
		const refresh = Promise.withResolvers<void>();
		const errors: Error[] = [];
		stop = watchSettings(
			[path],
			() => {
				started.resolve();
				return refresh.promise;
			},
			(error) => errors.push(error),
		);
		await started.promise;
		stop();
		refresh.reject(new Error("Session replaced"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(errors).toEqual([]);
	} finally {
		stop();
		await rm(directory, { recursive: true, force: true });
	}
});
