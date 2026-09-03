import { TUI_ACTIVITY_INDICATOR_OPTIONS } from "pi-libtui";
import { createSettings, type SettingDefinitionInput, type SettingsOf } from "pi-xsettings/sdk";
import type { MultiAgentMode } from "../core/instructions.ts";

export type SubagentConfig = {
	readonly maxConcurrency: number;
	readonly maxDepth: number;
	readonly multiAgentMode: MultiAgentMode;
	readonly agentWidgetIndicator: SubagentSettings["agentWidgetIndicator"];
	readonly agentHubPresentation: SubagentSettings["agentHubPresentation"];
};

const definitions = {
	maxConcurrency: {
		label: "Concurrent agents",
		description: "Maximum agents in one tree, including the root agent.",
		category: "behavior",
		type: "enum",
		default: "4",
		options: [2, 4, 8, 16, 32].map((value) => ({
			value: String(value),
			label: String(value),
			description: `${value - 1} concurrent subagent slot${value === 2 ? "" : "s"} beside the root agent.`,
		})),
	},
	maxDepth: {
		label: "Agent nesting depth",
		description: "Maximum number of subagent levels below the root agent.",
		category: "behavior",
		type: "enum",
		default: "2",
		options: [1, 2, 3, 4].map((value) => ({
			value: String(value),
			label: String(value),
			description: `${value} subagent level${value === 1 ? "" : "s"} below the root agent.`,
		})),
	},
	multiAgentMode: {
		label: "Delegation policy",
		description:
			"Choose how readily agents may delegate work, from direct user requests only to fully proactive delegation.",
		category: "behavior",
		page: "behavior",
		section: "Subagents",
		apply: "live",
		type: "enum",
		default: "explicit-requests",
		options: [
			{
				value: "direct-requests-only",
				label: "Direct requests only",
				description:
					"Only the user's explicit request authorizes delegation; skills and AGENTS.md cannot authorize it.",
			},
			{
				value: "explicit-requests",
				label: "Codex explicit",
				description: "The user, an applicable skill, or AGENTS.md must explicitly authorize delegation.",
			},
			{
				value: "proactive-read-only",
				label: "Proactive read-only",
				description: "Agents may proactively delegate bounded investigation and analysis, but not mutations.",
			},
			{
				value: "proactive-mechanical",
				label: "Proactive mechanical",
				description: "Agents may also consider delegating bounded mechanical edits and verification.",
			},
			{
				value: "proactive",
				label: "Codex proactive",
				description: "Agents should delegate parallel work whenever it could save time or improve quality.",
			},
		],
	},
	agentWidgetIndicator: {
		label: "Agent widget indicator",
		description: "Override the activity indicator beside each running agent in the compact widget.",
		category: "appearance",
		page: "animations",
		section: "Agents",
		preview: "activity-marker",
		apply: "live",
		type: "enum",
		default: "inherit",
		options: [
			{ value: "inherit", label: "Inherit", description: "Use the default TUI activity indicator." },
			...TUI_ACTIVITY_INDICATOR_OPTIONS,
		],
	},
	agentHubPresentation: {
		label: "Agent Hub presentation",
		description: "Choose where the Agent Hub opens when a side-panel host is available.",
		category: "appearance",
		page: "ui",
		section: "Subagents",
		apply: "live",
		type: "enum",
		default: "side-panel",
		options: [
			{ value: "side-panel", label: "Side panel", description: "Open the Agent Hub beside the main session." },
			{ value: "fullscreen", label: "Fullscreen", description: "Open the Agent Hub as a fullscreen overlay." },
		],
	},
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-subagents", label: "Subagents", definitions });
export type SubagentSettings = SettingsOf<typeof definitions>;
export const DEFAULT_SUBAGENT_SETTINGS: Readonly<SubagentSettings> = settings.defaults;

export function getSubagentConfig(): SubagentConfig {
	const current = settings.get();
	return {
		maxConcurrency: Number(current.maxConcurrency),
		maxDepth: Number(current.maxDepth),
		multiAgentMode: current.multiAgentMode,
		agentWidgetIndicator: current.agentWidgetIndicator,
		agentHubPresentation: current.agentHubPresentation,
	};
}

export const registerSubagentSettings = settings.register;
