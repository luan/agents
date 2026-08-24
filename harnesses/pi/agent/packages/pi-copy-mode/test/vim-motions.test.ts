import { expect, test } from "bun:test";
import {
	findCharMotionTarget,
	findWordMotionTarget,
	VimMotionCache,
	type LazyTextDocument,
} from "../src/core/vim-motions.ts";

test("word motion stays lazy on a 10k-line transcript", () => {
	let reads = 0;
	const document: LazyTextDocument = {
		lineCount: 10_000,
		line(row) {
			reads += 1;
			return row === 5_000 ? "alpha beta" : "untouched";
		},
	};
	const cache = new VimMotionCache();
	expect(findWordMotionTarget(document, cache, { row: 5_000, col: 0 }, "forward", "start", "word", 1)).toEqual({
		row: 5_000,
		col: 6,
	});
	expect(reads).toBe(1);
});

test("word and WORD distinguish punctuation", () => {
	const document: LazyTextDocument = { lineCount: 1, line: () => "one,two three" };
	const cache = new VimMotionCache();
	expect(findWordMotionTarget(document, cache, { row: 0, col: 0 }, "forward", "start", "word")).toEqual({
		row: 0,
		col: 3,
	});
	expect(findWordMotionTarget(document, cache, { row: 0, col: 0 }, "forward", "start", "WORD")).toEqual({
		row: 0,
		col: 8,
	});
});

test("character find uses grapheme display columns", () => {
	const document: LazyTextDocument = { lineCount: 1, line: () => "a界x界z" };
	const cache = new VimMotionCache();
	expect(findCharMotionTarget(document, cache, { row: 0, col: 0 }, "f", "界", false, 2)).toEqual({ row: 0, col: 4 });
	expect(findCharMotionTarget(document, cache, { row: 0, col: 0 }, "t", "界")).toEqual({ row: 0, col: 0 });
});

test("motion cache keeps a 256-entry LRU bound", () => {
	const document: LazyTextDocument = { lineCount: 300, line: (row) => `line ${row}` };
	const cache = new VimMotionCache();
	for (let row = 0; row < 300; row += 1) cache.graphemes(document, row);
	expect(cache.entryCount).toBe(256);
	expect(cache.computationCount).toBe(300);
	cache.graphemes(document, 299);
	expect(cache.computationCount).toBe(300);
	cache.graphemes(document, 0);
	expect(cache.computationCount).toBe(301);
});
