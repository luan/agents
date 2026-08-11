import { SettingsManager } from "@earendil-works/pi-coding-agent";

let installed = false;

export function installSessionOnlySettings(): void {
	if (installed) return;
	SettingsManager.prototype.setDefaultModelAndProvider = () => {};
	SettingsManager.prototype.setDefaultModel = () => {};
	SettingsManager.prototype.setDefaultProvider = () => {};
	SettingsManager.prototype.setDefaultThinkingLevel = () => {};
	installed = true;
}
