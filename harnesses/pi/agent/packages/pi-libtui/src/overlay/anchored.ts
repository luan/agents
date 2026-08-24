import type { OverlayOptions } from "@earendil-works/pi-tui";

/** Zero-based terminal rectangle occupied by an anchored overlay. */
export interface AnchoredOverlayRect {
	/** Zero-based column of the rectangle's left edge. */
	x: number;
	/** Zero-based row of the rectangle's top edge. */
	y: number;
	/** Render width in terminal columns. */
	width: number;
	/** Render height in terminal rows. */
	height: number;
}

/** Pi overlay options paired with the exact rectangle those options occupy. */
export interface AnchoredOverlayPlacement {
	/** Options to pass to Pi's overlay host. */
	options: OverlayOptions;
	/** Exact zero-based screen rectangle used for pointer translation. */
	rect: AnchoredOverlayRect;
}

/** Terminal geometry and desired size used to place an anchored overlay. */
export interface AnchoredOverlayRequest {
	/** Available terminal width in columns. */
	terminalCols: number;
	/** Available terminal height in rows. */
	terminalRows: number;
	/** Zero-based screen row of the cell beside which the overlay should appear. */
	anchorRow: number;
	/** Zero-based screen column of the cell beside which the overlay should appear. */
	anchorCol: number;
	/** Requested overlay width before terminal-edge clamping. */
	desiredWidth: number;
	/** Requested overlay height before terminal-edge clamping. */
	height: number;
	/** Number of cells between the anchor and overlay; defaults to one. */
	gap?: number;
	/** Horizontal policy; centered overlays clamp around the anchor instead of sitting beside it. */
	horizontalPlacement?: "adjacent" | "center";
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(value, maximum));
}

/**
 * Places an overlay beside a screen cell and returns the exact matching rect.
 * It prefers below/right, flips to above/left when that fits, then clamps.
 *
 * @param request Terminal bounds, anchor cell, and requested overlay geometry.
 * @returns Pi overlay options and their exact clamped zero-based screen rectangle.
 */
export function placeAnchoredOverlay(request: AnchoredOverlayRequest): AnchoredOverlayPlacement {
	const terminalCols = Math.max(0, Math.floor(request.terminalCols));
	const terminalRows = Math.max(0, Math.floor(request.terminalRows));
	const gap = Math.max(0, Math.floor(request.gap ?? 1));
	const width = Math.min(terminalCols, Math.max(0, Math.floor(request.desiredWidth)));
	const height = Math.min(terminalRows, Math.max(0, Math.floor(request.height)));
	const anchorCol = clamp(Math.floor(request.anchorCol), 0, Math.max(0, terminalCols - 1));
	const anchorRow = clamp(Math.floor(request.anchorRow), 0, Math.max(0, terminalRows - 1));

	const right = anchorCol + gap;
	const left = anchorCol - width - gap + 1;
	const x =
		request.horizontalPlacement === "center"
			? clamp(Math.round(anchorCol - width / 2), 0, Math.max(0, terminalCols - width))
			: right + width <= terminalCols
				? right
				: left >= 0
					? left
					: clamp(right, 0, Math.max(0, terminalCols - width));

	const below = anchorRow + gap;
	const above = anchorRow - height - gap + 1;
	const y =
		below + height <= terminalRows ? below : above >= 0 ? above : clamp(below, 0, Math.max(0, terminalRows - height));

	const rect = { x, y, width, height };
	return {
		rect,
		options: {
			anchor: "top-left",
			row: y,
			col: x,
			width,
			maxHeight: height,
			margin: 0,
		},
	};
}
