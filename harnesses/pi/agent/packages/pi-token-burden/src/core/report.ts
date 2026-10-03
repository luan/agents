export interface TokenEstimate {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}
export interface UsageRecord {
	id: string;
	label: string;
	kind: "assistant" | "nested tool" | "compaction" | "branch summary";
	usage: TokenEstimate | null;
	/** Provider context seen for this record (input plus cached input). */
	promptTokens?: number | null;
	/** Change in provider context since the previous recorded record. */
	growth?: number | null;
	/** 1-based position among records with usage. */
	turn?: number | null;
}
export interface UsageSummary {
	records: UsageRecord[];
	totals: TokenEstimate | null;
	missing: number;
	missingByKind: Record<UsageRecord["kind"], number>;
	/** First and last provider context sizes, when usage was reported. */
	floorTokens: number | null;
	lastContextTokens: number | null;
	/** cacheRead / (input + cacheRead + cacheWrite). */
	cachedShare: number | null;
}
export interface PromptSection {
	label: string;
	content: string;
	estimate: number;
}
export interface ToolReport {
	name: string;
	description: string;
	parameters: string;
	guidelines: string[];
	source: string;
	active: boolean;
	estimate: number;
	schemaEstimate: number;
	guidelineEstimate: number;
	inputCost: number | null;
	branchCalls: number;
}
export interface SkillReport {
	name: string;
	description: string;
	filePath: string;
	source: string;
	modelInvocable: boolean;
	estimate: number;
}
export interface TokenBurdenReport {
	generatedAt: number;
	model: string | null;
	promptTokens: number;
	promptSections: PromptSection[];
	contextFiles: PromptSection[];
	usage: { branch: UsageSummary; session: UsageSummary };
	context: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	tools: ToolReport[];
	commands: Array<{ name: string; source: string; path: string }>;
	skills: SkillReport[];
}
export const emptyUsage = (): TokenEstimate => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: 0,
});
