import { createSettings, type SettingDefinitionInput, type SettingsOf } from "pi-xsettings/sdk";

export interface ToolSearchOption {
	name: string;
	description: string;
}

function definitions(toolOptions: readonly ToolSearchOption[]) {
	return {
		tools: {
			label: "Deferred tools",
			description: "Checked tools are hidden until tool_search loads them.",
			category: "tools",
			type: "multi-enum",
			default: [],
			options: toolOptions.map((tool) => ({
				value: tool.name,
				label: tool.name,
				description: tool.description,
			})),
			ordered: false,
		},
	} as const satisfies Record<string, SettingDefinitionInput>;
}

type Definitions = ReturnType<typeof definitions>;
export type ToolSearchSettings = SettingsOf<Definitions>;

export function createToolSearchSettings(toolOptions: readonly ToolSearchOption[] = []) {
	return createSettings({
		namespace: "pi-tool-search",
		label: "Tool Search",
		definitions: definitions(toolOptions),
	});
}
