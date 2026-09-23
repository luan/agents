import type { SessionEntry, SourceInfo } from "@earendil-works/pi-coding-agent";
import type { ReportAPI, ReportContext } from "../src/runtime/collect-report.ts";

export const sourceInfo: SourceInfo = {
	path: "/extensions/example.ts",
	source: "example",
	scope: "user",
	origin: "package",
};
export const usage = {
	input: 10,
	output: 20,
	cacheRead: 30,
	cacheWrite: 40,
	totalTokens: 100,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};
export const assistant: SessionEntry = {
	type: "message",
	id: "a",
	parentId: null,
	timestamp: "2026-01-01T00:00:00Z",
	message: {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		stopReason: "toolUse",
		timestamp: 0,
		usage,
		content: [{ type: "toolCall", id: "call", name: "lookup", arguments: { query: "hello" } }],
	},
};
export const nested: SessionEntry = {
	type: "message",
	id: "b",
	parentId: "a",
	timestamp: "2026-01-01T00:00:01Z",
	message: {
		role: "toolResult",
		toolName: "lookup",
		toolCallId: "call",
		content: [],
		isError: false,
		timestamp: 1,
		usage,
	},
};
export const compaction: SessionEntry = {
	type: "compaction",
	id: "c",
	parentId: "b",
	timestamp: "2026-01-01T00:00:02Z",
	firstKeptEntryId: "a",
	tokensBefore: 100,
	summary: "summary",
	usage,
};
export const missingSummary: SessionEntry = {
	type: "branch_summary",
	id: "d",
	parentId: "c",
	timestamp: "2026-01-01T00:00:03Z",
	fromId: "b",
	summary: "no usage",
};

export function fixture(): { pi: ReportAPI; ctx: ReportContext } {
	return {
		pi: {
			getAllTools: () => [
				{
					name: "lookup",
					description: "Lookup a thing",
					parameters: {
						type: "object",
						properties: { query: { type: "string", description: "Query text" } },
						required: ["query"],
					},
					promptGuidelines: ["Use lookup for facts"],
					sourceInfo,
				},
				{
					name: "inactive",
					description: "Not currently active",
					parameters: { type: "object", properties: {} },
					sourceInfo,
				},
			],
			getActiveTools: () => ["lookup"],
			getCommands: () => [{ name: "demo", description: "Demo", source: "extension", sourceInfo }],
		},
		ctx: {
			getSystemPrompt: () => "Preamble\n# Instructions\nBe useful\n## Details\nUse tools",
			getSystemPromptOptions: () => ({
				cwd: "/project",
				contextFiles: [{ path: "/AGENTS.md", content: "Be useful" }],
				skills: [
					{
						name: "review",
						description: "Review code",
						filePath: "/skills/review/SKILL.md",
						baseDir: "/skills/review",
						disableModelInvocation: false,
						sourceInfo,
					},
					{
						name: "private",
						description: "Explicit skill",
						filePath: "/skills/private/SKILL.md",
						baseDir: "/skills/private",
						disableModelInvocation: true,
						sourceInfo,
					},
				],
			}),
			getContextUsage: () => ({ tokens: 500, contextWindow: 1000, percent: 50 }),
			model: undefined,
			sessionManager: {
				getBranch: () => [assistant, nested, compaction, missingSummary],
				getEntries: () => [assistant, nested, compaction, missingSummary, { ...assistant, id: "other-branch" }],
			},
		},
	};
}
