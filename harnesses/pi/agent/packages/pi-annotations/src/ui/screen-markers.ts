import type { Theme } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { backgroundAnsiAtColumn, PointerInteractionController } from "pi-libtui";
import type { MouseRect, TuiMouseEvent, ViewportRect } from "pi-libtui/mouse";
import { plainPill, transcriptPillContent } from "../core/pills.ts";
import type { DraftAnnotation } from "../core/types.ts";
import { annotationDetailLines, decorateDetailCard, overlayTotalWidth, renderPill } from "./pills.ts";

export interface AnnotationMarkerHit {
	draftId: string;
	rect: MouseRect;
}

export class AnnotationMarkerController {
	private hits: AnnotationMarkerHit[] = [];
	private readonly interaction = new PointerInteractionController<AnnotationMarkerHit>({
		key: (hit) => hit.draftId,
		rect: (hit) => hit.rect,
	});

	decorate(
		screen: string[],
		drafts: readonly DraftAnnotation[],
		width: number,
		theme: Theme,
		viewport?: ViewportRect,
		transcriptLines?: readonly string[],
	): string[] {
		const result = [...screen];
		this.hits = [];
		for (const group of markerGroups(drafts, result, width, viewport, transcriptLines)) {
			const totalWidth = group.drafts.reduce((sum, draft) => sum + markerWidth(draft), 0);
			const desiredCol = group.col;
			// Handles are overlays: when a full line leaves no free cells, cover its
			// final cells rather than widening or reflowing the transcript.
			const col = Math.max(0, Math.min(desiredCol, Math.max(0, width - totalWidth)));
			let cursor = col;
			let rendered = "";
			// Every cap samples the unmodified destination line. Sampling `result`
			// would let an earlier pill on the same row become the next pill's
			// background instead of the transcript cell underneath it. When the
			// fullscreen host provides logical transcript rows, prefer that row over
			// `screen`: copy-mode may already have painted selection/cursor colors
			// into the latter.
			const base = screen[group.row] ?? "";
			const destination = group.destinationLine ?? base;
			const destinationOffset = group.destinationLine ? group.destinationX : 0;
			for (const draft of group.drafts) {
				const body = renderPill(theme, transcriptPillContent(draft), {
					surface: "base",
					state: this.interaction.hoveredTarget()?.draftId === draft.id ? "hover" : "normal",
					foreground: "accent",
					surroundingBackgroundAnsi: backgroundAnsiAtColumn(destination, Math.max(0, cursor - destinationOffset)),
				});
				const bodyWidth = visibleWidth(body);
				rendered += body;
				if (cursor < width)
					this.hits.push({
						draftId: draft.id,
						rect: { x: cursor, y: group.row, width: Math.min(bodyWidth, width - cursor), height: 1 },
					});
				cursor += bodyWidth;
			}
			const clipped = sliceByColumn(rendered, 0, Math.max(0, width - col), true);
			const overlayWidth = Math.min(totalWidth, width - col);
			result[group.row] = compositeTuiLine(
				base,
				clipped,
				col,
				overlayWidth,
				overlayTotalWidth(base, col, overlayWidth, width),
			);
		}
		this.interaction.setTargets(this.hits);
		const hoveredHit = this.interaction.hoveredTarget();
		const hoveredDraft = hoveredHit ? drafts.find((draft) => draft.id === hoveredHit.draftId) : undefined;
		return hoveredHit && hoveredDraft
			? decorateAnnotationDetail(result, hoveredDraft, { row: hoveredHit.rect.y, col: hoveredHit.rect.x }, width, theme)
			: result;
	}

	hitAt(screenCol: number, screenRow: number): AnnotationMarkerHit | undefined {
		return this.interaction.targetAt(screenCol, screenRow);
	}

	setHover(hit: AnnotationMarkerHit | undefined): boolean {
		return this.interaction.setHover(hit);
	}

	getBounds(): MouseRect | undefined {
		return this.interaction.getBounds();
	}

	handleMouse(
		event: TuiMouseEvent,
		onHoverChange: () => void,
		onActivate: (hit: AnnotationMarkerHit) => void,
	): boolean {
		return this.interaction.handleMouse(event, {
			onHoverChange,
			onActivate,
		});
	}

	clear(): void {
		this.hits = [];
		this.interaction.clear();
	}
}

export function decorateAnnotationMarkers(
	screen: string[],
	drafts: readonly DraftAnnotation[],
	width: number,
	theme: Theme,
	viewport?: ViewportRect,
	transcriptLines?: readonly string[],
): string[] {
	return new AnnotationMarkerController().decorate(screen, drafts, width, theme, viewport, transcriptLines);
}

export function shouldDecorateAnnotationMarkers(localOverlayActive: boolean, hostHasOverlay: boolean): boolean {
	return !localOverlayActive && !hostHasOverlay;
}

export function decorateAnnotationDetail(
	screen: string[],
	draft: DraftAnnotation,
	anchor: { row: number; col: number },
	width: number,
	theme: Theme,
): string[] {
	return decorateDetailCard(screen, annotationDetailLines(theme, draft, width), anchor, width);
}

interface MarkerGroup {
	row: number;
	col: number;
	drafts: DraftAnnotation[];
	destinationLine?: string;
	destinationX: number;
}

interface TranscriptAnchor {
	row: number;
	/** End column in the logical transcript line, measured in terminal cells. */
	endColumn: number;
}

function markerGroups(
	drafts: readonly DraftAnnotation[],
	screen: readonly string[],
	width: number,
	viewport?: ViewportRect,
	transcriptLines?: readonly string[],
): MarkerGroup[] {
	const groups = new Map<string, MarkerGroup>();
	for (const draft of drafts) {
		const transcriptAnchor =
			transcriptLines === undefined ? undefined : resolveTranscriptAnchor(draft, transcriptLines);
		const logicalRow = transcriptLines === undefined ? draft.selection.end.row : transcriptAnchor?.row;
		const mappedRow = viewport && logicalRow !== undefined ? viewport.y + logicalRow - viewport.scrollTop : undefined;
		const row = resolveMarkerRow(
			draft,
			screen,
			mappedRow,
			draft.selection.screenEnd.row,
			viewport,
			transcriptLines !== undefined,
			logicalRow,
		);
		if (row < 0 || row >= screen.length) continue;
		const col = markerColumn(draft, screen[row] ?? "", row, mappedRow, viewport, transcriptAnchor?.endColumn);
		const safeCol = Math.max(0, Math.min(width, col));
		const key = `${row}:${safeCol}`;
		const group = groups.get(key);
		if (group) group.drafts.push(draft);
		else {
			const destinationLine =
				transcriptLines !== undefined && logicalRow !== undefined ? transcriptLines[logicalRow] : undefined;
			groups.set(key, {
				row,
				col: safeCol,
				drafts: [draft],
				...(destinationLine !== undefined ? { destinationLine } : {}),
				destinationX: viewport?.x ?? 0,
			});
		}
	}
	return [...groups.values()];
}

function markerColumn(
	draft: DraftAnnotation,
	line: string,
	row: number,
	mappedRow: number | undefined,
	viewport: ViewportRect | undefined,
	transcriptEndColumn: number | undefined,
): number {
	if (draft.selection.shape === "line") return lineContentWidth(line);
	if (transcriptEndColumn !== undefined) {
		return (viewport?.x ?? 0) + transcriptEndColumn;
	}
	const selectedColumn = selectedTextColumn(line, draft.selection.text);
	if (selectedColumn !== undefined) return selectedColumn;
	const mapped = mappedRow === row && viewport ? viewport.x + draft.selection.end.col : undefined;
	return mapped ?? draft.selection.screenEnd.col;
}

function resolveMarkerRow(
	draft: DraftAnnotation,
	screen: readonly string[],
	mappedRow: number | undefined,
	capturedRow: number,
	viewport: ViewportRect | undefined,
	validateMappedText: boolean,
	logicalRow: number | undefined,
): number {
	const selectedLine = selectedTextLine(draft.selection.text);
	const uniqueVisibleMatch = (): number =>
		selectedLine.length === 0 ? -1 : uniqueMatchingRow(screen, draft, viewport);
	if (validateMappedText && !viewport) {
		if (logicalRow === undefined || logicalRow < 0 || logicalRow >= screen.length) return uniqueVisibleMatch();
		if (selectedLine.length === 0 || stripTerminalSequences(screen[logicalRow] ?? "").includes(selectedLine))
			return logicalRow;
		return uniqueVisibleMatch();
	}
	if (viewport) {
		const mappedOutsideViewport =
			mappedRow === undefined ||
			mappedRow < viewport.y ||
			mappedRow >= viewport.y + viewport.height ||
			mappedRow < 0 ||
			mappedRow >= screen.length;
		if (mappedOutsideViewport) return validateMappedText ? uniqueVisibleMatch() : -1;
		if (!validateMappedText) return mappedRow;
		// A stale logical coordinate must never leave a marker floating on unrelated content.
		if (selectedLine.length === 0 || stripTerminalSequences(screen[mappedRow] ?? "").includes(selectedLine))
			return mappedRow;
		// Fullscreen copy-mode can retain the previous viewport mapping for one
		// composition after a fold changes transcript height. Re-anchor only when
		// the selected text has exactly one visible match; ambiguity stays hidden.
		return uniqueVisibleMatch();
	}
	const candidates = [mappedRow, capturedRow].filter(
		(row): row is number => row !== undefined && row >= 0 && row < screen.length,
	);
	const quote = draft.selection.source?.quote;
	const requiresQuoteContext = Boolean(quote?.prefix || quote?.suffix);
	const matches = (row: number): boolean =>
		!requiresQuoteContext &&
		(selectedLine.length === 0 || stripTerminalSequences(screen[row] ?? "").includes(selectedLine));
	const matchingCandidate = candidates.find(matches);
	if (matchingCandidate !== undefined) return matchingCandidate;
	const visibleMatch = uniqueVisibleMatch();
	if (visibleMatch >= 0) return visibleMatch;
	// Without a logical transcript layout, a captured endpoint is only a hint.
	// If the selected text is absent from every visible row, hiding the marker is
	// safer than floating it onto unrelated content after reflow or scrolling.
	return -1;
}

function uniqueMatchingRow(
	screen: readonly string[],
	draft: DraftAnnotation,
	viewport: ViewportRect | undefined,
): number {
	const start = Math.max(0, viewport?.y ?? 0);
	const end = Math.min(screen.length, viewport ? viewport.y + viewport.height : screen.length);
	const anchor = resolveTranscriptAnchor(draft, screen.slice(start, end));
	return anchor === undefined ? -1 : start + anchor.row;
}

function resolveTranscriptAnchor(
	draft: DraftAnnotation,
	transcriptLines: readonly string[],
): TranscriptAnchor | undefined {
	const source = transcriptLines.map(stripTerminalSequences).join("\n");
	const quote = draft.selection.source?.quote;
	const exact = quote?.exact ?? draft.selection.text;
	if (exact.length === 0) return { row: draft.selection.end.row, endColumn: draft.selection.end.col };

	const matchingOffset = (candidate: string): number | undefined => {
		const matches: number[] = [];
		let offset = source.indexOf(candidate);
		while (offset >= 0) {
			const prefixMatches =
				!quote?.prefix || source.slice(Math.max(0, offset - quote.prefix.length), offset) === quote.prefix;
			const suffixStart = offset + candidate.length;
			const suffixMatches =
				!quote?.suffix || source.slice(suffixStart, suffixStart + quote.suffix.length) === quote.suffix;
			if (prefixMatches && suffixMatches) matches.push(offset);
			// Advance by one cell so overlapping occurrences (for example "ana" in
			// "anana") are ambiguous too; skipping by the match width can float the
			// marker onto the first of two valid anchors.
			offset = source.indexOf(candidate, offset + 1);
		}
		return matches.length === 1 ? matches[0] : undefined;
	};

	// Line selections include the newline after the selected rows. The logical
	// transcript omits the final document newline, so accept that one boundary
	// only when the full quote cannot match. Do not generally trim selection text:
	// spaces and internal newlines are part of the source identity.
	const offset = matchingOffset(exact) ?? (exact.endsWith("\n") ? matchingOffset(exact.slice(0, -1)) : undefined);
	if (offset === undefined) return undefined;
	const endOffset = offset + (source.startsWith(exact, offset) ? exact.length : exact.length - 1);
	const anchorOffset =
		draft.selection.shape === "line" && exact.endsWith("\n") && endOffset > offset ? endOffset - 1 : endOffset;
	const row = source.slice(0, anchorOffset).split("\n").length - 1;
	const lineStart = source.lastIndexOf("\n", Math.max(0, anchorOffset - 1)) + 1;
	return { row, endColumn: visibleWidth(source.slice(lineStart, anchorOffset)) };
}

function selectedTextLine(text: string): string {
	return stripTerminalSequences(text.split("\n").at(-1) ?? "").trimEnd();
}

function selectedTextColumn(line: string, text: string): number | undefined {
	const selectedLine = selectedTextLine(text);
	if (selectedLine.length === 0) return undefined;
	const plainLine = stripTerminalSequences(line);
	const start = plainLine.lastIndexOf(selectedLine);
	return start < 0 ? undefined : visibleWidth(plainLine.slice(0, start + selectedLine.length));
}

function markerWidth(draft: DraftAnnotation): number {
	return visibleWidth(plainPill(transcriptPillContent(draft)));
}

function lineContentWidth(line: string): number {
	return visibleWidth(stripTerminalSequences(line).replace(/\s+$/u, ""));
}
