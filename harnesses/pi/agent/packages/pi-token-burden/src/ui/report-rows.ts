import type { TokenBurdenReport, TokenEstimate, UsageSummary } from "../core/report.ts";
import type { ReportTab } from "../core/report-navigation.ts";

export interface ReportRow {
	label: string;
	value?: string;
	toolName?: string;
	view?: ReportTab;
	detail: string;
	share?: { value: number; total: number; label: string };
	state?: "measured" | "estimated" | "cached" | "unavailable" | "action";
}
export const money = (value: number | null): string => (value === null ? "unavailable" : `$${value.toFixed(6)}`);
export const tokens = (value: number | null): string =>
	value === null ? "unavailable" : `${value.toLocaleString("en-US")} tokens`;
export function usageText(usage: TokenEstimate | null): string {
	return usage
		? `Input ${usage.input} · output ${usage.output} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite}\nTotal ${usage.total} tokens · recorded cost ${money(usage.cost)}`
		: "Usage unavailable (no recorded usage)";
}
function summaryText(summary: UsageSummary): string {
	const totals = summary.totals;
	const scope = totals
		? `Fresh input ${totals.input} · cached input ${totals.cacheRead} · cache write ${totals.cacheWrite} · output ${totals.output}`
		: "No recorded usage";
	const missing =
		Object.entries(summary.missingByKind)
			.filter(([, count]) => count)
			.map(([kind, count]) => `${kind}: ${count}`)
			.join(", ") || "none";
	return `${usageText(totals)}\n${scope}\nContext floor ${summary.floorTokens ?? "unavailable"} · last context ${summary.lastContextTokens ?? "unavailable"} · cached share ${summary.cachedShare === null ? "unavailable" : `${(summary.cachedShare * 100).toFixed(1)}%`}\n${summary.records.length} work records; ${summary.missing} unavailable (${missing}). Totals cover recorded usage only.`;
}

export function reportRows(report: TokenBurdenReport, tab: ReportTab): ReportRow[] {
	const sectionTotal = report.promptSections.reduce((sum, item) => sum + item.estimate, 0);
	const toolTotal = report.tools.reduce((sum, item) => sum + item.estimate, 0);
	const byBurden = (a: ReportRow, b: ReportRow) => (b.share?.value ?? 0) - (a.share?.value ?? 0);
	switch (tab) {
		case "Overview":
			return [
				{
					label: "Base prompt",
					value: `~${tokens(report.promptTokens)}`,
					view: "Prompt",
					state: "estimated",
					detail:
						"Estimate: ceil(UTF-16 characters / 4). Not provider tokenization. Prompt sections and loaded context files are available in the Prompt tab. Tool definitions are separate; guidelines may already occur in the prompt.",
				},
				{
					label: `Tool schemas (${report.tools.filter((tool) => tool.active).length} active of ${report.tools.length})`,
					value: `~${tokens(report.tools.filter((tool) => tool.active).reduce((sum, tool) => sum + tool.estimate, 0))}`,
					view: "Tools",
					state: "estimated",
					detail:
						"Active definition estimates, separate from the system prompt. Registered inactive tools remain available for inspection.",
				},
				{
					label: `AGENTS.md files (${report.contextFiles.length})`,
					value: `~${tokens(report.contextFiles.reduce((sum, file) => sum + file.estimate, 0))}`,
					view: "Prompt",
					state: "estimated",
					detail: "Loaded base inputs; overlap the system prompt, not additive.",
				},
				{
					label: `Skills (${report.skills.length})`,
					value: `${report.skills.filter((skill) => skill.modelInvocable).length} advertised`,
					view: "Skills",
					state: "estimated",
					detail: "Skill advertisements only. Single-skill wrapper estimates are not additive; bodies are not loaded.",
				},
			];
		case "Prompt":
			return [
				...report.promptSections.map((section) => ({
					label: section.label,
					value: `~${tokens(section.estimate)}`,
					state: "estimated" as const,
					detail: section.content,
					share: { value: section.estimate, total: sectionTotal, label: "Share of section estimates" },
				})),
				...report.contextFiles.map((file) => ({
					label: `Context file: ${file.label}`,
					value: `~${tokens(file.estimate)}`,
					state: "estimated" as const,
					detail: `Base input; overlaps the prompt above, do not add twice.\n\n${file.content}`,
				})),
			].sort(byBurden);
		case "Tools":
			return report.tools
				.map((tool) => ({
					label: `${tool.active ? "Active" : "Inactive"} · ${tool.name}`,
					value: `~${tokens(tool.estimate)}`,
					toolName: tool.name,
					share: { value: tool.estimate, total: toolTotal, label: "Share of all tool definitions" },
					state: "estimated" as const,
					detail: `${tool.name}\n${tool.description}\n\nReach: ${tool.active ? "active in Pi's current tool set" : "registered but inactive in Pi's current tool set"}. Nested/deferred/blocked reach is not exposed.\nSource: ${tool.source}\nDefinition ~${tool.estimate} tokens (parameters ~${tool.schemaEstimate}).\nHypothetical uncached input cost at current model rate: ${money(tool.inputCost)} per inclusion; not actual billing.\nBranch tool-call blocks: ${tool.branchCalls} (not proof of execution).\nGuidelines ~${tool.guidelineEstimate} tokens, separate from definition and potentially already in system prompt.\n${tool.guidelines.join("\n")}\n\nParameters:\n${tool.parameters}`,
				}))
				.sort(byBurden);
		case "Usage":
			return [
				{
					label: "Current branch · cumulative recorded usage",
					value: tokens(report.usage.branch.totals?.total ?? null),
					detail: summaryText(report.usage.branch),
					state: report.usage.branch.totals ? "measured" : "unavailable",
				},
				{
					label: "Whole session totals (all branches)",
					value: tokens(report.usage.session.totals?.total ?? null),
					detail: summaryText(report.usage.session),
					state: report.usage.session.totals ? "measured" : "unavailable",
				},
				...report.usage.branch.records.map((record, index) => ({
					label: `${record.turn ?? index + 1}. ${record.kind} · ${record.label}`,
					value: tokens(record.usage?.total ?? null),
					state: record.usage
						? record.usage.cacheRead > 0
							? ("cached" as const)
							: ("measured" as const)
						: ("unavailable" as const),
					detail: `${record.id}\n${record.label}\n${usageText(record.usage)}\nProvider context ${record.promptTokens ?? "unavailable"} · growth ${record.growth ?? "unavailable"}`,
				})),
			];
		case "Skills":
			return report.skills.map((skill) => ({
				label: `${skill.name} · ${skill.modelInvocable ? "model-invocable" : "explicit invocation only"}`,
				value: `~${tokens(skill.estimate)}`,
				state: "estimated" as const,
				detail: `${skill.name}\n${skill.description}\n\n${skill.filePath}\nSource: ${skill.source}\n${skill.modelInvocable ? "Included in base skill advertisement" : "Excluded from model skill advertisement; explicit invocation only"}.\nEstimate includes Pi's single-skill advertisement wrapper, not the skill file body. Per-skill estimates are not additive. This report does not load or execute skill files or change their configuration.`,
			}));
	}
}
