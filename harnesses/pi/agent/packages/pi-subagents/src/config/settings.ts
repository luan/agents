import { createSettings, type SettingDefinitionInput } from "pi-xsettings/sdk";

export type SubagentConfig = {
	readonly maxConcurrency: number;
	readonly maxDepth: number;
};

const definitions = {
	maxConcurrency: {
		label: "Concurrent agents",
		description: "Maximum agents in one tree, including the root agent.",
		category: "behavior",
		type: "enum",
		default: "8",
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
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-subagents", label: "Subagents", definitions });

export function getSubagentConfig(): SubagentConfig {
	const current = settings.get();
	return {
		maxConcurrency: Number(current.maxConcurrency),
		maxDepth: Number(current.maxDepth),
	};
}

export const registerSubagentSettings = settings.register;
