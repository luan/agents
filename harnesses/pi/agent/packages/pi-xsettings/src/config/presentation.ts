import { createSettings, type SettingDefinitionInput, type SettingsOf } from "../sdk.ts";

const definitions = {
	presentation: {
		label: "Settings presentation",
		description: "Choose where Xsettings opens when a side-panel host is available.",
		category: "appearance",
		page: "ui",
		section: "Settings",
		type: "enum",
		default: "side-panel",
		options: [
			{ value: "side-panel", label: "Side panel", description: "Open settings beside the main session." },
			{ value: "fullscreen", label: "Fullscreen", description: "Open settings as a fullscreen overlay." },
		],
	},
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-xsettings", label: "Xsettings", apply: "live", definitions });

export type XSettingsPresentationSettings = SettingsOf<typeof definitions>;
export const DEFAULT_XSETTINGS_PRESENTATION_SETTINGS: Readonly<XSettingsPresentationSettings> = settings.defaults;
export const registerXSettingsPresentationSettings = settings.register;
