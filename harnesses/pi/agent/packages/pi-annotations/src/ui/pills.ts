import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsiAtColumn,
	contrastingPillBackground,
	type PillContent,
	renderDetailCard,
	renderPill as renderTuiPill,
	type TuiBackgroundPaint,
	type TuiBackgroundToken,
	type TuiForegroundColor,
	tuiTheme,
} from "pi-libtui";

export { decorateDetailCard, overlayTotalWidth } from "pi-libtui";

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
	return renderDetailCard(
		theme,
		{
			title: `Annotation #${draft.index}`,
			rows: [`Selected: ${draft.selection.text}`, `Comment: ${draft.content}`],
		},
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
	return renderDetailCard(
		theme,
		{
			title: `Annotation #${index}`,
			rows: [`Selected: ${annotation.text}`, `Comment: ${legacyAnnotationText(annotation.annotation)}`],
		},
		availableWidth,
	);
}
