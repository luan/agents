import type { Theme } from "@earendil-works/pi-coding-agent";
import { darkerCardBackgroundAnsi, framedBlock, renderStatusLine, treeGlyphs } from "../shared/tui/card.ts";

type ToolSearchMatch = { name: string; description?: string };
type ToolSearchResult = { details?: unknown };
type ToolSearchDetails = { query?: unknown; count?: unknown; matches?: ToolSearchMatch[] };

function compact(value: unknown, limit = 120): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function searchResultRows(details: ToolSearchDetails, theme: Theme): string[] {
	const query = compact(details.query) || "(empty query)";
	const matches = Array.isArray(details.matches) ? details.matches : [];
	const count = typeof details.count === "number" ? details.count : matches.length;
	const glyphs = treeGlyphs(theme);
	const rows = [
		`${theme.fg("muted", "Search")} ${theme.fg("accent", JSON.stringify(query))}`,
		`${theme.fg("muted", "Matches")} ${String(count)}`,
	];
	if (matches.length === 0) {
		rows.push(`${glyphs.last} ${theme.fg("dim", "No matches")}`);
		return rows;
	}
	for (const [index, match] of matches.entries()) {
		const glyph = index === matches.length - 1 ? glyphs.last : glyphs.branch;
		const description = match.description ? theme.fg("muted", ` - ${compact(match.description, 100)}`) : "";
		rows.push(`${glyph} ${theme.fg("accent", match.name)}${description}`);
	}
	return rows;
}

export function renderToolSearchResult(
	result: ToolSearchResult,
	_options: unknown,
	theme: Theme,
	context?: { isError?: boolean },
) {
	const details = result.details && typeof result.details === "object" ? (result.details as ToolSearchDetails) : {};
	const count = typeof details.count === "number" ? details.count : 0;
	const failed = context?.isError === true;
	return framedBlock(theme, {
		header: renderStatusLine(theme, {
			icon: failed ? "error" : "success",
			title: failed ? "Tool search failed" : "Tool search",
			description: `${String(count)} match${count === 1 ? "" : "es"}`,
		}),
		sections: [{ lines: searchResultRows(details, theme) }],
		borderColor: failed ? "error" : "borderMuted",
		backgroundAnsi: darkerCardBackgroundAnsi(theme, failed ? "toolErrorBg" : "toolPendingBg"),
	});
}
