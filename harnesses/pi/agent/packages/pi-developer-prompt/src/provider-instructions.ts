import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export function buildProviderInstructions(options: BuildSystemPromptOptions, fallbackSystemPrompt = ""): string {
	if (!options.customPrompt) return fallbackSystemPrompt;
	return options.appendSystemPrompt ? `${options.customPrompt}\n\n${options.appendSystemPrompt}` : options.customPrompt;
}
