import { expect, it } from "bun:test";
import { clampedYieldNotice } from "./tools/exec-session-manager.ts";

it("reports raised and capped yield windows", () => {
	expect(clampedYieldNotice(1_000, 30_000)).toBe("yield-time_ms was clamped from 1000ms to 30000ms.");
	expect(clampedYieldNotice(600_000, 120_000)).toBe("yield-time_ms was clamped from 600000ms to 120000ms.");
});

it("stays silent when no requested window was changed", () => {
	expect(clampedYieldNotice(undefined, 30_000)).toBeUndefined();
	expect(clampedYieldNotice(0, 0)).toBeUndefined();
	expect(clampedYieldNotice(60_000, 60_000)).toBeUndefined();
});
