import type { Theme } from "@earendil-works/pi-coding-agent";
import { progressFrame, tuiTheme } from "@luan.sh/pi-libtui";
import type { CodexUsageSnapshot, CodexUsageWindow } from "./payload.ts";
function windowLabel(window: CodexUsageWindow, fallback: string): string {
	const minutes = window.windowMinutes;
	return minutes === undefined
		? fallback
		: minutes >= 1440
			? minutes === 10080
				? "Weekly"
				: `${Math.round(minutes / 1440)} days`
			: `${Math.round(minutes / 60)} hours`;
}
export function formatQuota(snapshot: CodexUsageSnapshot): string {
	const rows = [snapshot.planType ? `Plan: ${snapshot.planType}` : "Codex usage"];
	for (const limit of snapshot.limits) {
		rows.push(`\n${limit.limitName ?? limit.limitId}`);
		for (const [name, window] of [
			["Primary", limit.primary],
			["Secondary", limit.secondary],
		] as const) {
			if (!window) continue;
			const remaining =
				window.usedPercent === undefined
					? "unavailable"
					: `${Math.max(0, Math.min(100, 100 - window.usedPercent))}% remaining`;
			const reset =
				window.resetsAt === undefined
					? "reset unavailable"
					: `resets ${new Date(window.resetsAt * 1000).toLocaleString()}`;
			rows.push(`  ${windowLabel(window, name)}: ${remaining} · ${reset}`);
		}
	}
	rows.push(`\nReset credits: ${snapshot.resetCredits?.availableCount ?? "unavailable"}`);
	for (const credit of snapshot.resetCredits?.credits.slice(0, 4) ?? [])
		if (credit.expiresAt) rows.push(`  ${credit.title ?? "Credit"} · expires ${credit.expiresAt}`);
	return rows.join("\n");
}
export function canRedeem(snapshot: CodexUsageSnapshot): boolean {
	const core = snapshot.limits.find((limit) => limit.limitId === "codex");
	return Boolean(
		snapshot.accountId &&
			(snapshot.resetCredits?.availableCount ?? 0) > 0 &&
			[core?.primary, core?.secondary].some((window) => window?.usedPercent !== undefined && window.usedPercent >= 90),
	);
}

function shortDate(value: number | string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "unavailable"
		: date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function quotaText(snapshot: CodexUsageSnapshot, theme: Theme): string {
	const colors = tuiTheme(theme);
	const rows: string[] = [];
	for (const limit of snapshot.limits) {
		if (rows.length) rows.push("");
		rows.push(
			theme.bold(colors.fg("text.primary", limit.limitId === "codex" ? "Codex" : (limit.limitName ?? limit.limitId))),
		);
		const windows = [
			["Primary", limit.primary],
			["Secondary", limit.secondary],
		] as const;
		for (const [fallback, window] of windows) {
			if (!window) continue;
			const remaining =
				window.usedPercent === undefined ? undefined : Math.max(0, Math.min(100, 100 - window.usedPercent));
			const label = windowLabel(window, fallback).padEnd(10);
			const tone = remaining !== undefined && remaining <= 10 ? "warning" : "accent";
			const meter =
				remaining === undefined
					? colors.fg("text.muted", "—".repeat(14))
					: progressFrame(colors, { value: remaining / 100, width: 14, tone });
			rows.push(
				`${colors.fg("text.secondary", label)} ${meter}  ${colors.fg("text.primary", remaining === undefined ? "Unavailable" : `${Math.round(remaining)}% remaining`)}`,
			);
			rows.push(
				colors.fg(
					"text.muted",
					`           ${window.resetsAt === undefined ? "Reset time unavailable" : `Resets ${shortDate(window.resetsAt * 1000)}`}`,
				),
			);
		}
		if (!limit.primary && !limit.secondary) rows.push(colors.fg("text.muted", "Usage unavailable"));
	}
	rows.push(
		"",
		theme.bold(colors.fg("text.primary", `Reset credits  ${snapshot.resetCredits?.availableCount ?? "Unavailable"}`)),
	);
	for (const credit of snapshot.resetCredits?.credits.slice(0, 4) ?? []) {
		if (credit.expiresAt)
			rows.push(colors.fg("text.muted", `${credit.title ?? "Credit"} · expires ${shortDate(credit.expiresAt)}`));
	}
	return rows.join("\n");
}
