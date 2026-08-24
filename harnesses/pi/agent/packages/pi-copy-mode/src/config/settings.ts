import { createSettings, type SettingDefinitionInput, type SettingsOf } from "pi-xsettings/sdk";

const definitions = {
	copyOnSelect: {
		category: "interaction",
		section: "Copy mode",
		label: "Copy on select",
		description: "Copy text immediately when a mouse selection is completed.",
		type: "boolean",
		default: false,
	},
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-copy-mode", label: "Copy mode", definitions });

export type CopyModeSettings = SettingsOf<typeof definitions>;
export const DEFAULT_COPY_MODE_SETTINGS: CopyModeSettings = { ...settings.defaults };
export function getCopyModeSettings(): CopyModeSettings {
	return settings.get();
}
export const registerCopyModeSettings = settings.register;
