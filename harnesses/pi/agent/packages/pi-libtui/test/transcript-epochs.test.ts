import { expect, test } from "bun:test";
import {
	defaultWindow,
	type HistoryEntry,
	historyChunks,
	rebaseWindow,
	type TranscriptChunk,
} from "../src/host/transcript-epochs.ts";

const say = (id: string): HistoryEntry => ({ id, type: "message", message: { role: "assistant" } });
const result = (id: string): HistoryEntry => ({ id, type: "message", message: { role: "toolResult" } });
const compaction = (id: string): HistoryEntry => ({ id, type: "compaction" });
const state = (id: string): HistoryEntry => ({ id, type: "custom" });
const ids = (chunks: readonly TranscriptChunk<HistoryEntry>[]) =>
	chunks.map((chunk) => chunk.entries.map((entry) => entry.id));
const one = { min: 1, max: 100 };

test("history chunks exclude the live model context and start a new chunk at every compaction", () => {
	const branch = [say("a"), compaction("c1"), say("b"), say("kept"), compaction("c2"), say("live")];
	const chunks = historyChunks(branch, new Set(["c2", "kept", "live"]), { min: 10, max: 100 });
	expect(ids(chunks)).toEqual([["a"], ["c1", "b"]]);
	expect(chunks.map((chunk) => [chunk.key, chunk.epoch, chunk.first])).toEqual([
		["a:a", 0, true],
		["c1:b", 1, true],
	]);
	expect(historyChunks(branch, new Set(branch.map((entry) => entry.id)), one)).toEqual([]);
});

test("a chunk never starts at a tool result, so Pi can pair every call with its result", () => {
	const branch = [say("a"), result("ra"), result("rb"), say("b"), result("rc")];
	expect(ids(historyChunks(branch, new Set(), one))).toEqual([
		["a", "ra", "rb"],
		["b", "rc"],
	]);
});

test("chunks end at allowed breaks once they reach the minimum size", () => {
	const branch = [say("a"), say("b"), say("c"), say("d"), say("e")];
	// Breaks are allowed before b and e only.
	const breaks = () => [true, true, false, false, true];
	expect(ids(historyChunks(branch, new Set(), { min: 1, max: 100 }, breaks))).toEqual([["a"], ["b", "c", "d"], ["e"]]);
	expect(ids(historyChunks(branch, new Set(), { min: 2, max: 100 }, breaks))).toEqual([["a", "b", "c", "d"], ["e"]]);
});

test("the maximum size splits a long run at a step boundary even without an allowed break", () => {
	const branch = [say("a"), result("ra"), say("b"), result("rb"), say("c"), say("d")];
	const none = () => branch.map(() => false);
	expect(ids(historyChunks(branch, new Set(), { min: 1, max: 2 }, none))).toEqual([
		["a", "ra", "b", "rb"],
		["c", "d"],
	]);
});

test("entries that render nothing do not count toward a chunk's size", () => {
	const chunks = historyChunks([say("a"), state("s1"), state("s2"), result("r"), say("b")], new Set(), {
		min: 2,
		max: 100,
	});
	expect(ids(chunks)).toEqual([["a", "s1", "s2", "r", "b"]]);
	expect(chunks[0]?.size).toBe(2);
});

test("a chunk key changes when the chunk grows, so its page is rebuilt", () => {
	const branch = [compaction("c1"), say("x"), say("y")];
	const before = historyChunks(branch, new Set(["y"]), { min: 10, max: 100 });
	const after = historyChunks(branch, new Set(), { min: 10, max: 100 });
	expect(before[0]?.key).not.toBe(after[0]?.key);
});

test("the default window holds the newest chunks up to a number of displayed entries", () => {
	const chunks = historyChunks(
		Array.from({ length: 10 }, (_, index) => say(`m${index}`)),
		new Set(),
		one,
	);
	expect(defaultWindow(chunks, 1)).toEqual({ lo: 9, hi: 9 });
	expect(defaultWindow(chunks, 3)).toEqual({ lo: 7, hi: 9 });
	expect(defaultWindow(chunks, 100)).toEqual({ lo: 0, hi: 9 });
	expect(defaultWindow([], 3)).toEqual({ lo: 0, hi: -1 });
});

test("a regrouped window stays on the same entries, and a window at the live edge stays there", () => {
	const branch = Array.from({ length: 8 }, (_, index) => say(`m${index}`));
	const fine = historyChunks(branch, new Set(["m6", "m7"]), one);
	const coarse = historyChunks(branch, new Set(["m6", "m7"]), { min: 2, max: 100 });
	// A reader on m2..m3 keeps those entries loaded after pages are regrouped in pairs.
	expect(ids(coarse)).toEqual([
		["m0", "m1"],
		["m2", "m3"],
		["m4", "m5"],
	]);
	expect(rebaseWindow({ lo: 2, hi: 3 }, fine, coarse, 1)).toEqual({ lo: 1, hi: 1 });
	// When the live entries become history, a window touching the live edge grows to include them.
	const grown = historyChunks(branch, new Set(), one);
	expect(rebaseWindow({ lo: 4, hi: 5 }, fine, grown, 1)).toEqual({ lo: 4, hi: 7 });
	expect(rebaseWindow({ lo: 1, hi: 2 }, fine, grown, 1)).toEqual({ lo: 1, hi: 2 });
	// Unknown entries, such as another session's, fall back to the default window.
	const other = historyChunks([say("x"), say("y")], new Set(), one);
	expect(rebaseWindow({ lo: 1, hi: 2 }, fine, other, 1)).toEqual({ lo: 1, hi: 1 });
	expect(rebaseWindow({ lo: 0, hi: -1 }, [], grown, 1)).toEqual({ lo: 7, hi: 7 });
	expect(rebaseWindow({ lo: 1, hi: 2 }, fine, [], 1)).toEqual({ lo: 0, hi: -1 });
});
