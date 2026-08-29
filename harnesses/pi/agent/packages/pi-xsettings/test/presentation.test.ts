import { afterEach, expect, test } from "bun:test";
import { XSETTINGS_REGISTRY_KEY, ensureXSettingsRegistry } from "../src/protocol/settings.ts";
import {
	DEFAULT_XSETTINGS_PRESENTATION_SETTINGS,
	registerXSettingsPresentationSettings,
} from "../src/config/presentation.ts";

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[XSETTINGS_REGISTRY_KEY];
});

test("registers side-panel and fullscreen settings presentation choices", () => {
	const unregister = registerXSettingsPresentationSettings();
	try {
		const definition = ensureXSettingsRegistry().registrations["pi-xsettings"]?.definitions.find(
			(candidate) => candidate.key === "presentation",
		);
		expect(DEFAULT_XSETTINGS_PRESENTATION_SETTINGS.presentation).toBe("side-panel");
		expect(definition).toMatchObject({
			category: "appearance",
			page: "ui",
			section: "Settings",
			type: "enum",
			default: "side-panel",
		});
		if (definition?.type !== "enum" || !Array.isArray(definition.options))
			throw new Error("Settings presentation must be an enum");
		expect(definition.options.map((option) => option.value)).toEqual(["side-panel", "fullscreen"]);
	} finally {
		unregister();
	}
});
