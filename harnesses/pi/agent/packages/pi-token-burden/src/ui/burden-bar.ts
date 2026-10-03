import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTuiText, tuiTheme } from "@luan.sh/pi-libtui";
import type { TokenBurdenReport } from "../core/report.ts";
import { money } from "./report-rows.ts";

const HUES = ["blue", "green", "yellow", "magenta", "cyan", "red", "gray"] as const;
const fmt = (value: number) => value.toLocaleString("en-US");

/** Historical headline and stacked prompt bar, without inventing unavailable attribution. */
export function reportSummary(report: TokenBurdenReport, theme: Theme, width: number, height: number): string[] {
	if (height < 6 || width < 1) return [];
	const colors = tuiTheme(theme);
	const contentWidth = Math.max(1, width - 2);
	const row = (text: string) => ` ${truncateToWidth(text, contentWidth, "")}`;
	const context = report.context;
	const percent =
		context?.percent ??
		(context?.tokens != null && context.contextWindow > 0 ? (context.tokens / context.contextWindow) * 100 : null);
	const headline =
		context?.tokens != null
			? `~${fmt(context.tokens)} / ${fmt(context.contextWindow)} tokens${percent === null ? "" : ` (${percent.toFixed(1)}%)`}`
			: `Context unavailable${context ? ` / ${fmt(context.contextWindow)} tokens` : ""}`;
	const source = context?.tokens != null ? "estimated" : "";
	const gap = Math.max(1, contentWidth - visibleWidth(headline) - source.length);
	const lines = [row(`${headline}${" ".repeat(gap)}${colors.fg("text.muted", source)}`)];
	if (height < 16) return lines;
	if (percent !== null) {
		const bar = burdenBar(percent, 100, Math.max(1, contentWidth - 2), "█", "░");
		const filled = bar.includes("░") ? bar.indexOf("░") : bar.length;
		lines.push(row(colors.fg("accent", bar.slice(0, filled)) + colors.fg("text.muted", bar.slice(filled))));
	}
	const usage = report.usage.branch;
	if (usage.totals) {
		const turns = usage.records.filter((record) => record.kind === "assistant").length;
		lines.push(
			row(
				colors.fg(
					"text.muted",
					`floor ${usage.floorTokens === null ? "unavailable" : fmt(usage.floorTokens)}  ·  ${usage.cachedShare === null ? "cache unavailable" : `${(usage.cachedShare * 100).toFixed(0)}% cached`}  ·  ${turns} turns  ·  ${money(usage.totals.cost)}`,
				),
			),
		);
	}
	if (height >= 28) lines.push("", "─".repeat(width), "");
	lines.push(row(colors.fg("text.secondary", `System prompt — estimated ~${fmt(report.promptTokens)}`)));
	const sections = report.promptSections;
	const total = sections.reduce((sum, section) => sum + section.estimate, 0);
	const barWidth = Math.max(1, contentWidth - 2);
	let consumed = 0;
	let drawn = 0;
	let bar = "";
	const legend: string[] = [];
	for (const [index, section] of sections.entries()) {
		const color = { hue: HUES[index % HUES.length] ?? "gray", shade: 3 } as const;
		consumed += section.estimate;
		const end = total > 0 ? Math.round((consumed / total) * barWidth) : 0;
		bar += colors.fg(color, "█".repeat(Math.max(0, end - drawn)));
		drawn = end;
		const label = truncateToWidth(singleLabel(section.label), 12);
		legend.push(
			`${colors.fg(color, "■")} ${label} ${total > 0 ? ((section.estimate / total) * 100).toFixed(1) : "0.0"}%`,
		);
	}
	lines.push(row(bar));
	let current = "";
	const legendLines: string[] = [];
	for (const part of legend) {
		const next = current ? `${current}  ${part}` : part;
		if (current && visibleWidth(next) > contentWidth) {
			legendLines.push(current);
			current = part;
		} else current = next;
	}
	if (current) legendLines.push(current);
	// Keep the historical table visible; the complete section list is in the drilldown.
	lines.push(...legendLines.slice(0, 2).map(row));
	if (legendLines.length > 2) lines.push(row(colors.fg("text.muted", "… more prompt sections in drilldown")));
	lines.push("", "─".repeat(width), "");
	return height >= 28 ? ["", ...lines] : lines;
}

function singleLabel(label: string): string {
	if (label === "System prompt") return "Base";
	return sanitizeTuiText(label).replace(/[\r\n]+/g, " ");
}

/** Compact, deterministic burden meter used in rows and summaries. */
export function burdenBar(value: number, total: number, width = 12, fill = "█", empty = "·"): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
	return `${fill.repeat(Math.round(ratio * safeWidth))}${empty.repeat(safeWidth - Math.round(ratio * safeWidth))}`;
}
