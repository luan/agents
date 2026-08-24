import { expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecCommandBinary } from "../src/binary.ts";

test("binary resolver accepts an explicit executable override", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-exec-command-"));
	const binary = join(directory, "bridge");
	await writeFile(binary, "#!/bin/sh\nexit 0\n");
	await chmod(binary, 0o755);
	expect(resolveExecCommandBinary({ override: binary })).toBe(binary);
});
