import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	backgroundAnsiAtColumn,
	contrastingPillBackground,
	type PillContent,
	renderPill as renderTuiPill,
	type TuiBackgroundPaint,
	type TuiBackgroundToken,
	type TuiForegroundColor,
	tuiTheme,
} from "pi-libtui";
import { legacyAnnotationText } from "../core/envelope.ts";
import type { DraftAnnotation, ResponseAnnotation } from "../core/types.ts";

export type PillSurface = "base" | "user";
export type PillState = "normal" | "hover" | "cursor";

export interface PillRenderContext {
	surface: PillSurface;
	state?: PillState;
	foreground?: TuiForegroundColor;
	surroundingBackgroundAnsi?: string;
}

export function renderPill(theme: Theme, content: PillContent, context: PillRenderContext): string {
	const state = context.state ?? "normal";
	const background = pillBackground(theme, context.surface, state, context.surroundingBackgroundAnsi);
	const emphasized = state !== "normal";
	return renderTuiPill(
		theme,
		{ ...content, label: emphasized ? theme.bold(content.label) : content.label },
		background,
		context.foreground ?? "text.primary",
		undefined,
		context.surroundingBackgroundAnsi,
	);
}

function pillBackground(
	theme: Theme,
	surface: PillSurface,
	state: PillState,
	destinationAnsi: string | undefined,
): TuiBackgroundPaint {
	const candidates: readonly TuiBackgroundToken[] =
		state === "normal"
			? surface === "base"
				? ["surface.selected", "badge.neutral", "surface.raised"]
				: ["badge.neutral", "surface.raised", "surface.selected"]
			: state === "hover"
				? ["surface.hover", "surface.raised", "badge.neutral"]
				: ["surface.raised", "surface.hover", "badge.neutral"];
	const semantic = candidates.find((candidate) => !collidesWithDestination(theme, candidate, destinationAnsi));
	if (semantic !== undefined || destinationAnsi === undefined) return semantic ?? candidates[0]!;
	return contrastingPillBackground(theme, destinationAnsi);
}

function collidesWithDestination(
	theme: Theme,
	preferred: TuiBackgroundToken,
	destinationAnsi: string | undefined,
): destinationAnsi is string {
	if (destinationAnsi === undefined) return false;
	const expected = tuiTheme(theme).bgAnsi(preferred);
	return expected === backgroundAnsiAtColumn(`${destinationAnsi} `, 0);
}

export function annotationDetailLines(
	theme: Theme,
	draft: DraftAnnotation,
	availableWidth: number,
	_surface: PillSurface = "base",
): string[] {
	return detailLines(
		theme,
		`Annotation #${draft.index}`,
		[`Selected: ${draft.selection.text}`, `Comment: ${draft.content}`],
		availableWidth,
	);
}

export function responseAnnotationDetailLines(
	theme: Theme,
	annotation: ResponseAnnotation,
	index: number,
	availableWidth: number,
	_surface: PillSurface = "base",
): string[] {
	return detailLines(
		theme,
		`Annotation #${index}`,
		[`Selected: ${annotation.text}`, `Comment: ${legacyAnnotationText(annotation.annotation)}`],
		availableWidth,
	);
}

export function decorateDetailCard(
	screen: string[],
	card: readonly string[],
	anchor: { row: number; col: number },
	width: number,
): string[] {
	const result = [...screen];
	const cardWidth = Math.min(width, Math.max(0, ...card.map((line) => visibleWidth(line))));
	const x = Math.max(0, Math.min(anchor.col, Math.max(0, width - cardWidth)));
	const below = anchor.row + 1;
	const y = below + card.length <= result.length ? below : Math.max(0, anchor.row - card.length);
	for (const [offset, line] of card.entries()) {
		const row = y + offset;
		if (row >= result.length) break;
		const overlayWidth = Math.min(cardWidth, width - x);
		const clipped = sliceByColumn(line, 0, overlayWidth, true);
		const base = result[row] ?? "";
		result[row] = compositeTuiLine(base, clipped, x, overlayWidth, overlayTotalWidth(base, x, overlayWidth, width));
	}
	return result;
}

function detailLines(theme: Theme, title: string, source: readonly string[], availableWidth: number): string[] {
	const contentWidth = Math.max(
		visibleWidth(title) + 5,
		...source.flatMap((row) => row.split("\n")).map((row) => visibleWidth(row) + 2),
	);
	const width = Math.max(4, Math.min(60, availableWidth, contentWidth));
	const innerWidth = Math.max(1, width - 2);
	const rows = wrapDetailRows(source, innerWidth, 7);
	const background = "surface.raised";
	const colors = tuiTheme(theme);
	const border = (text: string): string => colors.fg("border", text);
	const fittedTitle = truncateToWidth(title, Math.max(0, width - 5), "");
	const titleWidth = visibleWidth(fittedTitle);
	const top = colors.bg(
		background,
		`${border("╭─ ")}${colors.fg("text.secondary", fittedTitle)}${border(
			` ${"─".repeat(Math.max(0, width - titleWidth - 5))}╮`,
		)}`,
	);
	const body = rows.map((row) => {
		const text = truncateToWidth(row, innerWidth, "");
		const foreground = colors.fg("text.primary", text);
		return colors.bg(
			background,
			`${border("│")}${foreground}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))}${border("│")}`,
		);
	});
	return [top, ...body, colors.bg(background, border(`╰${"─".repeat(width - 2)}╯`))];
}

function wrapDetailRows(sourceRows: readonly string[], width: number, maxRows: number): string[] {
	const wrapped: string[] = [];
	for (const source of sourceRows) {
		for (const logicalLine of source.split("\n")) {
			let remaining = logicalLine;
			do {
				const row = sliceByColumn(remaining, 0, width, true);
				wrapped.push(row);
				remaining = sliceByColumn(
					remaining,
					visibleWidth(row),
					Math.max(0, visibleWidth(remaining) - visibleWidth(row)),
					true,
				);
			} while (remaining.length > 0);
		}
	}
	if (wrapped.length <= maxRows) return wrapped;
	const result = wrapped.slice(0, maxRows);
	result[maxRows - 1] = `${sliceByColumn(result[maxRows - 1] ?? "", 0, Math.max(0, width - 1), true)}…`;
	return result;
}

export function overlayTotalWidth(base: string, start: number, overlayWidth: number, width: number): number {
	const afterStart = start + overlayWidth;
	const after = sliceByColumn(base, afterStart, Math.max(0, width - afterStart), true);
	const afterVisible = visibleWidth(after);
	const afterContent = visibleWidth(stripTerminalSequences(after).replace(/\s+$/u, ""));
	const hasStyledPadding = /\x1b\[[0-9;]*m/u.test(after);
	const preservedAfter = afterContent > 0 || hasStyledPadding ? afterVisible : 0;
	return Math.min(width, Math.max(afterStart, afterStart + preservedAfter));
}
