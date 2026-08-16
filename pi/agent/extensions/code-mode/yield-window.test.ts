import { expect, it } from "bun:test";
import { cellWindowMs, clampNotices } from "./index.ts";
import { CELL_HARD_TIMEOUT_MS, CELL_WALL_TIMEOUT_MS } from "./runtime.ts";

// `write_stdin`'s empty-poll floor is 30_000 and its ceiling 120_000 (exec-session-manager.ts:196,197). The cell's
// window was the same 30_000 with no grace, so a nested wait finished exactly as the cell gave up: two consecutive
// live cells reported "still running after 30001ms" and each cost 30s plus a wasted `wait` turn.
const WRITE_STDIN_EMPTY_POLL_FLOOR_MS = 30_000;
const WRITE_STDIN_CEILING_MS = 120_000;

it("keeps the cell window above the nested wait floor so a nested wait cannot orphan its cell", () => {
	expect(cellWindowMs(undefined)).toBeGreaterThan(WRITE_STDIN_EMPTY_POLL_FLOOR_MS);
	expect(cellWindowMs(1_000)).toBeGreaterThan(1_000);
	expect(cellWindowMs(WRITE_STDIN_CEILING_MS)).toBeGreaterThan(WRITE_STDIN_CEILING_MS);
	// A declared yield beyond the ceiling still clamps, and still leaves room for a wait that used all of it.
	expect(cellWindowMs(999_000)).toBeGreaterThan(WRITE_STDIN_CEILING_MS);
});

// The four bounds were chosen in three different files at three different times, which is how the orphaning hid. This
// ordering is the invariant; the individual values may be retuned as long as it holds.
it("orders the four bounds so each one can only be reached after the one below it", () => {
	expect(cellWindowMs(undefined)).toBeLessThanOrEqual(WRITE_STDIN_CEILING_MS);
	expect(WRITE_STDIN_CEILING_MS).toBeLessThan(CELL_HARD_TIMEOUT_MS);
	expect(CELL_HARD_TIMEOUT_MS).toBeLessThan(CELL_WALL_TIMEOUT_MS);
});

// The derivation behind 900_000: ~7 consecutive maximal nested waits alongside a full cell-time budget.
it("leaves the wall ceiling enough room for several maximal waits beyond the cell-time budget", () => {
	const slack = CELL_WALL_TIMEOUT_MS - CELL_HARD_TIMEOUT_MS;

	expect(Math.floor(slack / WRITE_STDIN_CEILING_MS)).toBe(2);
	expect(Math.floor(CELL_WALL_TIMEOUT_MS / WRITE_STDIN_CEILING_MS)).toBe(7);
});

it("reports max_output_tokens clamping without rejecting the cell", () => {
	expect(clampNotices(undefined, 26_000)).toEqual(["max_output_tokens requested 26000; clamped to 25000."]);
});

it("reports yield_time_ms clamping without rejecting the cell", () => {
	expect(clampNotices(121_000, undefined)).toEqual(["yield-time_ms requested 121000; clamped to 120000."]);
});
