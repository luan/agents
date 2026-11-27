import { expect, test } from "bun:test";
import { defaultWindow, historyEpochs, rebaseWindow } from "../src/host/transcript-epochs.ts";

const entry = (id: string, type = "message") => ({ id, type });

test("history epochs split saved entries at compactions and exclude the live model context", () => {
	const branch = [
		entry("a"),
		entry("b"),
		entry("c1", "compaction"),
		entry("d"),
		entry("kept"),
		entry("c2", "compaction"),
		entry("live"),
	];
	const epochs = historyEpochs(branch, new Set(["c2", "kept", "live"]));
	expect(epochs.map((epoch) => epoch.entries.map((item) => item.id))).toEqual([
		["a", "b"],
		["c1", "d"],
	]);
	expect(epochs.map((epoch) => epoch.key)).toEqual(["a:b", "c1:d"]);
	expect(historyEpochs(branch, new Set(branch.map((item) => item.id)))).toEqual([]);
});

test("an epoch key changes when the epoch grows, so its page is rebuilt", () => {
	const before = historyEpochs([entry("c1", "compaction"), entry("x"), entry("y")], new Set(["y"]));
	const after = historyEpochs([entry("c1", "compaction"), entry("x"), entry("y")], new Set());
	expect(before[0]?.key).not.toBe(after[0]?.key);
});

test("the default window holds the newest epochs next to the live transcript", () => {
	expect(defaultWindow(10, 1)).toEqual({ lo: 9, hi: 9 });
	expect(defaultWindow(1, 3)).toEqual({ lo: 0, hi: 0 });
	expect(defaultWindow(0, 1)).toEqual({ lo: 0, hi: -1 });
});

test("a window that touched the live transcript keeps touching it as compactions add epochs", () => {
	expect(rebaseWindow({ lo: 7, hi: 9 }, 10, 11, 1)).toEqual({ lo: 7, hi: 10 });
	// A reader deep in history keeps the same pages.
	expect(rebaseWindow({ lo: 2, hi: 4 }, 10, 11, 1)).toEqual({ lo: 2, hi: 4 });
	expect(rebaseWindow({ lo: 2, hi: 4 }, 10, 0, 1)).toEqual({ lo: 0, hi: -1 });
	expect(rebaseWindow({ lo: 0, hi: -1 }, 0, 3, 1)).toEqual({ lo: 2, hi: 2 });
	expect(rebaseWindow({ lo: 5, hi: 9 }, 10, 3, 1)).toEqual({ lo: 2, hi: 2 });
});
