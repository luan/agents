import { createSettings, type SettingDefinitionInput, type SettingsOf } from "pi-xsettings/sdk";

const CODE_MODE_OUTPUT_TOKEN_OPTIONS = [1_000, 2_500, 5_000, 10_000, 20_000, 50_000, 100_000] as const;
const CODE_MODE_YIELD_OPTIONS = [1_000, 5_000, 10_000, 30_000, 60_000] as const;
const DEFAULT_LIFTED_TOOLS = ["skill", "web__run", "exec_command", "write_stdin", "apply_patch", "view_image"] as const;

export interface CodeModeToolOption {
	name: string;
	description: string;
}

function definitions(execToolOptions: readonly CodeModeToolOption[]) {
	const names = new Set(execToolOptions.map((tool) => tool.name));
	return {
		enabled: {
			label: "Enabled",
			description: "Move selected direct tools under exec.",
			category: "tools",
			type: "boolean",
			default: true,
		},
		tools: {
			label: "Tools under exec",
			description: "Checked tools are available only through exec.",
			category: "tools",
			type: "multi-enum",
			default: DEFAULT_LIFTED_TOOLS.filter((name) => names.has(name)),
			options: execToolOptions.map((tool) => ({
				value: tool.name,
				label: tool.name,
				description: tool.description,
			})),
			ordered: false,
		},
		defaultOutputTokens: numberSetting(
			"Default output",
			"Default aggregate output token budget.",
			CODE_MODE_OUTPUT_TOKEN_OPTIONS,
			10_000,
			"tokens",
		),
		defaultExecYieldMs: numberSetting(
			"Exec yield",
			"Default initial exec yield time in milliseconds.",
			CODE_MODE_YIELD_OPTIONS,
			30_000,
			"milliseconds",
		),
		defaultWaitYieldMs: numberSetting(
			"Wait yield",
			"Default wait yield time in milliseconds.",
			CODE_MODE_YIELD_OPTIONS,
			10_000,
			"milliseconds",
		),
	} as const satisfies Record<string, SettingDefinitionInput>;
}

type Definitions = ReturnType<typeof definitions>;
export type CodeModeSettings = SettingsOf<Definitions>;

export function createCodeModeSettings(
	execToolOptions: readonly CodeModeToolOption[] = DEFAULT_LIFTED_TOOLS.map((name) => ({
		name,
		description: `${name} tool.`,
	})),
) {
	return createSettings({
		namespace: "pi-code-mode",
		label: "Code Mode",
		definitions: definitions(execToolOptions),
	});
}

const defaultSettings = createCodeModeSettings();
export const DEFAULT_CODE_MODE_SETTINGS: CodeModeSettings = { ...defaultSettings.defaults };

function numberSetting<const Values extends readonly number[]>(
	label: string,
	description: string,
	values: Values,
	fallback: Values[number],
	unit: string,
) {
	return {
		label,
		description,
		category: "tools" as const,
		type: "enum" as const,
		default: fallback,
		options: values.map((value) => ({
			value,
			label: value.toLocaleString("en-US"),
			description: `${value.toLocaleString("en-US")} ${unit}.`,
		})),
	};
}
