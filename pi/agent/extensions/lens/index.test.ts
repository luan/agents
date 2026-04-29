import { describe, expect, it } from "bun:test";

import { runLensHookCommand } from "./index.ts";

const hookEvent = {
	schema_version: "lens.hook_event.v1",
	host: { name: "pi", kind: "extension" },
	session: { id: "test", seq: 1 },
	cwd: "/tmp",
	turn: { id: "turn-test", index: 0 },
	event: "agent_end",
	known_files: [],
};

describe("Lens hook runner", () => {
	it("degrades instead of throwing when spawning ct fails", async () => {
		const response = await runLensHookCommand("lens-agent-end", hookEvent, "/tmp", {
			runner: async () => {
				const error = new Error("spawn EBADF") as NodeJS.ErrnoException;
				error.code = "EBADF";
				throw error;
			},
		});

		expect(response.status).toBe("degraded");
		expect(response.decision).toEqual({ outcome: "allow", reason: "hook_command_failed" });
		expect(response.errors[0]).toEqual({ code: "hook_command_failed", message: "ct hook failed to start: spawn EBADF" });
	});

	it("degrades invalid hook stdout without dropping command details", async () => {
		const response = await runLensHookCommand("lens-agent-end", hookEvent, "/tmp", {
			runner: async () => ({ stdout: "not json", stderr: "bad output", exitCode: 2 }),
		});

		expect(response.status).toBe("degraded");
		expect(response.decision.reason).toBe("invalid_hook_response");
		expect(response.errors[0].message).toBe("ct hook failed with exit code 2: bad output");
		expect(response.data).toEqual({ stdout: "not json", stderr: "bad output", exitCode: 2 });
	});
});
