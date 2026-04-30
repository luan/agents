import { expect, test } from "bun:test";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";

test("exec session manager runs short non-interactive commands", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec({ cmd: "printf codex-exec", yield_time_ms: 5000 }, process.cwd());
		expect(result.output).toBe("codex-exec");
		expect(result.exit_code).toBe(0);
		expect(result.session_id).toBeUndefined();
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager can poll running sessions", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const first = await sessions.exec({ cmd: "sleep 1; printf done", yield_time_ms: 250 }, process.cwd());
		expect(first.session_id).toBeNumber();
		const next = await sessions.write({ session_id: first.session_id!, chars: "", yield_time_ms: 5000 });
		expect(next.output).toContain("done");
		expect(next.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager can write to tty-requested sessions", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const first = await sessions.exec({ cmd: "read line; printf \"got:$line\"", tty: true, yield_time_ms: 250 }, process.cwd());
		expect(first.session_id).toBeNumber();
		const next = await sessions.write({ session_id: first.session_id!, chars: "hi\n", yield_time_ms: 5000 });
		expect(next.output).toContain("got:hi");
		expect(next.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});
