// `output-budget.ts` decides how unusual a number is; this decides what that looks like. One palette, so every card's orange means the same thing.

import { type CostSeverity, formatTokenCost } from "../output-budget.ts";
import { ansiFgToRgb, type Rgb, rgbFg, type ThemeColorSource, themeRoleAnsi } from "./animation.ts";

const COST_SEVERITY_ROLE: Record<CostSeverity, string> = {
	normal: "dim",
	elevated: "warning",
	high: "warning",
	severe: "error",
};

export function tokenCostRole(severity: CostSeverity): string {
	return COST_SEVERITY_ROLE[severity];
}

// No theme has an orange role, so `high` is blended between `warning` and `error`, and falls back to `warning` when neither resolves to real ANSI.
export function paintTokenCost(theme: ThemeColorSource, severity: CostSeverity, text: string): string {
	if (severity === "high") {
		const orange = blendedOrange(theme);
		if (orange) return `${rgbFg(orange)}${text}\x1b[39m`;
	}
	return theme.fg(COST_SEVERITY_ROLE[severity], text);
}

export function renderTokenCost(theme: ThemeColorSource, tokens: number, toolName?: string): string {
	const cost = formatTokenCost(tokens, toolName);
	return paintTokenCost(theme, cost.severity, cost.text);
}

function blendedOrange(theme: ThemeColorSource): Rgb | undefined {
	const warning = ansiFgToRgb(themeRoleAnsi(theme, "warning"));
	const error = ansiFgToRgb(themeRoleAnsi(theme, "error"));
	if (!warning || !error) return undefined;
	return warning.map((channel, index) => Math.round(channel * 0.4 + error[index]! * 0.6)) as Rgb;
}
