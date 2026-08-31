import { afterEach, expect, test } from "bun:test";
import {
	DEFAULT_CUSTOM_EDITOR_SETTINGS,
	getCustomEditorSettings,
	registerCustomEditorSettings,
} from "../src/config/settings.ts";

const REGISTRY_KEY = Symbol.for("pi-xsettings/registry/v1");

interface SettingsRegistry {
	registrations: Record<string, { definitions: readonly { page?: string }[] } | undefined>;
	publish(namespace: string, values: Record<string, object | string>): Promise<void>;
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, REGISTRY_KEY);
});

test("uses compiled defaults standalone and applies live presentation settings", async () => {
	const unregisterSettings = registerCustomEditorSettings();
	const registry = Reflect.get(globalThis, REGISTRY_KEY) as SettingsRegistry;

	expect(getCustomEditorSettings()).toEqual(DEFAULT_CUSTOM_EDITOR_SETTINGS);
	expect(
		registry.registrations["pi-custom-editor"]?.definitions.every((definition) => definition.page === "editor"),
	).toBe(true);
	await registry.publish("pi-custom-editor", {
		preset: "borderless",
		leftRail: "static",
		promptMarker: "chevron",
		footer: "off",
		workingPlacement: "bottom-left-start",
		railTone: "border",
	});

	expect(getCustomEditorSettings()).toEqual({
		...DEFAULT_CUSTOM_EDITOR_SETTINGS,
		preset: "borderless",
		leftRail: "static",
		promptMarker: "chevron",
		footer: "off",
		workingPlacement: "bottom-left-start",
		railTone: "border",
	});
	await registry.publish("pi-custom-editor", DEFAULT_CUSTOM_EDITOR_SETTINGS);
	unregisterSettings();
});
