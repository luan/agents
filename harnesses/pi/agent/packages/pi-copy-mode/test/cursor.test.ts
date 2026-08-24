import { describe, expect, test } from "bun:test";
import { clampCursor, moveCursor, moveVirtualCursor, scrollTopForCursor } from "../src/core/cursor.ts";

const document = {
	lineCount: 4,
	lineWidth: (row: number) => [4, 2, 0, 8][row] ?? 0,
	lineStops: (row: number) => [[0, 1, 2, 3], [0, 1], [0], [0, 1, 2, 3, 4, 5, 6, 7]][row] ?? [0],
	viewportHeight: 2,
};

describe("cursor motion", () => {
	test("clamps rows and columns against the destination line", () => {
		expect(moveCursor({ row: 0, col: 3 }, "down", document)).toEqual({ row: 1, col: 1 });
		expect(moveCursor({ row: 1, col: 1 }, "down", document)).toEqual({ row: 2, col: 0 });
		expect(moveCursor({ row: 3, col: 7 }, "right", document)).toEqual({ row: 3, col: 7 });
		expect(clampCursor({ row: 99, col: 99 }, document)).toEqual({ row: 3, col: 7 });
	});

	test("moves only between grapheme starts", () => {
		const unicode = { lineCount: 1, lineWidth: () => 5, lineStops: () => [0, 1, 3, 4], viewportHeight: 1 };
		expect(moveCursor({ row: 0, col: 0 }, "right", unicode)).toEqual({ row: 0, col: 1 });
		expect(moveCursor({ row: 0, col: 1 }, "right", unicode)).toEqual({ row: 0, col: 3 });
		expect(moveCursor({ row: 0, col: 3 }, "left", unicode)).toEqual({ row: 0, col: 1 });
		expect(clampCursor({ row: 0, col: 2 }, unicode)).toEqual({ row: 0, col: 1 });
	});

	test("virtual motion preserves columns across rows and advances by cells", () => {
		const virtual = { lineCount: 4, viewportHeight: 2, maxColumn: 7 };
		expect(moveVirtualCursor({ row: 1, col: 5 }, "down", virtual)).toEqual({ row: 2, col: 5 });
		expect(moveVirtualCursor({ row: 2, col: 5 }, "right", virtual)).toEqual({ row: 2, col: 6 });
		expect(moveVirtualCursor({ row: 2, col: 6 }, "document-start", virtual)).toEqual({ row: 0, col: 6 });
		expect(moveVirtualCursor({ row: 0, col: 6 }, "page-down", virtual)).toEqual({ row: 2, col: 6 });
	});

	test("supports line, document, half-page, and full-page motion", () => {
		expect(moveCursor({ row: 3, col: 5 }, "line-start", document)).toEqual({ row: 3, col: 0 });
		expect(moveCursor({ row: 3, col: 0 }, "line-end", document)).toEqual({ row: 3, col: 7 });
		expect(moveCursor({ row: 3, col: 5 }, "document-start", document)).toEqual({ row: 0, col: 3 });
		expect(moveCursor({ row: 0, col: 3 }, "document-end", document)).toEqual({ row: 3, col: 3 });
		expect(moveCursor({ row: 3, col: 0 }, "half-page-up", document)).toEqual({ row: 2, col: 0 });
		expect(moveCursor({ row: 0, col: 0 }, "page-down", document)).toEqual({ row: 2, col: 0 });
	});

	test("only scrolls when the cursor leaves the viewport", () => {
		expect(scrollTopForCursor({ row: 3, col: 0 }, 2, 2)).toBe(2);
		expect(scrollTopForCursor({ row: 1, col: 0 }, 2, 2)).toBe(1);
		expect(scrollTopForCursor({ row: 5, col: 0 }, 2, 2)).toBe(4);
	});
});
