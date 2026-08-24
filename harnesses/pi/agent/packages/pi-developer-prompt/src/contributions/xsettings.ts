import { createSettings, type SettingDefinitionInput, type SettingsOf } from "pi-xsettings/sdk";

const definitions = {
	auditEntries: {
		label: "Prompt audit entries",
		description: "Choose which composed prompt roles are persisted for transcript inspection.",
		category: "appearance",
		page: "ux",
		type: "multi-enum",
		default: ["developer", "context-user"],
		options: [
			{ value: "developer", label: "Developer", description: "Persist composed developer messages." },
			{
				value: "context-user",
				label: "Context user",
				description: "Persist contextual user messages such as AGENTS.md.",
			},
		],
		ordered: false,
	},
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({
	namespace: "pi-developer-prompt",
	label: "Developer Prompt",
	definitions,
});

export type DeveloperPromptSettings = SettingsOf<typeof definitions>;
export type PromptAuditRole = DeveloperPromptSettings["auditEntries"][number];
export const getDeveloperPromptSettings = settings.get;
export const registerDeveloperPromptXSettings = settings.register;
