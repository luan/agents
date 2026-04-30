import { describe, expect, it } from "bun:test";

import {
	applyLensUi,
	filesFromTool,
	filesFromToolAndResult,
	runLensHookCommand,
	shouldApplyHookUiForTool,
} from "./index.ts";

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
		expect(response.decision).toEqual({
			outcome: "allow",
			reason: "hook_command_failed",
		});
		expect(response.errors[0]).toEqual({
			code: "hook_command_failed",
			message: "ct hook failed to start: spawn EBADF",
		});
	});

	it("degrades invalid hook stdout without dropping command details", async () => {
		const response = await runLensHookCommand("lens-agent-end", hookEvent, "/tmp", {
			runner: async () => ({
				stdout: "not json",
				stderr: "bad output",
				exitCode: 2,
			}),
		});

		expect(response.status).toBe("degraded");
		expect(response.decision.reason).toBe("invalid_hook_response");
		expect(response.errors[0].message).toBe("ct hook failed with exit code 2: bad output");
		expect(response.data).toEqual({
			stdout: "not json",
			stderr: "bad output",
			exitCode: 2,
		});
	});
});

describe("Lens tool file attribution", () => {
	it("extracts touched files from apply_patch payloads", () => {
		const files = filesFromTool("apply_patch", {
			input: [
				"*** Begin Patch",
				"*** Add File: src/new.rs",
				"+fn main() {}",
				"*** Update File: src/old.ts",
				"@@",
				"-const value = 1;",
				"+const value = 2;",
				"*** Update Scope: src/scoped.ts",
				"@@ render",
				"-old",
				"+new",
				"*** Replace All In File: src/all.ts",
				"*** Expect Replacements: 1",
				"-old",
				"+new",
				"*** Delete File: src/remove.ts",
				"*** Move File: src/from.ts -> src/to.ts",
				"*** End Patch",
			].join("\n"),
		});

		expect(files).toEqual([
			{ path: "src/new.rs", operation: "write" },
			{ path: "src/old.ts", operation: "edit" },
			{ path: "src/scoped.ts", operation: "edit" },
			{ path: "src/all.ts", operation: "edit" },
			{ path: "src/remove.ts", operation: "delete" },
			{ path: "src/from.ts", operation: "delete" },
			{ path: "src/to.ts", operation: "write" },
		]);
	});

	it("extracts update-file move targets from apply_patch payloads", () => {
		const files = filesFromTool(
			"apply_patch",
			`*** Begin Patch
*** Update File: src/old-name.ts
*** Move to: src/new-name.ts
*** End Patch`,
		);

		expect(files).toEqual([
			{ path: "src/old-name.ts", operation: "delete" },
			{ path: "src/new-name.ts", operation: "write" },
		]);
	});

	it("falls back to apply_patch result fileDiffs", () => {
		const files = filesFromToolAndResult(
			"apply_patch",
			{},
			{
				fileDiffs: [
					{ path: "src/new.rs", operation: "add" },
					{ path: "src/edit.ts", operation: "update" },
					{ path: "src/remove.ts", operation: "delete" },
					{ path: "src/from.ts", moveTo: "src/to.ts", operation: "update" },
				],
			},
		);

		expect(files).toEqual([
			{ path: "src/new.rs", operation: "write" },
			{ path: "src/edit.ts", operation: "edit" },
			{ path: "src/remove.ts", operation: "delete" },
			{ path: "src/from.ts", operation: "delete" },
			{ path: "src/to.ts", operation: "write" },
		]);
	});

	it("recognizes namespaced apply_patch tool names", () => {
		const files = filesFromTool("functions.apply_patch", {
			input: `*** Begin Patch
*** Add File: src/namespaced.rs
+fn main() {}
*** End Patch`,
		});

		expect(files).toEqual([{ path: "src/namespaced.rs", operation: "write" }]);
	});
});

describe("Lens live HUD updates", () => {
	it("does not let Lens tool post-hook responses overwrite Lens tool result HUD state", () => {
		expect(shouldApplyHookUiForTool("lens_health")).toBe(false);
		expect(shouldApplyHookUiForTool("lens_checks")).toBe(false);
		expect(shouldApplyHookUiForTool("exec_command")).toBe(true);
	});

	it("applies actual Lens tool result envelopes to the HUD", () => {
		const status: Record<string, string> = {};
		const widgets: Record<string, string[]> = {};
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (key: string, value: string) => {
					status[key] = value;
				},
				setWidget: (key: string, value: string[]) => {
					widgets[key] = value;
				},
			},
		};

		applyLensUi(ctx, {
			status: "warning",
			data: {
				status: "warning",
				compact: "warning · diag 1",
				summary: {
					diagnostics: { active: 1, errors: 0, warnings: 1 },
					checks: { latest: [] },
					cleanup: { failed: 0, timed_out: 0 },
					patch_refs: { draft_refs: 0, hunks: 0, accepted_events: 0 },
				},
			},
		});

		expect(status.lens).toContain("warning");
		expect(status.lens).toContain("diag 1");
		expect(widgets["lens-health"]?.[0]).toContain("warning");
	});
});
