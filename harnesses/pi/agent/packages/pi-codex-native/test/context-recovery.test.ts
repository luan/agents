import { expect, test } from "bun:test";
import { registerContextWindowProvider } from "../../pi-context-windows/src/sdk.ts";
import { contextRecoveryActive, recoveryWindow, verifyRecoveryRequest } from "../src/contributions/context-recovery.ts";

test("provider recovery stays session-scoped and rejects a request without its current window", () => {
	const dispose = registerContextWindowProvider({
		entries: (id) => (id === "recovery-test" ? [] : undefined),
		project: (_id, messages) => messages,
		snapshot: (id) =>
			id === "recovery-test" ? { id: "window-2", boundaryEntryId: "boundary", checkpoint: "continue" } : undefined,
	});
	try {
		expect(contextRecoveryActive("recovery-test")).toBe(true);
		expect(recoveryWindow("unrelated")).toBeUndefined();
		expect(() => verifyRecoveryRequest("recovery-test", [{ role: "user", content: "old history" }])).toThrow(
			"refusing to send stale",
		);
		expect(() =>
			verifyRecoveryRequest("recovery-test", [
				{ role: "user", content: "<context_window>\nCurrent window: window-2\n</context_window>" },
			]),
		).not.toThrow();
	} finally {
		dispose();
	}
	expect(contextRecoveryActive("recovery-test")).toBe(false);
});
