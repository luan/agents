import type { Theme } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { backgroundAnsiAtColumn, PointerInteractionController } from "pi-libtui";
import type { MouseRect, TuiMouseEvent, ViewportRect } from "pi-libtui/mouse";
import { plainPill, responsePillContent } from "../core/pills.ts";
import type { ResolvedAnnotationLink } from "../core/presentation.ts";
import { findAnnotationPointMarkers, replaceAnnotationMarker, stripAnnotationMarker } from "./annotation-markers.ts";
import { decorateDetailCard, renderPill, responseAnnotationDetailLines } from "./pills.ts";

interface ReferenceHit extends ResolvedAnnotationLink {
	url: string;
	rect: MouseRect;
}
interface PreparedReference {
	url: string;
	row: number;
	col: number;
	width: number;
}

export class ReferencePillController {
	private hits: ReferenceHit[] = [];
	private readonly interaction = new PointerInteractionController<ReferenceHit>({
		key: (hit) => hit.url,
		rect: (hit) => hit.rect,
	});
	private prepared: PreparedReference[] = [];
	private selectionPrepared = false;

	prepareSelection(screen: readonly string[]): string[] {
		const merged = new Map<string, PreparedReference>();
		for (const marker of findAnnotationPointMarkers(screen)) {
			// Pi slices APC-wrapped content into multiple fragments when native
			// selection crosses it. The URL is the stable identity of one pill;
			// keep the widest fragment, which is the original visible body, and
			// anchor it at the earliest fragment column.
			const key = `${marker.row}:${marker.url}`;
			const existing = merged.get(key);
			if (!existing) {
				merged.set(key, { ...marker });
			} else {
				merged.set(key, {
					...existing,
					col: Math.min(existing.col, marker.col),
					width: Math.max(existing.width, marker.width),
				});
			}
		}
		this.prepared = [...merged.values()];
		const hovered = this.interaction.hoveredTarget();
		if (hovered && !this.prepared.some((marker) => marker.url === hovered.url)) this.interaction.setHover(undefined);
		this.selectionPrepared = true;
		return screen.map(stripAnnotationMarker);
	}

	decorate(
		screen: string[],
		width: number,
		theme: Theme,
		resolve: (url: string) => ResolvedAnnotationLink | undefined,
		selectionActive = false,
		destinationLines?: readonly string[],
		viewport?: ViewportRect,
	): string[] {
		if (selectionActive || this.selectionPrepared) {
			if (!this.selectionPrepared) screen = this.prepareSelection(screen);
			const result = this.decoratePreparedSelection(screen, width, theme, resolve, destinationLines, viewport);
			const hovered = this.interaction.hoveredTarget();
			return hovered
				? decorateDetailCard(
						result,
						responseAnnotationDetailLines(theme, hovered.annotation, hovered.index, width, hovered.surface),
						{ row: hovered.rect.y, col: hovered.rect.x },
						width,
					)
				: result;
		}
		this.prepared = [];
		this.selectionPrepared = false;
		this.hits = findAnnotationPointMarkers(screen).flatMap((marker) => {
			if (!marker.url.startsWith("pi-annotation://")) return [];
			const resolved = resolve(marker.url);
			if (!resolved) return [];
			const pillWidth = visibleWidth(plainPill(responsePillContent(resolved.annotation, resolved.index)));
			const availableWidth = Math.max(0, width - marker.col);
			const clippedWidth = Math.min(pillWidth, availableWidth);
			if (clippedWidth === 0) return [];
			return [{ ...resolved, url: marker.url, rect: { x: marker.col, y: marker.row, width: clippedWidth, height: 1 } }];
		});
		const result = [...screen];
		for (const hit of this.hits) {
			const destination = destinationLineAt(destinationLines, hit.rect.y, viewport);
			const destinationBackground = backgroundAnsiAtColumn(
				destination ?? screen[hit.rect.y] ?? "",
				destination === undefined ? hit.rect.x : Math.max(0, hit.rect.x - (viewport?.x ?? 0)),
			);
			const pill = renderPill(theme, responsePillContent(hit.annotation, hit.index), {
				surface: hit.surface,
				state: this.interaction.hoveredTarget()?.url === hit.url ? "hover" : "normal",
				foreground: "accent",
				// Reference markers are rebuilt after native selection paint. Prefer
				// the logical transcript cell, but use the rendered screen when no
				// logical destination was supplied.
				surroundingBackgroundAnsi: destinationBackground,
			});
			const replacement = visibleWidth(pill) <= hit.rect.width ? pill : sliceByColumn(pill, 0, hit.rect.width, true);
			result[hit.rect.y] = replaceAnnotationMarker(result[hit.rect.y] ?? "", hit.url, replacement);
		}
		this.interaction.setTargets(this.hits);
		const hovered = this.interaction.hoveredTarget();
		if (!hovered) return result;
		return decorateDetailCard(
			result,
			responseAnnotationDetailLines(theme, hovered.annotation, hovered.index, width, hovered.surface),
			{ row: hovered.rect.y, col: hovered.rect.x },
			width,
		);
	}

	hitAt(screenCol: number, screenRow: number): ReferenceHit | undefined {
		return this.interaction.targetAt(screenCol, screenRow);
	}

	setHover(hit: ReferenceHit | undefined): boolean {
		return this.interaction.setHover(hit);
	}

	handleMouse(event: TuiMouseEvent, onChange: () => void): boolean {
		return this.interaction.handleMouse(event, { onHoverChange: onChange });
	}

	getBounds(): MouseRect | undefined {
		return this.interaction.getBounds();
	}

	clear(): void {
		this.hits = [];
		this.interaction.clear();
		this.prepared = [];
		this.selectionPrepared = false;
	}

	private decoratePreparedSelection(
		screen: string[],
		width: number,
		theme: Theme,
		resolve: (url: string) => ResolvedAnnotationLink | undefined,
		destinationLines?: readonly string[],
		viewport?: ViewportRect,
	): string[] {
		const result = [...screen];
		this.hits = [];
		for (const marker of this.prepared) {
			const resolved = resolve(marker.url);
			if (!resolved || marker.row < 0 || marker.row >= result.length || marker.col >= width) continue;
			const content = responsePillContent(resolved.annotation, resolved.index);
			const availableWidth = Math.max(0, width - marker.col);
			const pillWidth = visibleWidth(renderPill(theme, content, { surface: resolved.surface, foreground: "accent" }));
			const overlayWidth = Math.min(availableWidth, Math.max(marker.width, pillWidth));
			if (overlayWidth === 0) continue;
			const base = screen[marker.row] ?? "";
			const destination = destinationLineAt(destinationLines, marker.row, viewport);
			const destinationBackground = backgroundAnsiAtColumn(
				destination ?? base,
				destination === undefined ? marker.col : Math.max(0, marker.col - (viewport?.x ?? 0)),
			);
			const pill = renderPill(theme, content, {
				surface: resolved.surface,
				state: this.interaction.hoveredTarget()?.url === marker.url ? "hover" : "normal",
				foreground: "accent",
				surroundingBackgroundAnsi: destinationBackground,
			});
			const replacement = visibleWidth(pill) <= overlayWidth ? pill : sliceByColumn(pill, 0, overlayWidth, true);
			result[marker.row] = compositeTuiLine(
				base,
				replacement,
				marker.col,
				overlayWidth,
				Math.max(visibleWidth(base), marker.col + overlayWidth),
			);
			this.hits.push({
				...resolved,
				url: marker.url,
				rect: { x: marker.col, y: marker.row, width: Math.min(pillWidth, availableWidth), height: 1 },
			});
		}
		this.interaction.setTargets(this.hits);
		return result;
	}
}

function destinationLineAt(
	destinationLines: readonly string[] | undefined,
	row: number,
	viewport: ViewportRect | undefined,
): string | undefined {
	if (destinationLines === undefined) return undefined;
	const logicalRow = viewport === undefined ? row : viewport.scrollTop + row - viewport.y;
	return destinationLines[logicalRow];
}

export function handleReferencePillMouse(
	controller: ReferencePillController,
	event: TuiMouseEvent,
	onChange: () => void,
): boolean {
	// Reference pills never claim drag/wheel events; the transcript surface
	// still owns selection and scrolling when the pointer crosses a pill.
	if (event.type === "drag" || event.type === "wheel") return false;
	if (event.type === "leave") {
		controller.handleMouse(event, onChange);
		return true;
	}
	return controller.handleMouse(event, onChange);
}
