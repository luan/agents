import { TUI_ACTIVITY_INDICATOR_OPTIONS } from "pi-libtui";
import { createSettings, type SettingDefinitionInput, type SettingsOf } from "pi-xsettings/sdk";

const EXEC_OUTPUT_TOKEN_OPTIONS = [1_000, 2_500, 5_000, 10_000, 20_000, 50_000, 100_000] as const;
const EXEC_YIELD_OPTIONS = [1_000, 5_000, 10_000, 30_000] as const;

const definitions = {
	defaultOutputTokens: numberSetting(
		"Default output",
		"Default returned output token budget.",
		EXEC_OUTPUT_TOKEN_OPTIONS,
		10_000,
		"tokens",
	),
	defaultExecYieldMs: numberSetting(
		"Exec yield",
		"Default initial command yield time in milliseconds.",
		EXEC_YIELD_OPTIONS,
		10_000,
		"milliseconds",
	),
	defaultLoginShell: {
		label: "Login shell",
		description: "Use login-shell semantics when a call does not choose explicitly.",
		category: "tools",
		type: "boolean",
		default: true,
	},
	activityIndicator: {
		label: "Exec Command indicator",
		description: "Override the default activity indicator for running exec_command rows.",
		category: "appearance",
		page: "animations",
		section: "Exec Command",
		preview: "activity-marker",
		type: "enum",
		default: "inherit",
		options: [
			{ value: "inherit", label: "Inherit", description: "Use the default TUI activity indicator." },
			...TUI_ACTIVITY_INDICATOR_OPTIONS,
		],
	},
	processWidgetIndicator: {
		label: "Process widget indicator",
		description: "Override the activity indicator beside each running process in the compact widget.",
		category: "appearance",
		page: "animations",
		section: "Exec Command",
		preview: "activity-marker",
		type: "enum",
		default: "inherit",
		options: [
			{ value: "inherit", label: "Inherit", description: "Use the default TUI activity indicator." },
			...TUI_ACTIVITY_INDICATOR_OPTIONS,
		],
	},
	processHubPresentation: {
		label: "Process Hub presentation",
		description: "Choose where the Process Hub opens when a side-panel host is available.",
		category: "appearance",
		page: "ui",
		section: "Exec Command",
		type: "enum",
		default: "side-panel",
		options: [
			{ value: "side-panel", label: "Side panel", description: "Open the Process Hub beside the main session." },
			{ value: "fullscreen", label: "Fullscreen", description: "Open the Process Hub as a fullscreen overlay." },
		],
	},
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-exec-command", label: "Exec Command", apply: "live", definitions });

export type ExecCommandSettings = SettingsOf<typeof definitions>;
export const DEFAULT_EXEC_COMMAND_SETTINGS: ExecCommandSettings = { ...settings.defaults };
export const registerExecCommandXSettings = settings.register;

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
