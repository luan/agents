export enum DisableMode {
	Enabled = "enabled",
	Hidden = "hidden",
	Disabled = "disabled",
}

export interface SkillEntry {
	name: string;
	description: string;
	chars: number;
	tokens: number;
}

export interface AgentsFileEntry {
	path: string;
	chars: number;
	tokens: number;
}

export interface BarSegment {
	label: string;
	width: number;
}

// Names match codex's `ToolExposure` enum, ordered by resident cost. tool-policy/policy.ts owns the assignment.
export enum ToolReach {
	Direct = "direct",
	Declared = "declared",
	Deferred = "deferred",
	Blocked = "blocked",
	Unreachable = "unreachable",
}

export interface ToolEntry {
	name: string;
	chars: number;
	tokens: number;
	content: string;
	reach: ToolReach;
}

// One list, not an active/inactive pair: the split is 5 ways and a partition would rebuild on every state change.
export interface ToolSectionData {
	tools: ToolEntry[];
	/** Schema tokens in the provider's tool array — the direct surface, and nothing else. */
	residentTokens: number;
	registeredTokens: number;
	declarationTokens: number;
}

export interface TurnUsage {
	/** 1-based position in the session. */
	index: number;
	messageIndex: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
	/** input + cacheRead + cacheWrite: the context the provider saw. */
	promptTokens: number;
	/** Change in `promptTokens` since the previous turn. Negative after a compaction. */
	growth: number;
}

export interface SessionUsageTotals {
	turns: number;
	floorTokens: number;
	contextTokens: number;
	freshInput: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
	cachedShare: number;
}

export interface SessionUsageCategory {
	label: string;
	tokens: number;
	estimated: boolean;
}

export interface SessionUsageData {
	tokens: number;
	totals: SessionUsageTotals;
	turns: TurnUsage[];
	categories: SessionUsageCategory[];
}

export interface PromptSection {
	label: string;
	chars: number;
	tokens: number;
	content?: string;
	tools?: ToolSectionData;
	children?: {
		label: string;
		chars: number;
		tokens: number;
		content?: string;
	}[];
}

export interface ParsedPrompt {
	sections: PromptSection[];
	totalChars: number;
	totalTokens: number;
	skills: SkillEntry[];
}

export interface TableItem {
	label: string;
	tokens: number;
	chars: number;
	pct: number;
	drillable: boolean;
	content?: string;
	tools?: ToolSectionData;
	children?: TableItem[];
}

export interface SkillInfo {
	name: string;
	description: string;
	filePath: string;
	allPaths: string[];
	mode: DisableMode;
	tokens: number;
	hasDuplicates: boolean;
}

export interface Settings {
	skills?: string[];
	packages?: unknown[];
	[key: string]: unknown;
}

export interface SkillToggleResult {
	applied: boolean;
	changes: Map<string, DisableMode>;
}
