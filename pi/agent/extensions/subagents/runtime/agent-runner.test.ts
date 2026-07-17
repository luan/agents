import { expect, test } from "bun:test";
import { resolveSessionRuntimeOptions } from "./agent-runner";

test("shares the parent model runtime with subagents on Pi 0.80+", () => {
	const runtime = {};
	const registry = { runtime };

	expect(resolveSessionRuntimeOptions(registry)).toEqual({ modelRuntime: runtime });
});

test("keeps the legacy model registry path for older Pi versions", () => {
	const registry = {};

	expect(resolveSessionRuntimeOptions(registry)).toEqual({ modelRegistry: registry });
});
