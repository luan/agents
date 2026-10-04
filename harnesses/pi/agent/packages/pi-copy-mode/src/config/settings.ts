import {
	createSettings,
	stringListSetting,
	type SettingDefinitionInput,
	type SettingsOf,
} from "@luan.sh/pi-xsettings/sdk";

export const DEFAULT_REACTIONS = [
	"👍 Looks good",
	"🚫 Rejected",
	"✅ Approved",
	"❓ Clarify",
	"🧬 Match existing patterns",
	"🔄 Consider alternatives",
	"🔍 Verify",
] as const;

const definitions = {
	reactions: stringListSetting({
		label: "Reactions",
		description: "Ordered reaction choices shown when annotating a selection.",
		category: "interaction",
		default: DEFAULT_REACTIONS,
		minItems: 0,
	}),
	copyOnSelect: {
		category: "interaction",
		section: "Copy mode",
		label: "Copy on select",
		description: "Copy text immediately when a mouse selection is completed.",
		type: "boolean",
		default: true,
	},
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-copy-mode", label: "Copy mode", definitions });

export type CopyModeSettings = SettingsOf<typeof definitions>;
export const DEFAULT_COPY_MODE_SETTINGS: CopyModeSettings = { ...settings.defaults };
export function getCopyModeSettings(): CopyModeSettings {
	return settings.get();
}
export const registerCopyModeSettings = settings.register;
