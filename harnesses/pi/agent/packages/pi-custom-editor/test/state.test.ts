import { describe, expect, test } from "bun:test";
import { formatDuration, TuiState } from "../src/index.ts";

describe("polished TUI state", () => {
	test("tracks the current and cumulative working duration", () => {
		const state = new TuiState();
		state.start(1000);
		state.stop(3500);
		expect(state.snapshot(4000)).toMatchObject({ active: false, lastTurnMs: 2500, cumulativeMs: 2500 });
		expect(formatDuration(65_000)).toBe("1m05s");
	});
});
