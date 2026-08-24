import { createSettings, type SettingDefinitionInput, type SettingsOf } from "pi-xsettings/sdk";

const definitions = {
	catalogVisibility: {
		label: "Skill catalogue",
		description: "Choose when the skill catalogue is included in the developer prompt.",
		category: "tools",
		type: "enum",
		default: "when-active",
		options: [
			{
				value: "when-active",
				label: "When active",
				description: "Include the catalogue when skill loading is available.",
			},
			{ value: "always", label: "Always", description: "Include the catalogue for every prompt." },
			{ value: "off", label: "Off", description: "Never include the catalogue." },
		],
	},
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-skills", label: "Skills", definitions });

export type SkillsSettings = SettingsOf<typeof definitions>;
export const DEFAULT_SKILLS_SETTINGS: SkillsSettings = { ...settings.defaults };
export const getSkillsSettings = settings.get;
export const registerSkillsXSettings = settings.register;
