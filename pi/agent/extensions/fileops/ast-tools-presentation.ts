import type { Component } from "@earendil-works/pi-tui";
import { type CardTheme, darkerCardBackgroundAnsi, framedBlock, renderStatusLine } from "../shared/tui/card.ts";
import { EmptyComponent } from "../shared/tui/index.ts";
import {
	buildHighlightedDiffRowsSync,
	EditDiffView,
	highlightCodeRowsSync,
	languageFromPath,
	type RenderTheme,
} from "./diff-render.ts";
import type { ToolTextResult } from "./execution.ts";

type AstTheme = CardTheme & RenderTheme;

type AstOutputSection = {
	header: string;
	path: string;
	rows: Array<{ line: number; code: string; meta?: string }>;
};

const EMPTY_VIEW = new EmptyComponent();

function parseAstOutputSections(text: string): AstOutputSection[] {
	const sections: AstOutputSection[] = [];
	for (const block of text.split(/\n{2,}/)) {
		const lines = block.split("\n");
		const header = lines.shift()?.trim();
		if (!header) continue;
		const rows: AstOutputSection["rows"] = [];
		for (const line of lines) {
			const match = /^([1-9]\d*):(.*)$/.exec(line);
			if (match) rows.push({ line: Number(match[1]), code: match[2] ?? "" });
			else if (line.startsWith("meta:") && rows.length > 0) rows[rows.length - 1]!.meta = line;
		}
		if (rows.length === 0) continue;
		const taggedPath = /^\[(.+?)#[0-9A-Fa-f]{4}\]$/.exec(header)?.[1];
		sections.push({ header, path: taggedPath ?? header, rows });
	}
	return sections;
}

function renderAstSearchLines(text: string, theme: AstTheme, expanded: boolean, failed: boolean): string[] {
	const sections = parseAstOutputSections(text);
	if (sections.length === 0) return text.split("\n").map((line) => theme.fg(failed ? "error" : "toolOutput", line));
	const maxRows = expanded ? Number.POSITIVE_INFINITY : 12;
	const lines: string[] = [];
	let emitted = 0;
	for (const [sectionIndex, section] of sections.entries()) {
		if (emitted >= maxRows) break;
		const visibleRows = section.rows.slice(0, maxRows - emitted);
		const lastSection = sectionIndex === sections.length - 1 || emitted + visibleRows.length >= maxRows;
		const branch = lastSection ? (theme.tree?.last ?? "└─") : (theme.tree?.branch ?? "├─");
		const continuation = lastSection ? "   " : `${theme.tree?.vertical ?? "│"}  `;
		const icon = theme.getLangIcon?.(languageFromPath(section.path));
		lines.push(`${theme.fg("dim", `${branch} ${icon ? `${icon} ` : ""}`)}${theme.fg("accent", section.header)}`);
		const highlighted = highlightCodeRowsSync(
			section.path,
			visibleRows.map((row) => row.code),
		);
		for (const [rowIndex, row] of visibleRows.entries()) {
			const lineNumber = String(row.line).padStart(4, " ");
			lines.push(`${theme.fg("dim", `${continuation}${lineNumber}│`)}${highlighted[rowIndex] ?? row.code}`);
			if (row.meta) lines.push(`${theme.fg("dim", `${continuation}     ${row.meta}`)}`);
			emitted++;
		}
	}
	const totalRows = sections.reduce((count, section) => count + section.rows.length, 0);
	if (emitted < totalRows) lines.push(theme.fg("muted", `... (${totalRows - emitted} more matches)`));
	return lines;
}

type AstRenderContext = {
	args?: { pattern?: string; path?: string; apply?: boolean };
	isError?: boolean;
};

function astHeader(
	theme: AstTheme,
	title: string,
	params: { pattern?: string; path?: string; apply?: boolean },
	status: "pending" | "success" | "error",
	meta?: string[],
): string {
	return renderStatusLine(theme, {
		icon: status,
		title,
		description: params.pattern ? JSON.stringify(params.pattern) : undefined,
		meta: [params.path ?? ".", ...(meta ?? [])],
	});
}

function astResultCard(
	title: string,
	result: ToolTextResult,
	options: { expanded?: boolean },
	theme: AstTheme,
	context: AstRenderContext | undefined,
	body: { lines?: string[]; component?: Component } = {},
) {
	const failed = context?.isError === true;
	const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
	const allLines = text ? text.split("\n") : [];
	const lines = body.lines ?? (options.expanded ? allLines : allLines.slice(0, 12));
	if (!body.lines && lines.length < allLines.length) lines.push(`… ${allLines.length - lines.length} more lines`);
	const matches = typeof result.details?.matches === "number" ? [`${result.details.matches} matches`] : [];
	const backgroundColor = failed ? "toolErrorBg" : "toolPendingBg";
	return framedBlock(theme, {
		header: astHeader(theme, title, context?.args ?? {}, failed ? "error" : "success", matches),
		sections: [
			...(lines.length > 0 ? [{ lines }] : []),
			...(body.component ? [{ label: theme.fg("toolTitle", "Diff"), component: body.component }] : []),
		],
		borderColor: failed ? "error" : "borderMuted",
		backgroundColor,
		backgroundAnsi: darkerCardBackgroundAnsi(theme, backgroundColor),
	});
}

export function createAstToolPresentation() {
	return {
		renderShell: "self" as const,
		astGrepCall(params: unknown, theme: AstTheme, context: { isPartial?: boolean } | undefined) {
			if (context?.isPartial === false) return EMPTY_VIEW;
			const input = params as { pattern?: string; path?: string };
			return framedBlock(theme, {
				header: astHeader(theme, "AST search", input, "pending"),
				borderColor: "borderMuted",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, "toolPendingBg"),
			});
		},
		astGrepResult(
			result: ToolTextResult,
			options: { expanded?: boolean },
			theme: AstTheme,
			context: AstRenderContext,
		) {
			const lines = renderAstSearchLines(
				typeof result.content[0]?.text === "string" ? result.content[0].text : "",
				theme,
				options.expanded === true,
				context?.isError === true,
			);
			return astResultCard("AST search", result, options, theme, context, { lines });
		},
		astEditCall(params: unknown, theme: AstTheme, context: { isPartial?: boolean } | undefined) {
			if (context?.isPartial === false) return EMPTY_VIEW;
			const input = params as { pattern?: string; path?: string; apply?: boolean };
			return framedBlock(theme, {
				header: astHeader(theme, "AST edit", input, "pending", [input.apply ? "apply" : "preview"]),
				borderColor: "borderMuted",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, "toolPendingBg"),
			});
		},
		astEditResult(
			result: ToolTextResult,
			options: { expanded?: boolean },
			theme: AstTheme,
			context: AstRenderContext,
		) {
			const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
			const rows = diff ? buildHighlightedDiffRowsSync(diff) : undefined;
			const backgroundAnsi = darkerCardBackgroundAnsi(theme, "toolPendingBg");
			const component = diff
				? new EditDiffView(diff, rows, options.expanded === true, theme, backgroundAnsi)
				: undefined;
			return astResultCard("AST edit", result, options, theme, context, { component });
		},
	};
}
