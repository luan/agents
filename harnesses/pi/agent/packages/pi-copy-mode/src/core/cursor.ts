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

export function moveCursor(point: CursorPoint, motion: CursorMotion, document: CursorDocument): CursorPoint {
	const lastRow = Math.max(0, document.lineCount - 1);
	const page = Math.max(1, document.viewportHeight);
	const halfPage = Math.max(1, Math.floor(page / 2));
	let next = point;
	switch (motion) {
		case "left":
			next = { ...point, col: horizontalStop(document, point, -1) };
			break;
		case "right":
			next = { ...point, col: horizontalStop(document, point, 1) };
			break;
		case "up":
			next = { ...point, row: point.row - 1 };
			break;
		case "down":
			next = { ...point, row: point.row + 1 };
			break;
		case "line-start":
			next = { ...point, col: 0 };
			break;
		case "line-end":
			next = { ...point, col: lastColumn(document, point.row) };
			break;
		case "document-start":
			next = { row: 0, col: point.col };
			break;
		case "document-end":
			next = { row: lastRow, col: point.col };
			break;
		case "half-page-up":
			next = { ...point, row: point.row - halfPage };
			break;
		case "half-page-down":
			next = { ...point, row: point.row + halfPage };
			break;
		case "page-up":
			next = { ...point, row: point.row - page };
			break;
		case "page-down":
			next = { ...point, row: point.row + page };
			break;
	}
	return clampCursor(next, document);
}

export function moveVirtualCursor(
	point: CursorPoint,
	motion: CursorMotion,
	document: VirtualCursorDocument,
): CursorPoint {
	const lastRow = Math.max(0, document.lineCount - 1);
	const page = Math.max(1, document.viewportHeight);
	const halfPage = Math.max(1, Math.floor(page / 2));
	let row = point.row;
	let col = point.col;
	switch (motion) {
		case "left":
			col -= 1;
			break;
		case "right":
			col += 1;
			break;
		case "up":
			row -= 1;
			break;
		case "down":
			row += 1;
			break;
		case "line-start":
			col = 0;
			break;
		case "line-end":
			col = document.maxColumn;
			break;
		case "document-start":
			row = 0;
			break;
		case "document-end":
			row = lastRow;
			break;
		case "half-page-up":
			row -= halfPage;
			break;
		case "half-page-down":
			row += halfPage;
			break;
		case "page-up":
			row -= page;
			break;
		case "page-down":
			row += page;
			break;
	}
	return { row: clamp(row, 0, lastRow), col: clamp(col, 0, Math.max(0, document.maxColumn)) };
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
