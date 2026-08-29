import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	compositeTuiLine,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import type { MouseRect, MouseRegistry, ScreenDecorationContext } from "../mouse.ts";

export interface DetailCardContent {
	readonly title: string;
	readonly rows: readonly string[];
}

export interface HoverDetailCardTarget {
	readonly rect: MouseRect;
	readonly content: DetailCardContent;
}

export interface HoverDetailCardOptions {
	readonly id: string;
	readonly theme: Theme;
	readonly registry: MouseRegistry;
	readonly priority?: number;
	readonly pointerPriority?: number;
	getTarget(screen: readonly string[], context: ScreenDecorationContext): HoverDetailCardTarget | undefined;
}

export interface HoverDetailCardMount {
	dispose(): void;
}

/** Mount the same annotation-style detail card over any screen-locatable pill. */
export function mountHoverDetailCard(options: HoverDetailCardOptions): HoverDetailCardMount {
	let target: HoverDetailCardTarget | undefined;
	let hovered = false;
	const removeDecorator = options.registry.registerScreenDecorator({
		id: options.id,
		priority: options.priority ?? 5_000,
		decorate(screen, context) {
			target = context.hasOverlay ? undefined : options.getTarget(screen, context);
			if (!target) hovered = false;
			if (!hovered || !target) return screen;
			return decorateDetailCard(
				screen,
				renderDetailCard(options.theme, target.content, context.width),
				{ row: target.rect.y, col: target.rect.x },
				context.width,
			);
		},
	});
	const removeRegion = options.registry.registerOverlayRegion({
		id: options.id,
		priority: options.pointerPriority ?? 500,
		getRect: () => target?.rect,
		onMouse(event) {
			const next = event.type !== "leave";
			const changed = hovered !== next;
			hovered = next;
			return changed || next;
		},
	});
	return {
		dispose() {
			target = undefined;
			hovered = false;
			removeDecorator();
			removeRegion();
		},
	};
}

/** Render the shared annotation-style hover card. */
export function renderDetailCard(theme: Theme, content: DetailCardContent, availableWidth: number): string[] {
	const contentWidth = Math.max(
		visibleWidth(content.title) + 5,
		...content.rows.flatMap((row) => row.split("\n")).map((row) => visibleWidth(row) + 2),
	);
	const width = Math.max(4, Math.min(60, availableWidth, contentWidth));
	const innerWidth = Math.max(1, width - 2);
	const rows = wrapRows(content.rows, innerWidth, 7);
	const colors = tuiTheme(theme);
	const border = (text: string): string => colors.fg("border", text);
	const fittedTitle = truncateToWidth(content.title, Math.max(0, width - 5), "");
	const titleWidth = visibleWidth(fittedTitle);
	const top = colors.bg(
		"surface.raised",
		`${border("╭─ ")}${colors.fg("text.secondary", fittedTitle)}${border(
			` ${"─".repeat(Math.max(0, width - titleWidth - 5))}╮`,
		)}`,
	);
	const body = rows.map((row) => {
		const text = truncateToWidth(row, innerWidth, "");
		return colors.bg(
			"surface.raised",
			`${border("│")}${colors.fg("text.primary", text)}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))}${border("│")}`,
		);
	});
	return [top, ...body, colors.bg("surface.raised", border(`╰${"─".repeat(width - 2)}╯`))];
}

/** Composite a detail card beside an inline anchor. */
export function decorateDetailCard(
	screen: readonly string[],
	card: readonly string[],
	anchor: { readonly row: number; readonly col: number },
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

export function overlayTotalWidth(base: string, start: number, overlayWidth: number, width: number): number {
	const afterStart = start + overlayWidth;
	const after = sliceByColumn(base, afterStart, Math.max(0, width - afterStart), true);
	const afterVisible = visibleWidth(after);
	const afterContent = visibleWidth(stripTerminalSequences(after).replace(/\s+$/u, ""));
	const hasStyledPadding = /\x1b\[[0-9;]*m/u.test(after);
	const preservedAfter = afterContent > 0 || hasStyledPadding ? afterVisible : 0;
	return Math.min(width, Math.max(afterStart, afterStart + preservedAfter));
}

function wrapRows(sourceRows: readonly string[], width: number, maxRows: number): string[] {
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
