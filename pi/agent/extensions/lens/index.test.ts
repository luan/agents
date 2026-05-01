import { describe, expect, it } from "bun:test";

import {
	applyLensUi,
	filesFromTool,
	filesFromToolAndResult,
	hasActiveLensDiagnostics,
	default as lensExtension,
	queueLensContext,
	runLensHookCommand,
	suppressStaleLensDiagnosticMessage,
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
	it("reports hook start failures as Lens source errors", async () => {
		const response = await runLensHookCommand("lens-agent-end", hookEvent, "/tmp", {
			runner: async () => {
				const error = new Error("spawn EBADF") as NodeJS.ErrnoException;
				error.code = "EBADF";
				throw error;
			},
		});

		expect(response.status).toBe("error");
		expect(response.decision).toEqual({
			outcome: "allow",
			reason: "hook_command_failed",
		});
		expect(response.data.sources).toEqual([{ name: "lens", connected: false, errors: 1, warnings: 0 }]);
		expect(response.errors[0]).toEqual({
			code: "hook_command_failed",
			message: "ct hook failed to start: spawn EBADF",
		});
	});

	it("reports invalid hook stdout as Lens source errors without dropping command details", async () => {
		const response = await runLensHookCommand("lens-agent-end", hookEvent, "/tmp", {
			runner: async () => ({
				stdout: "not json",
				stderr: "bad output",
				exitCode: 2,
			}),
		});

		expect(response.status).toBe("error");
		expect(response.decision.reason).toBe("invalid_hook_response");
		expect(response.errors[0].message).toBe("ct hook failed with exit code 2: bad output");
		expect(response.data.stdout).toBe("not json");
		expect(response.data.stderr).toBe("bad output");
		expect(response.data.exitCode).toBe(2);
	});

	it("detects whether the current Lens diagnostic snapshot still has active issues", async () => {
		const calls: string[][] = [];
		const clean = await hasActiveLensDiagnostics("/tmp", {
			runner: async (_cmd, args) => {
				calls.push(args);
				return {
					stdout: JSON.stringify({ data: { diagnostic_count: 0, diagnostics: [] } }),
					stderr: "",
					exitCode: 0,
				};
			},
		});
		const dirty = await hasActiveLensDiagnostics("/tmp", {
			runner: async (_cmd, args) => {
				calls.push(args);
				return {
					stdout: JSON.stringify({ data: { diagnostic_count: 1, diagnostics: [{}] } }),
					stderr: "",
					exitCode: 0,
				};
			},
		});

		expect(clean).toBe(false);
		expect(dirty).toBe(true);
		expect(calls).toEqual([
			["lens", "diagnostics", "list", "--json"],
			["lens", "diagnostics", "list", "--json"],
		]);
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

	it("records no files for shell tools without structured file metadata", () => {
		expect(
			filesFromTool("bash", {
				command: "python3 - <<'PY'\nopen('src/hidden.ts', 'w').write('x')\nPY",
			}),
		).toEqual([]);
		expect(filesFromToolAndResult("exec_command", { command: "touch src/hidden.ts" }, { stdout: "" })).toEqual([]);
	});
});

describe("Lens hook-only Pi extension", () => {
	it("registers lifecycle hooks without registering model-visible Lens tools", () => {
		const events: string[] = [];
		const tools: string[] = [];
		const pi = {
			on: (event: string) => {
				events.push(event);
			},
			registerTool: (tool: { name: string }) => {
				tools.push(tool.name);
			},
		};

		lensExtension(pi as any);

		expect(events).toEqual([
			"session_start",
			"before_agent_start",
			"turn_start",
			"tool_call",
			"tool_result",
			"turn_end",
			"message_end",
			"agent_end",
		]);
		expect(tools).toEqual([]);
	});

	it("applies hook response envelopes to the HUD", () => {
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
				status: "warnings",
				sources: [{ name: "lsp", connected: true, errors: 0, warnings: 1 }],
			},
		});

		expect(status.lens).toContain("warnings");
		expect(status.lens).toContain("lsp 0 err/1 warn");
		expect(widgets["lens-health"]?.[0]).toContain("warnings");
	});

	it("queues injected turn-end reports as follow-up custom messages", () => {
		const sent: any[] = [];
		const queued = queueLensContext(
			{
				sendMessage: (message: unknown, options: unknown) => {
					sent.push({ message, options });
				},
			},
			{ isIdle: () => false },
			{
				context: {
					inject: true,
					content: "Lens session diagnostics: fix this",
					fingerprint: "abc123",
					severity: "errors",
					requires_followup: true,
				},
			},
		);

		expect(queued).toBe(true);
		expect(sent).toEqual([
			{
				message: {
					customType: "lens-diagnostics",
					content: [{ type: "text", text: "Lens session diagnostics: fix this" }],
					display: true,
					details: {
						fingerprint: "abc123",
						severity: "errors",
						requiresFollowup: true,
						reportIssues: [],
					},
				},
				options: { deliverAs: "followUp", triggerTurn: true },
			},
		]);
	});

	it("stores structured issue identities on queued diagnostic reports", () => {
		const sent: any[] = [];
		const queued = queueLensContext(
			{
				sendMessage: (message: unknown, options: unknown) => {
					sent.push({ message, options });
				},
			},
			{ isIdle: () => false },
			{
				context: {
					inject: true,
					content: "Lens session diagnostics: fix this",
					fingerprint: "abc123",
				},
				data: {
					report: {
						issues: [
							{
								source: "lsp",
								path: "src/current.rs",
								line: 10,
								message: "current type error",
								code: "E0308",
								fingerprint: "issue-fingerprint",
							},
						],
					},
				},
			},
		);

		expect(queued).toBe(true);
		expect(sent[0].message.details.reportIssues).toEqual([
			{
				source: "lsp",
				path: "src/current.rs",
				line: 10,
				message: "current type error",
				code: "E0308",
				fingerprint: "issue-fingerprint",
			},
		]);
	});

	it("does not queue messages for non-injected hook responses", () => {
		const sent: any[] = [];
		const queued = queueLensContext(
			{
				sendMessage: (message: unknown, options: unknown) => {
					sent.push({ message, options });
				},
			},
			{ isIdle: () => false },
			{ context: { inject: false, content: "clean" } },
		);

		expect(queued).toBe(false);
		expect(sent).toEqual([]);
	});

	it("does not queue the same injected report repeatedly", () => {
		const sent: any[] = [];
		const state = {};
		const pi = {
			sendMessage: (message: unknown, options: unknown) => {
				sent.push({ message, options });
			},
		};
		const ctx = { isIdle: () => false };
		const response = { context: { inject: true, content: "Lens session diagnostics: same issue" } };

		expect(queueLensContext(pi, ctx, response, state)).toBe(true);
		expect(queueLensContext(pi, ctx, response, state)).toBe(false);
		expect(sent).toHaveLength(1);
	});

	it("suppresses stale queued diagnostic custom messages once diagnostics are clean", async () => {
		const result = await suppressStaleLensDiagnosticMessage(
			{
				role: "custom",
				customType: "lens-diagnostics",
				content: "Lens session diagnostics: stale",
				display: true,
				details: { fingerprint: "old" },
				timestamp: Date.now(),
			},
			"/tmp",
			{
				runner: async () => ({
					stdout: JSON.stringify({ data: { diagnostic_count: 0, diagnostics: [] } }),
					stderr: "",
					exitCode: 0,
				}),
			},
		);

		expect(result?.message.content).toEqual([]);
		expect(result?.message.display).toBe(false);
		expect(result?.message.details.suppressedAsStale).toBe(true);
	});

	it("suppresses stale queued diagnostic reports when only unrelated diagnostics remain", async () => {
		const result = await suppressStaleLensDiagnosticMessage(
			{
				role: "custom",
				customType: "lens-diagnostics",
				content: [
					{
						type: "text",
						text: [
							"Lens session diagnostics: 1 issue(s) across 1 edited file(s)",
							"- lsp/error src/old.rs:10 [E0308]: old type error",
						].join("\n"),
					},
				],
				display: true,
				details: {
					fingerprint: "old",
					reportIssues: [
						{
							source: "lsp",
							path: "src/old.rs",
							line: 10,
							code: "E0308",
							message: "old type error",
							fingerprint: "old-issue",
						},
					],
				},
				timestamp: Date.now(),
			},
			"/tmp",
			{
				runner: async () => ({
					stdout: JSON.stringify({
						data: {
							diagnostic_count: 1,
							diagnostics: [
								{
									source: "lsp",
									rel_path: "src/other.rs",
									code: "unused",
									message: "unrelated warning",
								},
							],
						},
					}),
					stderr: "",
					exitCode: 0,
				}),
			},
		);

		expect(result?.message.content).toEqual([]);
		expect(result?.message.details.suppressedAsStale).toBe(true);
	});

	it("keeps queued diagnostic reports when a listed issue is still active", async () => {
		const result = await suppressStaleLensDiagnosticMessage(
			{
				role: "custom",
				customType: "lens-diagnostics",
				content: "Lens session diagnostics: 1 issue(s)\n- lsp/error src/current.rs:10 [E0308]: current type error",
				display: true,
				details: {
					fingerprint: "current",
					reportIssues: [
						{
							source: "lsp",
							path: "src/current.rs",
							line: 10,
							code: "E0308",
							message: "current type error",
							fingerprint: "current-issue",
						},
					],
				},
				timestamp: Date.now(),
			},
			"/tmp",
			{
				runner: async () => ({
					stdout: JSON.stringify({
						data: {
							diagnostic_count: 1,
							diagnostics: [
								{
									source: "lsp",
									rel_path: "src/current.rs",
									start_line: 10,
									code: "E0308",
									message: "current type error",
									fingerprint: "current-issue",
								},
							],
						},
					}),
					stderr: "",
					exitCode: 0,
				}),
			},
		);

		expect(result).toBeUndefined();
	});
});
