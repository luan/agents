import { expect, test } from "bun:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { DEFAULT_MODEL_ROLE_CATALOG, type ModelWithServiceTier } from "../src/core/catalog.ts";
import { ModelRolesRuntime, type ModelRolesHost } from "../src/runtime/roles.ts";
import { MODEL_ROLE_SELECTION_ENTRY } from "../src/runtime/selection.ts";
import { context, customEntry, model } from "./fixtures.ts";

function host() {
	const selectedModels: ModelWithServiceTier[] = [];
	const thinking: ThinkingLevel[] = [];
	const selections: Array<string | null> = [];
	const value: ModelRolesHost = {
		async setModel(next) {
			selectedModels.push(next);
			return true;
		},
		setThinkingLevel(level) {
			thinking.push(level);
		},
		appendSelection(role) {
			selections.push(role);
		},
	};
	return { value, selectedModels, thinking, selections };
}

test("restores a session role and applies its model and thinking level", async () => {
	const fixture = host();
	const statuses: Array<string | undefined> = [];
	const luna = model("gpt-5.6-luna");
	const runtime = new ModelRolesRuntime(fixture.value, () => DEFAULT_MODEL_ROLE_CATALOG);
	const ctx = context({
		model: model("gpt-5.6-sol"),
		available: [luna],
		statuses,
		entries: [customEntry(MODEL_ROLE_SELECTION_ENTRY, { version: 1, role: "tiny" })],
	});

	await runtime.restore(ctx);

	expect(fixture.selectedModels[0]).toMatchObject(luna);
	expect(fixture.selectedModels[0]?.serviceTier).toBe("standard");
	expect(fixture.thinking).toEqual(["low"]);
	expect(stripTerminalSequences(statuses.at(-1) ?? "")).toBe("tiny");
});

test("uses the configured default when the session has no role selection", async () => {
	const fixture = host();
	const luna = model("gpt-5.6-luna");
	const runtime = new ModelRolesRuntime(fixture.value, () => ({
		...DEFAULT_MODEL_ROLE_CATALOG,
		defaultRole: "tiny",
	}));
	const ctx = context({ available: [luna] });

	await runtime.restore(ctx);

	expect(fixture.selectedModels[0]).toMatchObject(luna);
	expect(fixture.selectedModels[0]?.serviceTier).toBe("standard");
	expect(fixture.thinking).toEqual(["low"]);
});

test("keeps the requested role selected when its model falls back to the default", async () => {
	const fixture = host();
	const runtime = new ModelRolesRuntime(fixture.value, () => DEFAULT_MODEL_ROLE_CATALOG);
	const ctx = context({ available: [model("gpt-5.6-sol")] });

	await runtime.select("tiny", ctx);

	expect(runtime.currentRole()).toBe("tiny");
});

test("persists explicit selection and clear without entering model context", async () => {
	const fixture = host();
	const runtime = new ModelRolesRuntime(fixture.value, () => DEFAULT_MODEL_ROLE_CATALOG);
	const ctx = context({ available: [model("gpt-5.6-luna"), model("gpt-5.6-sol")] });

	await runtime.select("quick", ctx);
	await runtime.clear(ctx);

	expect(fixture.selections).toEqual(["quick", null]);
	expect(fixture.thinking).toEqual(["low", "medium"]);
});

test("persists clear even when the configured default cannot resolve", async () => {
	const fixture = host();
	const runtime = new ModelRolesRuntime(fixture.value, () => DEFAULT_MODEL_ROLE_CATALOG);
	const ctx = context({ available: [model("gpt-5.6-luna")] });

	await runtime.select("tiny", ctx);
	await runtime.clear(ctx);

	expect(fixture.selections).toEqual(["tiny", null]);
});

test("manual model or thinking changes clear the active role indicator", async () => {
	const fixture = host();
	const statuses: Array<string | undefined> = [];
	const runtime = new ModelRolesRuntime(fixture.value, () => DEFAULT_MODEL_ROLE_CATALOG);
	const ctx = context({ available: [model("gpt-5.6-sol")], statuses });

	await runtime.select("balanced", ctx);
	runtime.thinkingSelected("high", ctx);
	await runtime.select("balanced", ctx);
	runtime.modelSelected("openai-codex", "gpt-5.6-luna", ctx);

	expect(statuses.map((status) => (status === undefined ? undefined : stripTerminalSequences(status)))).toEqual([
		"balanced",
		undefined,
		"balanced",
		undefined,
	]);
});
