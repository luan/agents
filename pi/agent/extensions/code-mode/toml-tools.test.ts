import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOML_TOOLS_DIRNAME, tomlYieldTimeForSource } from "./toml-tools.ts";

it("uses the longest configured yield for TOML tools called by a cell", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-toml-yield-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const globalTools = join(agentDir, TOML_TOOLS_DIRNAME);
	const projectTools = join(projectDir, ".pi", TOML_TOOLS_DIRNAME);
	mkdirSync(globalTools, { recursive: true });
	mkdirSync(projectTools, { recursive: true });
	writeFileSync(
		join(globalTools, "slow_probe.toml"),
		'usage = "probe input"\ncommand = "printf"\nyield_time_ms = 1200\n',
	);
	writeFileSync(
		join(projectTools, "slower_probe.toml"),
		'usage = "probe input"\ncommand = "printf"\nyield_time_ms = 2400\n',
	);

	expect(
		tomlYieldTimeForSource(
			'await Promise.all([tools.slow_probe("a"), tools["slower_probe"]("b")]);',
			projectDir,
			agentDir,
		),
	).toBe(2400);
	expect(tomlYieldTimeForSource('text("no tool call")', projectDir, agentDir)).toBeUndefined();
});
