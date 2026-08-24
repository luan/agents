import { afterEach, expect, test } from "bun:test";
import { getModelRoleCatalog, registerModelRoleSettings } from "../src/config/settings.ts";
import { DEFAULT_MODEL_ROLE_CATALOG } from "../src/sdk.ts";

const REGISTRY_KEY = Symbol.for("pi-xsettings/registry/v1");

interface SettingsRegistry {
	publish(namespace: string, values: Record<string, object | string>): Promise<void>;
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, REGISTRY_KEY);
});

test("uses compiled defaults standalone and applies published role settings immediately", async () => {
	const unregisterSettings = registerModelRoleSettings();

	expect(getModelRoleCatalog().defaultRole).toBe("balanced");
	const registry = Reflect.get(globalThis, REGISTRY_KEY) as SettingsRegistry;
	await registry.publish("pi-model-roles", {
		defaultRole: "tiny",
		subagentDefaultRole: "task",
		roles: DEFAULT_MODEL_ROLE_CATALOG.roles,
	});
	expect(getModelRoleCatalog().defaultRole).toBe("tiny");

	unregisterSettings();
});
