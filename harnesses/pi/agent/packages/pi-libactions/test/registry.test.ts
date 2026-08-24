import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureActionsRegistry, loadActionKeybindings } from "../src/sdk.ts";

describe("pi-libactions registry", () => {
	test("supports consumer-first registration and identity-safe disposal", () => {
		const scope = Object.create(null) as typeof globalThis;
		const registry = ensureActionsRegistry(scope);
		const action = { id: "test.action", description: "Test", run: () => {} };
		const remove = registry.register(action);
		expect(registry.find(action.id)).toBe(action);
		remove();
		expect(registry.find(action.id)).toBeUndefined();
	});

	test("isolates listener failures", () => {
		const scope = Object.create(null) as typeof globalThis;
		const registry = ensureActionsRegistry(scope);
		registry.onRegister(() => {
			throw new Error("listener");
		});
		expect(() => registry.register({ id: "safe", description: "Safe", run: () => {} })).not.toThrow();
	});

	test("loads one strict immutable user keybinding snapshot", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-libactions-"));
		const path = join(directory, "keybindings.json");
		writeFileSync(path, JSON.stringify({ action: ["ctrl+c", "bad+key"], single: "space", invalid: 42 }));
		const bindings = loadActionKeybindings(path);
		expect(bindings).toEqual({ action: ["ctrl+c"], single: ["space"], invalid: [] });
		expect(Object.isFrozen(bindings)).toBe(true);
		expect(Object.isFrozen(bindings.action)).toBe(true);
	});
});
