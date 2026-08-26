import { activityFrame, icon, type TuiForegroundToken, type TuiTheme } from "pi-libtui";
import type { SubagentSnapshot, SubagentStatus, TranscriptPreview } from "../runtime/coordinator.ts";

type AgentRowSummary = Pick<SubagentSnapshot, "status" | "startedAt" | "completedAt" | "cost" | "modelRole">;

export function formatAgentCost(cost: number): string {
	if (cost <= 0) return "$0.00";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatAgentDuration(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function formatAgentTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m tokens`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
	return `${tokens} tokens`;
}

export function renderAgentStatusMarker(
	colors: TuiTheme,
	status: SubagentStatus,
	startedAt: number,
	now: number,
): string {
	switch (status) {
		case "running":
			return activityFrame(colors, "", now - startedAt).marker;
		case "idle":
			return colors.fg("positive", icon("confirm"));
		case "failed":
			return colors.fg("negative", icon("error"));
		case "interrupted":
			return colors.fg("warning", icon("cancel"));
		case "queued":
			return colors.fg("text.muted", icon("checkbox-off"));
	}
}

/** Render an agent name with activity text and status markers kept independent. */
export function renderAgentIdentity(
	colors: TuiTheme,
	name: string,
	status: SubagentStatus,
	startedAt: number,
	now: number,
	nameTone: TuiForegroundToken = "text.primary",
): string {
	if (status === "running") {
		const frame = activityFrame(colors, name, now - startedAt, { textTone: nameTone });
		return frame.marker ? `${frame.marker} ${frame.text}` : frame.text;
	}
	return `${renderAgentStatusMarker(colors, status, startedAt, now)} ${colors.fg(nameTone, name)}`;
}

export function renderAgentMetadata(colors: TuiTheme, agent: AgentRowSummary, now: number, separator = " · "): string {
	const role = renderAgentRole(colors, agent.modelRole);
	const duration = colors.fg("text.muted", formatAgentDuration((agent.completedAt ?? now) - agent.startedAt));
	const cost = colors.fg("text.muted", formatAgentCost(agent.cost));
	return [role, duration, cost]
		.filter((value): value is string => value !== undefined)
		.join(colors.fg("text.muted", separator));
}

export function renderContextUse(colors: TuiTheme, percent: number | undefined): string | undefined {
	if (percent === undefined || !Number.isFinite(percent)) return undefined;
	const tone = percent >= 80 ? "negative" : percent >= 60 ? "warning" : "positive";
	return colors.fg(tone, `${Math.round(percent)}% ctx`);
}

export function renderAgentRole(
	colors: TuiTheme,
	role: { readonly name: string; readonly color: string } | undefined,
): string | undefined {
	if (!role) return undefined;
	const hues = ["blue", "cyan", "green", "magenta", "yellow"] as const;
	const hash = [...role.name].reduce((total, character) => total + character.codePointAt(0)!, 0);
	return colors.fg({ hue: hues[hash % hues.length]!, shade: 4 }, role.name);
}

export function renderTranscriptPreview(colors: TuiTheme, preview: TranscriptPreview | undefined): string {
	if (!preview) return colors.fg("text.muted", "waiting");
	const label = preview.label ?? preview.kind;
	const tone = preview.kind === "tool" ? "info" : preview.kind === "bash" ? "warning" : "text.secondary";
	return `${colors.fg(tone, label)}${colors.fg("text.muted", ":")} ${colors.fg("text.muted", preview.text || "…")}`;
}
