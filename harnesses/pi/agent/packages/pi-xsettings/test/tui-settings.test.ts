import { afterEach, describe, expect, test } from "bun:test";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, getTuiAppearance, icon } from "pi-libtui";
import { registerTuiSettings } from "../src/config/tui-settings.ts";
import { ensureXSettingsRegistry } from "../src/protocol/settings.ts";

describe("pi-libtui settings", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("uses portable appearance defaults", () => {
		expect(DEFAULT_TUI_APPEARANCE).toEqual({
			iconPack: "unicode",
			activityMarker: "spinner",
			shimmer: "off",
			shimmerMarker: false,
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
			"activityMarker",
			"shimmer",
			"shimmerMarker",
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
		const activityMarker = registration?.definitions.find((definition) => definition.key === "activityMarker");
		expect(activityMarker?.type).toBe("enum");
		if (activityMarker?.type !== "enum" || !Array.isArray(activityMarker.options))
			throw new Error("Activity marker must be an inline enum setting");
		expect(activityMarker.options.map((option) => option.value)).toEqual([
			"off",
			"spinner",
			"pulse",
			"static",
			"line",
			"arc",
			"pipe",
			"grow-vertical",
			"grow-horizontal",
			"triangle",
			"circle-quarters",
			"circle-halves",
			"bracket-spin",
			"dots",
			"quadrants",
			"sparkle",
			"braille-wave",
			"braille-dna",
			"braille-scan",
			"braille-rain",
			"braille-scanline",
			"braille-pulse",
			"braille-sparkle",
			"braille-cascade",
			"braille-columns",
			"braille-orbit",
			"braille-breathe",
			"braille-wave-rows",
			"braille-checkerboard",
			"braille-helix",
			"scanline",
			"snake",
			"fill-sweep",
			"diagonal-swipe",
			"dna",
			"radar",
			"bounce",
			"orbit",
			"conveyor",
			"heartbeat",
			"nerd-progress",
			"nerd-morph",
			"nerd-pipeline",
			"nerd-pi-orbit",
		]);
		const shimmer = registration?.definitions.find((definition) => definition.key === "shimmer");
		expect(shimmer?.type).toBe("enum");
		if (shimmer?.type !== "enum" || !Array.isArray(shimmer.options))
			throw new Error("Shimmer must be an inline enum setting");
		expect(shimmer.options.map((option) => option.value)).toEqual([
			"off",
			"sweep",
			"glow",
			"rainbow",
			"rainbow-glow",
			"lightning",
		]);

		await ensureXSettingsRegistry().publish("pi-libtui", {
			iconPack: "unicode",
			activityMarker: "pulse",
			shimmer: "glow",
			shimmerMarker: true,
			powerline: false,
			powerlineButtons: true,
			softCursor: true,
			insertionCursor: "blinking-bar",
			navigationCursor: "steady-block",
			selectionCursor: "steady-underline",
		});
		expect(getTuiAppearance()).toEqual({
			iconPack: "unicode",
			activityMarker: "pulse",
			shimmer: "glow",
			shimmerMarker: true,
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
