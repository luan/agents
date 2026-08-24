import { expect, test } from "bun:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { installSessionOnlyModelDefaults } from "../src/runtime/session-only-defaults.ts";

test("model role switching leaves global defaults unchanged and restores normal persistence on shutdown", () => {
	const settings = SettingsManager.inMemory({
		defaultProvider: "openai-codex",
		defaultModel: "gpt-5.6-luna",
		defaultThinkingLevel: "low",
	});
	const restore = installSessionOnlyModelDefaults();

	settings.setDefaultModelAndProvider("openai-codex", "gpt-5.6-sol");
	settings.setDefaultThinkingLevel("high");
	expect(settings.getDefaultModel()).toBe("gpt-5.6-luna");
	expect(settings.getDefaultThinkingLevel()).toBe("low");

	restore();
	settings.setDefaultModelAndProvider("openai-codex", "gpt-5.6-sol");
	settings.setDefaultThinkingLevel("high");
	expect(settings.getDefaultModel()).toBe("gpt-5.6-sol");
	expect(settings.getDefaultThinkingLevel()).toBe("high");
});

test("nested installs restore the original methods after the final lease", () => {
	const prototype = SettingsManager.prototype;
	const originals = {
		setDefaultModel: prototype.setDefaultModel,
		setDefaultThinkingLevel: prototype.setDefaultThinkingLevel,
	};
	const restoreFirst = installSessionOnlyModelDefaults();
	const restoreSecond = installSessionOnlyModelDefaults();

	try {
		restoreFirst();
		expect(prototype.setDefaultModel).not.toBe(originals.setDefaultModel);
		expect(prototype.setDefaultThinkingLevel).not.toBe(originals.setDefaultThinkingLevel);
	} finally {
		restoreSecond();
		restoreFirst();
	}

	expect(prototype.setDefaultModel).toBe(originals.setDefaultModel);
	expect(prototype.setDefaultThinkingLevel).toBe(originals.setDefaultThinkingLevel);
});
