import type { SubagentSnapshot } from "../runtime/coordinator.ts";

export const MAX_RESULT_TEXT = 16_384;
export const MAX_AGENT_RECORDS = 200;

export interface AgentRecord {
	id: string;
	rootSessionId: string;
	parentId?: string;
	cwd: string;
	status: SubagentSnapshot["status"];
	description: string;
	modelRole?: string;
	startedAt: number;
	completedAt?: number;
	durationMs: number;
	toolUses: number;
	cost: number;
	tokenCount: number;
	contextPercent?: number;
	compactions: number;
	activity?: SubagentSnapshot["activity"];
	transcriptAvailable: boolean;
	output?: string;
	error?: string;
}

export interface TruncationDetails {
	agentsOmitted: number;
	textCharactersOmitted: number;
}

export function boundedText(value: string | undefined): { text?: string; omitted: number } {
	if (!value) return { omitted: 0 };
	if (value.length <= MAX_RESULT_TEXT) return { text: value, omitted: 0 };
	const suffix = "\n\n[Output truncated in tool details.]";
	const retained = MAX_RESULT_TEXT - suffix.length;
	return {
		text: `${value.slice(0, retained)}${suffix}`,
		omitted: value.length - retained,
	};
}

export function agentRecord(
	agent: SubagentSnapshot,
	now = Date.now(),
): {
	record: AgentRecord;
	textCharactersOmitted: number;
} {
	const output = boundedText(agent.result);
	const error = boundedText(agent.error);
	return {
		record: {
			id: agent.id,
			rootSessionId: agent.rootSessionId,
			parentId: agent.parentId,
			cwd: agent.cwd,
			status: agent.status,
			description: agent.description,
			modelRole: agent.modelRole?.name,
			startedAt: agent.startedAt,
			completedAt: agent.completedAt,
			durationMs: Math.max(0, (agent.completedAt ?? now) - agent.startedAt),
			toolUses: agent.toolUses,
			cost: agent.cost,
			tokenCount: agent.tokenCount,
			contextPercent: agent.contextPercent,
			compactions: agent.compactions,
			activity: agent.activity,
			transcriptAvailable: agent.transcriptAvailable,
			output: output.text,
			error: error.text,
		},
		textCharactersOmitted: output.omitted + error.omitted,
	};
}

export function agentRecords(agents: readonly SubagentSnapshot[]): {
	records: AgentRecord[];
	truncation: TruncationDetails;
} {
	const selected = agents.slice(0, MAX_AGENT_RECORDS);
	let textCharactersOmitted = 0;
	const records = selected.map((agent) => {
		const bounded = agentRecord(agent);
		textCharactersOmitted += bounded.textCharactersOmitted;
		return bounded.record;
	});
	return {
		records,
		truncation: {
			agentsOmitted: agents.length - selected.length,
			textCharactersOmitted,
		},
	};
}
