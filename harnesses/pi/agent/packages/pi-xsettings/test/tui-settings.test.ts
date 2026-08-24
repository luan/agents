import { afterEach, describe, expect, test } from "bun:test";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, getTuiAppearance, icon } from "pi-libtui";
import { ensureXSettingsRegistry } from "../src/protocol/settings.ts";
import { registerTuiSettings } from "../src/config/tui-settings.ts";

describe("pi-libtui settings", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("uses portable appearance defaults", () => {
		expect(DEFAULT_TUI_APPEARANCE).toEqual({
			iconPack: "unicode",
			powerline: false,
			powerlineButtons: false,
			softCursor: false,
			insertionCursor: "virtual",
			navigationCursor: "virtual",
			selectionCursor: "virtual",
		});
	});

	test("registers typed appearance settings and applies published values", async () => {
		const unregister = registerTuiSettings();
		const registration = ensureXSettingsRegistry().registrations["pi-libtui"];
		expect(registration?.definitions.map((definition) => definition.key)).toEqual([
			"iconPack",
			"powerline",
			"powerlineButtons",
			"softCursor",
			"insertionCursor",
			"navigationCursor",
			"selectionCursor",
		]);
		expect(registration?.definitions.find((definition) => definition.key === "powerline")?.label).toBe(
			"Powerline separators",
		);
		expect(registration?.definitions.find((definition) => definition.key === "powerlineButtons")?.label).toBe(
			"Powerline buttons",
		);

		await ensureXSettingsRegistry().publish("pi-libtui", {
			iconPack: "unicode",
			powerline: false,
			powerlineButtons: true,
			softCursor: true,
			insertionCursor: "blinking-bar",
			navigationCursor: "steady-block",
			selectionCursor: "steady-underline",
		});
		expect(getTuiAppearance()).toEqual({
			iconPack: "unicode",
			powerline: false,
			powerlineButtons: true,
			softCursor: true,
			insertionCursor: "blinking-bar",
			navigationCursor: "steady-block",
			selectionCursor: "steady-underline",
		});
		expect(icon("comment")).toBe("✎");
		unregister();
	});
});
