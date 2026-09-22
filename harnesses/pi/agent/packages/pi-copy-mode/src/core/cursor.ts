export interface CursorPoint {
	row: number;
	col: number;
}

export interface CursorDocument {
	lineCount: number;
	lineWidth(row: number): number;
	lineStops(row: number): readonly number[];
	viewportHeight: number;
}

export interface VirtualCursorDocument {
	lineCount: number;
	viewportHeight: number;
	maxColumn: number;
}

export type CursorMotion =
	| "left"
	| "right"
	| "up"
	| "down"
	| "line-start"
	| "line-end"
	| "document-start"
	| "document-end"
	| "half-page-up"
	| "half-page-down"
	| "page-up"
	| "page-down";

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function lastColumn(document: CursorDocument, row: number): number {
	return document.lineStops(row).at(-1) ?? 0;
}

function snapColumn(column: number, stops: readonly number[]): number {
	let snapped = stops[0] ?? 0;
	for (const stop of stops) {
		if (stop > column) break;
		snapped = stop;
	}
	return snapped;
}

function horizontalStop(document: CursorDocument, point: CursorPoint, direction: -1 | 1): number {
	const stops = document.lineStops(point.row);
	const current = snapColumn(point.col, stops);
	const index = Math.max(0, stops.indexOf(current));
	return stops[Math.max(0, Math.min(stops.length - 1, index + direction))] ?? 0;
}

export function clampCursor(point: CursorPoint, document: CursorDocument): CursorPoint {
	const lastRow = Math.max(0, document.lineCount - 1);
	const row = clamp(point.row, 0, lastRow);
	return { row, col: snapColumn(clamp(point.col, 0, lastColumn(document, row)), document.lineStops(row)) };
}

/** Vertical motions preserve the preferred column; horizontal motions return undefined. */
export function verticalMotionRow(
	row: number,
	motion: CursorMotion,
	document: Pick<CursorDocument, "lineCount" | "viewportHeight">,
	count = 1,
): number | undefined {
	const page = Math.max(1, document.viewportHeight);
	const halfPage = Math.max(1, Math.floor(page / 2));
	switch (motion) {
		case "up":
			return row - count;
		case "down":
			return row + count;
		case "half-page-up":
			return row - halfPage * count;
		case "half-page-down":
			return row + halfPage * count;
		case "page-up":
			return row - page * count;
		case "page-down":
			return row + page * count;
		case "document-start":
			return 0;
		case "document-end":
			return Math.max(0, document.lineCount - 1);
		default:
			return undefined;
	}
}

export function moveCursor(point: CursorPoint, motion: CursorMotion, document: CursorDocument): CursorPoint {
	const row = verticalMotionRow(point.row, motion, document) ?? point.row;
	let col = point.col;
	switch (motion) {
		case "left":
			col = horizontalStop(document, point, -1);
			break;
		case "right":
			col = horizontalStop(document, point, 1);
			break;
		case "line-start":
			col = 0;
			break;
		case "line-end":
			col = lastColumn(document, point.row);
			break;
	}
	return clampCursor({ row, col }, document);
}

export function moveVirtualCursor(
	point: CursorPoint,
	motion: CursorMotion,
	document: VirtualCursorDocument,
): CursorPoint {
	const row = verticalMotionRow(point.row, motion, document) ?? point.row;
	let col = point.col;
	switch (motion) {
		case "left":
			col -= 1;
			break;
		case "right":
			col += 1;
			break;
		case "line-start":
			col = 0;
			break;
		case "line-end":
			col = document.maxColumn;
			break;
	}
	return {
		row: clamp(row, 0, Math.max(0, document.lineCount - 1)),
		col: clamp(col, 0, Math.max(0, document.maxColumn)),
	};
}

export function columnBounds(anchor: CursorPoint, cursor: CursorPoint, document: CursorDocument) {
	return {
		top: Math.min(anchor.row, cursor.row),
		bottom: Math.max(anchor.row, cursor.row),
		left: Math.min(anchor.col, cursor.col),
		right: Math.max(anchor.col + 1, cursor.col + 1, graphemeEnd(anchor, document), graphemeEnd(cursor, document)),
	};
}

export function graphemeEnd(point: CursorPoint, document: CursorDocument): number {
	const stops = document.lineStops(point.row);
	const current = snapColumn(point.col, stops);
	const next = stops.find((stop) => stop > current);
	return next ?? Math.max(current, document.lineWidth(point.row));
}

export function scrollTopForCursor(point: CursorPoint, scrollTop: number, viewportHeight: number): number {
	const height = Math.max(1, viewportHeight);
	if (point.row < scrollTop) return point.row;
	if (point.row >= scrollTop + height) return point.row - height + 1;
	return scrollTop;
}
