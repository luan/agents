import { expect, test } from "bun:test";
import { resolveSessionRuntimeOptions } from "./agent-runner";
import { readAssistantUsage } from "./usage";

test("shares the parent model runtime with subagents on Pi 0.80+", () => {
	const runtime = {};
	const registry = { runtime };

	expect(resolveSessionRuntimeOptions(registry)).toEqual({ modelRuntime: runtime });
});

test("keeps the legacy model registry path for older Pi versions", () => {
	const registry = {};

	expect(resolveSessionRuntimeOptions(registry)).toEqual({ modelRegistry: registry });
});

test("captures assistant cost for parent-session accounting", () => {
	expect(
		readAssistantUsage({
			usage: {
				input: 120,
				output: 30,
				cacheWrite: 10,
				cost: { total: 0.42 },
			},
		}),
	).toEqual({ input: 120, output: 30, cacheWrite: 10, cost: 0.42 });
});
