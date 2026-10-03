import {
	formatSkillsForPrompt,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { TokenBurdenReport, TokenEstimate, UsageRecord } from "../core/report.ts";
import { promptSections } from "../core/prompt-sections.ts";
import { estimateTokens } from "../core/token-estimates.ts";
import { summarizeUsage } from "../core/usage.ts";

export type ReportAPI = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getCommands">;
export type ReportContext = Pick<
	ExtensionCommandContext,
	"getSystemPrompt" | "getSystemPromptOptions" | "getContextUsage" | "model"
> & {
	sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getEntries" | "getBranch">;
};
type RecordedUsage = NonNullable<Extract<SessionEntry, { type: "compaction" }>["usage"]>;

function normalizeUsage(usage: RecordedUsage | undefined): TokenEstimate | null {
	if (!usage) return null;
	const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost.total];
	if (!values.every((value) => Number.isFinite(value) && value >= 0)) return null;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		total: usage.totalTokens,
		cost: usage.cost.total,
	};
}

/** Count stored work once; retainedTail is a context checkpoint, not additional billed work. */
export function usageRecords(entries: readonly SessionEntry[]): UsageRecord[] {
	const records: UsageRecord[] = [];
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant")
				records.push({
					id: entry.id,
					label: `${message.provider}/${message.model} · ${message.stopReason}`,
					kind: "assistant",
					usage: normalizeUsage(message.usage),
					promptTokens: null,
					growth: null,
					turn: null,
				});
			else if (message.role === "toolResult" && message.usage)
				records.push({
					id: entry.id,
					label: message.toolName,
					kind: "nested tool",
					usage: normalizeUsage(message.usage),
					promptTokens: null,
					growth: null,
					turn: null,
				});
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			records.push({
				id: entry.id,
				label: entry.type === "compaction" ? "Compaction" : "Branch summary",
				kind: entry.type === "compaction" ? "compaction" : "branch summary",
				usage: normalizeUsage(entry.usage),
				promptTokens: null,
				growth: null,
				turn: null,
			});
		}
	}
	return records;
}

export function collectReport(pi: ReportAPI, ctx: ReportContext): TokenBurdenReport {
	const prompt = ctx.getSystemPrompt();
	const options = ctx.getSystemPromptOptions();
	const branch = ctx.sessionManager.getBranch();
	const active = new Set(pi.getActiveTools());
	const calls = new Map<string, number>();
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content)
			if (part.type === "toolCall") calls.set(part.name, (calls.get(part.name) ?? 0) + 1);
	}
	return {
		generatedAt: Date.now(),
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
		promptTokens: estimateTokens(prompt),
		promptSections: promptSections(prompt),
		contextFiles: (options.contextFiles ?? []).map((file) => ({
			label: file.path,
			content: file.content,
			estimate: estimateTokens(file.content),
		})),
		usage: {
			branch: summarizeUsage(usageRecords(branch)),
			session: summarizeUsage(usageRecords(ctx.sessionManager.getEntries())),
		},
		context: ctx.getContextUsage() ?? null,
		tools: pi
			.getAllTools()
			.map((tool) => {
				const parameters = JSON.stringify(tool.parameters, null, 2);
				const estimate = estimateTokens(
					JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
				);
				return {
					name: tool.name,
					description: tool.description,
					parameters,
					guidelines: tool.promptGuidelines ?? [],
					source: tool.sourceInfo.path,
					active: active.has(tool.name),
					estimate,
					schemaEstimate: estimateTokens(JSON.stringify(tool.parameters)),
					guidelineEstimate: estimateTokens((tool.promptGuidelines ?? []).join("\n")),
					inputCost: ctx.model ? (estimate * ctx.model.cost.input) / 1_000_000 : null,
					branchCalls: calls.get(tool.name) ?? 0,
				};
			})
			.sort((a, b) => b.estimate - a.estimate || a.name.localeCompare(b.name)),
		commands: pi
			.getCommands()
			.map((command) => ({ name: command.name, source: command.source, path: command.sourceInfo.path })),
		skills: (options.skills ?? []).map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			source: skill.sourceInfo.source,
			modelInvocable: !skill.disableModelInvocation,
			estimate: estimateTokens(formatSkillsForPrompt([skill])),
		})),
	};
}
