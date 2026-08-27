import { afterEach, describe, expect, test } from "bun:test";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, getTuiAppearance, icon } from "pi-libtui";
import { registerTuiSettings } from "../src/config/tui-settings.ts";
import { ensureXSettingsRegistry } from "../src/protocol/settings.ts";

describe("pi-libtui settings", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("uses portable appearance defaults", () => {
		expect(DEFAULT_TUI_APPEARANCE).toEqual({
			iconPack: "unicode",
			activityIndicator: "spinner",
			activityMessage: "phase",
			textEffect: "off",
			textEffectScope: "message",
			pulseEffect: "off",
			statusPresentation: "standard",
			animationSpeed: "normal",
			animationSmoothness: "balanced",
			thinkingIndicator: "inherit",
			thinkingMessage: "inherit",
			thinkingTextEffect: "inherit",
			thinkingPulseEffect: "inherit",
			thinkingPresentation: "inherit",
			workingIndicator: "inherit",
			workingMessage: "inherit",
			workingTextEffect: "inherit",
			workingPulseEffect: "inherit",
			workingPresentation: "inherit",
			toolIndicator: "inherit",
			toolMessage: "inherit",
			toolTextEffect: "inherit",
			toolPulseEffect: "inherit",
			toolPresentation: "inherit",
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
			"activityIndicator",
			"activityMessage",
			"textEffect",
			"textEffectScope",
			"pulseEffect",
			"statusPresentation",
			"animationSpeed",
			"animationSmoothness",
			"thinkingIndicator",
			"thinkingMessage",
			"thinkingTextEffect",
			"thinkingPulseEffect",
			"thinkingPresentation",
			"workingIndicator",
			"workingMessage",
			"workingTextEffect",
			"workingPulseEffect",
			"workingPresentation",
			"toolIndicator",
			"toolMessage",
			"toolTextEffect",
			"toolPulseEffect",
			"toolPresentation",
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
		const activityIndicator = registration?.definitions.find((definition) => definition.key === "activityIndicator");
		expect(activityIndicator?.type).toBe("enum");
		expect(activityIndicator?.preview).toBe("activity-marker");
		if (activityIndicator?.type !== "enum" || !Array.isArray(activityIndicator.options))
			throw new Error("Activity marker must be an inline enum setting");
		expect(activityIndicator.options.map((option) => option.value)).toEqual([
			"off",
			"spinner",
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
		const statusPresentation = registration?.definitions.find((definition) => definition.key === "statusPresentation");
		expect(statusPresentation?.type).toBe("enum");
		expect(statusPresentation?.preview).toBe("status-presentation");
		if (statusPresentation?.type !== "enum" || !Array.isArray(statusPresentation.options))
			throw new Error("Status presentation must be an inline enum setting");
		expect(statusPresentation.options.map((option) => option.value)).toEqual([
			"standard",
			"neural-pulse",
			"plasma-wave",
			"pacman",
			"matrix",
			"pipeline",
			"starfield",
			"fire",
			"icon-morph",
			"brainstorm",
			"dev-constellation",
			"pi-pulse",
			"orbit-dots",
			"neon-bounce",
			"block-wave",
			"conveyor",
			"accordion",
		]);
		const textEffect = registration?.definitions.find((definition) => definition.key === "textEffect");
		expect(textEffect?.type).toBe("enum");
		if (textEffect?.type !== "enum" || !Array.isArray(textEffect.options))
			throw new Error("Text effect must be an inline enum setting");
		expect(textEffect.options.map((option) => option.value)).toEqual([
			"off",
			"sweep",
			"glow",
			"rainbow",
			"rainbow-glow",
			"lightning",
			"aurora",
			"glitch",
			"crush",
		]);
		const pulseEffect = registration?.definitions.find((definition) => definition.key === "pulseEffect");
		expect(pulseEffect?.type).toBe("enum");
		expect(pulseEffect?.label).toBe("Pulse effect");
		if (pulseEffect?.type !== "enum" || !Array.isArray(pulseEffect.options))
			throw new Error("Pulse effect must be an inline enum setting");
		expect(pulseEffect.options.map((option) => option.value)).toEqual(["off", "pulse", "color"]);
		const animationSpeed = registration?.definitions.find((definition) => definition.key === "animationSpeed");
		expect(animationSpeed?.type).toBe("enum");
		if (animationSpeed?.type !== "enum" || !Array.isArray(animationSpeed.options))
			throw new Error("Animation speed must be an inline enum setting");
		expect(animationSpeed.options.map((option) => option.value)).toEqual([
			"slow",
			"relaxed",
			"normal",
			"fast",
			"very-fast",
		]);
		const animationSmoothness = registration?.definitions.find(
			(definition) => definition.key === "animationSmoothness",
		);
		expect(animationSmoothness?.type).toBe("enum");
		if (animationSmoothness?.type !== "enum" || !Array.isArray(animationSmoothness.options))
			throw new Error("Animation smoothness must be an inline enum setting");
		expect(animationSmoothness.options.map((option) => option.value)).toEqual([
			"economy",
			"balanced",
			"smooth",
			"ultra",
		]);

		await ensureXSettingsRegistry().publish("pi-libtui", {
			iconPack: "unicode",
			activityIndicator: "static",
			pulseEffect: "color",
			activityMessage: "typewriter",
			statusPresentation: "starfield",
			textEffect: "glow",
			textEffectScope: "inline",
			animationSpeed: "fast",
			animationSmoothness: "smooth",
			thinkingIndicator: "off",
			thinkingMessage: "phase",
			thinkingTextEffect: "inherit",
			thinkingPulseEffect: "inherit",
			thinkingPresentation: "pacman",
			workingIndicator: "inherit",
			workingMessage: "inherit",
			workingTextEffect: "inherit",
			workingPulseEffect: "inherit",
			workingPresentation: "inherit",
			toolIndicator: "inherit",
			toolMessage: "inherit",
			toolTextEffect: "lightning",
			toolPulseEffect: "color",
			toolPresentation: "block-wave",
			powerline: false,
			powerlineButtons: true,
			softCursor: true,
			insertionCursor: "blinking-bar",
			navigationCursor: "steady-block",
			selectionCursor: "steady-underline",
		});
		expect(getTuiAppearance()).toEqual({
			iconPack: "unicode",
			activityIndicator: "static",
			pulseEffect: "color",
			activityMessage: "typewriter",
			statusPresentation: "starfield",
			textEffect: "glow",
			textEffectScope: "inline",
			animationSpeed: "fast",
			animationSmoothness: "smooth",
			thinkingIndicator: "off",
			thinkingMessage: "phase",
			thinkingTextEffect: "inherit",
			thinkingPulseEffect: "inherit",
			thinkingPresentation: "pacman",
			workingIndicator: "inherit",
			workingMessage: "inherit",
			workingTextEffect: "inherit",
			workingPulseEffect: "inherit",
			workingPresentation: "inherit",
			toolIndicator: "inherit",
			toolMessage: "inherit",
			toolTextEffect: "lightning",
			toolPulseEffect: "color",
			toolPresentation: "block-wave",
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
