import { createSettings, stringListSetting, type SettingDefinitionInput } from "pi-xsettings/sdk";

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
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-annotations", label: "Annotations", definitions });

export function getReactions(): string[] {
	return settings.get().reactions;
}
export const registerAnnotationSettings = settings.register;
