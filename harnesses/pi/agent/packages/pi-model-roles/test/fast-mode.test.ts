import { expect, test } from "bun:test";
import { DEFAULT_MODEL_ROLE_CATALOG, type ModelWithServiceTier } from "../src/core/catalog.ts";
import { ModelRolesRuntime, type ModelRolesHost } from "../src/runtime/roles.ts";
import { context, model } from "./fixtures.ts";

test("role selection carries the requested service tier on the selected model", async () => {
	const selected: ModelWithServiceTier[] = [];
	const host: ModelRolesHost = {
		async setModel(next) {
			selected.push(next);
			return true;
		},
		setThinkingLevel() {},
		appendSelection() {},
	};
	const catalog = {
		...DEFAULT_MODEL_ROLE_CATALOG,
		roles: DEFAULT_MODEL_ROLE_CATALOG.roles.map((role) =>
			role.name === "quick"
				? { ...role, candidates: [{ ...role.candidates[0]!, serviceTier: "priority" as const }] }
				: role,
		),
	};
	const runtime = new ModelRolesRuntime(host, () => catalog);

	await runtime.select("quick", context({ available: [model("gpt-5.6-sol")] }));

	expect(selected[0]?.serviceTier).toBe("priority");
});
