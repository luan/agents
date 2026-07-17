export const SUBAGENT_USAGE_ENTRY_TYPE = "subagents:usage";
export const SUBAGENT_USAGE_EVENT = "subagents:usage";

export type SubagentUsage = {
	input: number;
	output: number;
	cost: number;
};

export type SubagentUsageEvent = SubagentUsage & {
	sessionFile?: string;
};

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function parseSubagentUsage(value: unknown): SubagentUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	return {
		input: finiteNonNegative(record.input),
		output: finiteNonNegative(record.output),
		cost: finiteNonNegative(record.cost),
	};
}
