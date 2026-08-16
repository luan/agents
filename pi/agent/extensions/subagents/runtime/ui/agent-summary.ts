import { runningFrame } from "../../../shared/tui/animation.ts";
import type { SubagentSnapshot, SubagentStatus, TranscriptPreview } from "../coordinator.js";

export type AgentSummaryTheme = { fg(color: string, text: string): string };
type AgentRowSummary = Pick<SubagentSnapshot, "status" | "startedAt" | "completedAt" | "cost" | "modelRole">;

export function formatAgentCost(cost: number): string {
	if (cost <= 0) return "$0.00";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatAgentDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

export function formatAgentTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m tokens`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
	return `${tokens} tokens`;
}

export function renderAgentStatusMarker(
	theme: AgentSummaryTheme,
	status: SubagentStatus,
	startedAt: number,
	now: number,
): string {
	switch (status) {
		case "running":
			return theme.fg("accent", runningFrame(now - startedAt));
		case "idle":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "×");
		case "interrupted":
			return theme.fg("warning", "■");
		case "queued":
			return theme.fg("muted", "·");
	}
}

export function renderAgentMetadata(
	theme: AgentSummaryTheme,
	agent: AgentRowSummary,
	now: number,
	separator = " · ",
): string {
	const role = renderAgentRole(theme, agent.modelRole);
	const duration = theme.fg("muted", formatAgentDuration((agent.completedAt ?? now) - agent.startedAt));
	const cost = theme.fg("muted", formatAgentCost(agent.cost));
	return [role, duration, cost].filter(Boolean).join(theme.fg("dim", separator));
}

export function renderContextUse(theme: AgentSummaryTheme, percent: number | undefined): string | undefined {
	if (percent === undefined || !Number.isFinite(percent)) return undefined;
	const color = percent >= 80 ? "error" : percent >= 60 ? "warning" : "success";
	return theme.fg(color, `${Math.round(percent)}% ctx`);
}

export function renderAgentRole(
	theme: AgentSummaryTheme,
	role: { readonly name: string; readonly color: string } | undefined,
): string | undefined {
	return role ? theme.fg(role.color, role.name) : undefined;
}

export function renderTranscriptPreview(theme: AgentSummaryTheme, preview: TranscriptPreview | undefined): string {
	if (!preview) return theme.fg("muted", "waiting");
	const label = preview.label ?? preview.kind;
	const color = preview.kind === "tool" ? "mdLink" : preview.kind === "bash" ? "warning" : "dim";
	const text = preview.text || "…";
	return `${theme.fg(color, label)}${theme.fg("dim", ":")} ${theme.fg("muted", text)}`;
}
