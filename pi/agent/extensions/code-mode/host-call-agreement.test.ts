import { expect, it } from "bun:test";
import type { CellRecord, NestedCallRecord } from "./runtime.ts";
import { hostCallOutstanding } from "./runtime.ts";

/**
 * `hostCallOutstanding` must agree with the Rust host's own view of "the cell is blocked in a tool": runtime marks
 * the call `running` for the same window the host freezes CELL_HARD_TIMEOUT_MS. If the two diverge, one clock pauses
 * and the other does not, which is the bug the pause was added to fix.
 *
 * This is keyed on the status union, so adding a status fails to compile until someone classifies it.
 */
const OUTSTANDING_BY_STATUS: Record<NestedCallRecord["status"], boolean> = {
	running: true,
	completed: false,
	error: false,
};

function recordWith(...statuses: Array<NestedCallRecord["status"]>): CellRecord {
	const calls = statuses.map((status) => ({ status }) as NestedCallRecord);
	return { calls } as CellRecord;
}

it("treats exactly the running status as an outstanding host call", () => {
	for (const [status, outstanding] of Object.entries(OUTSTANDING_BY_STATUS)) {
		expect(hostCallOutstanding(recordWith(status as NestedCallRecord["status"]))).toBe(outstanding);
	}
});

it("is outstanding while any one call is running, and not once every call has settled", () => {
	expect(hostCallOutstanding(recordWith())).toBe(false);
	expect(hostCallOutstanding(recordWith("completed", "error"))).toBe(false);
	// A cell may hold several nested calls at once; one unsettled call still blocks the cell.
	expect(hostCallOutstanding(recordWith("completed", "running"))).toBe(true);
	expect(hostCallOutstanding(recordWith("running", "running"))).toBe(true);
});
