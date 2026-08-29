import { describe, expect, test } from "bun:test";
import { ensureXSettingsRegistry } from "pi-xsettings";
import { DEFAULT_EXEC_COMMAND_SETTINGS, registerExecCommandXSettings } from "../src/contributions/xsettings.ts";
import { createExecRuntime } from "../src/extension.ts";
import { DEFAULT_EXEC_SHELL } from "../src/runtime-shell.ts";
import type { ExecSessionManager, UnifiedExecResult } from "../src/session-manager.ts";
import { createExecCommandTool } from "../src/tools/exec-command/definition.ts";
import { createWriteStdinTool } from "../src/tools/write-stdin/definition.ts";

function result(overrides: Partial<UnifiedExecResult> = {}): UnifiedExecResult {
	return {
		chunk_id: "abc123",
		wall_time_seconds: 0.01,
		output: "ok",
		output_truncated: false,
		exit_code: 0,
		...overrides,
	};
}

describe("tool behavior", () => {
	test("registers an inherited Exec Command marker override with every shared marker choice", () => {
		const unregister = registerExecCommandXSettings();
		try {
			const definition = ensureXSettingsRegistry().registrations["pi-exec-command"]?.definitions.find(
				(candidate) => candidate.key === "activityIndicator",
			);
			expect(DEFAULT_EXEC_COMMAND_SETTINGS.activityIndicator).toBe("inherit");
			expect(definition).toMatchObject({
				category: "appearance",
				page: "animations",
				section: "Exec Command",
				preview: "activity-marker",
				type: "enum",
				default: "inherit",
			});
			if (definition?.type !== "enum" || !Array.isArray(definition.options))
				throw new Error("Exec Command activity marker must be an enum");
			expect(definition.options.map((option) => option.value)).toEqual(
				expect.arrayContaining(["inherit", "off", "spinner", "nerd-pi-orbit"]),
			);
			const widgetDefinition = ensureXSettingsRegistry().registrations["pi-exec-command"]?.definitions.find(
				(candidate) => candidate.key === "processWidgetIndicator",
			);
			expect(DEFAULT_EXEC_COMMAND_SETTINGS.processWidgetIndicator).toBe("inherit");
			expect(widgetDefinition).toMatchObject({
				category: "appearance",
				page: "animations",
				section: "Exec Command",
				preview: "activity-marker",
				type: "enum",
				default: "inherit",
			});
			const presentation = ensureXSettingsRegistry().registrations["pi-exec-command"]?.definitions.find(
				(candidate) => candidate.key === "processHubPresentation",
			);
			expect(DEFAULT_EXEC_COMMAND_SETTINGS.processHubPresentation).toBe("side-panel");
			expect(presentation).toMatchObject({
				category: "appearance",
				page: "ui",
				section: "Exec Command",
				type: "enum",
				default: "side-panel",
			});
			if (presentation?.type !== "enum" || !Array.isArray(presentation.options))
				throw new Error("Process Hub presentation must be an enum");
			expect(presentation.options.map((option) => option.value)).toEqual(["side-panel", "fullscreen"]);
		} finally {
			unregister();
		}
	});

	test("exec_command returns the bounded manager result with command metadata", async () => {
		let observed: unknown;
		const updates: unknown[] = [];
		const manager = {
			exec: async (input: unknown, cwd: string) => {
				observed = { input, cwd };
				return result();
			},
			write: async () => result(),
			getSessionCommand: () => undefined,
			shutdown: async () => undefined,
		} satisfies ExecSessionManager;
		const tool = createExecCommandTool({ getManager: () => manager });
		const toolResult = await tool.execute("call", { cmd: "printf ok" }, undefined, (update) => updates.push(update), {
			cwd: "/work",
			isProjectTrusted: () => true,
		} as never);
		expect(observed).toEqual({
			input: expect.objectContaining({ cmd: "printf ok", shell: expect.any(String) }),
			cwd: "/work",
		});
		expect(toolResult.content[0]).toEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("Process exited with code 0") }),
		);
		expect(updates).toHaveLength(1);
		expect((updates[0] as { details: unknown }).details).toMatchObject({
			contract: "pi-exec-command/tool-presentation",
			version: 1,
			tool: "exec_command",
			phase: "partial",
			arguments: {
				kind: "exec_command",
				command: "printf ok",
				workingDirectory: "/work",
				tty: false,
				login: true,
			},
			progress: { output: "", outputChars: 0, originalTokenCount: 0, outputTruncated: false },
			identifiers: { chunkId: null, sessionId: null },
			outcome: { status: "running", exitCode: null, failure: null },
		});
		expect(toolResult.details).toMatchObject({
			contract: "pi-exec-command/tool-presentation",
			version: 1,
			tool: "exec_command",
			phase: "final",
			timing: { wallTimeSeconds: 0.01 },
			progress: { output: "ok", outputChars: 2, outputTruncated: false },
			identifiers: { chunkId: "abc123", sessionId: null },
			outcome: { status: "succeeded", exitCode: 0, failure: null },
		});
		expect(JSON.parse(JSON.stringify(toolResult.details))).toEqual(toolResult.details);
	});

	test("configured defaults are reflected in the schema and omitted arguments", async () => {
		let observed: unknown;
		const manager = {
			exec: async (input: unknown) => {
				observed = input;
				return result();
			},
			write: async () => result(),
			getSessionCommand: () => undefined,
			shutdown: async () => undefined,
		} satisfies ExecSessionManager;
		const tool = createExecCommandTool(
			{ getManager: () => manager },
			{
				defaultOutputTokens: 20_000,
				defaultExecYieldMs: 30_000,
				defaultLoginShell: false,
				activityIndicator: "inherit",
			},
		);

		await tool.execute("call", { cmd: "printf ok" }, undefined, undefined, {
			cwd: "/work",
			isProjectTrusted: () => true,
		} as never);

		const properties = (tool.parameters as { properties: Record<string, { default?: unknown; description?: string }> })
			.properties;
		expect(properties["yield_time_ms"]?.default).toBe(30_000);
		expect(properties["yield_time_ms"]?.description).toBe(
			"Wait before yielding output. Defaults to 30000 ms; effective range is 250-30000 ms.",
		);
		expect(properties["max_output_tokens"]?.default).toBe(20_000);
		expect(properties["login"]?.default).toBe(false);
		expect(properties["shell"]?.description).toBe(
			`Shell binary to launch. Defaults to Pi's configured shell, then $SHELL; Fish falls back to ${DEFAULT_EXEC_SHELL}.`,
		);
		expect(tool.description).toBe("Runs a command in a PTY, returning output or a session ID for ongoing interaction.");
		expect(observed).toMatchObject({ login: false });
	});

	test("explicit fish input is normalized before execution and presentation", async () => {
		let observed: unknown;
		const manager = {
			exec: async (input: unknown) => {
				observed = input;
				return result();
			},
			write: async () => result(),
			getSessionCommand: () => undefined,
			shutdown: async () => undefined,
		} satisfies ExecSessionManager;
		const tool = createExecCommandTool({ getManager: () => manager });

		const toolResult = await tool.execute(
			"call",
			{ cmd: "printf ok", shell: "/opt/homebrew/bin/fish" },
			undefined,
			undefined,
			{ cwd: "/work", isProjectTrusted: () => true } as never,
		);

		expect((observed as { shell: string }).shell).not.toEndWith("fish");
		expect(toolResult.details.arguments.kind).toBe("exec_command");
		if (toolResult.details.arguments.kind !== "exec_command") throw new Error("Expected exec_command arguments");
		expect(toolResult.details.arguments.shell).not.toEndWith("fish");
	});

	test("write_stdin reports the command for the selected session", async () => {
		const manager = {
			exec: async () => result(),
			write: async () => result({ session_id: 7, exit_code: undefined }),
			getSessionCommand: () => "long-task",
			getSessionTty: () => true,
			shutdown: async () => undefined,
		} satisfies ExecSessionManager;
		const tool = createWriteStdinTool({ getManager: () => manager });
		const updates: unknown[] = [];
		const toolResult = await tool.execute(
			"call",
			{ session_id: 7, chars: "sensitive\n" },
			undefined,
			(update) => updates.push(update),
			{} as never,
		);
		expect(toolResult.content[0]).toEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("Command: long-task") }),
		);
		expect(toolResult.content[0]).toEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("Session 7 still running.") }),
		);
		expect(toolResult.content[0]).not.toEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("near completion") }),
		);
		expect((updates[0] as { details: { arguments: unknown } }).details.arguments).toEqual({
			kind: "write_stdin",
			sessionId: 7,
			tty: true,
			operation: "write",
			inputBytes: 10,
			requestedYieldTimeMs: null,
			maxOutputTokens: null,
		});
		expect(JSON.stringify(toolResult.details)).not.toContain("sensitive");
		expect(toolResult.details).toMatchObject({
			tool: "write_stdin",
			phase: "final",
			command: "long-task",
			identifiers: { sessionId: 7 },
			outcome: { status: "running", exitCode: null, failure: null },
		});
	});

	test("a non-zero exit exposes a structured failure without changing model output", async () => {
		const manager = {
			exec: async () => result({ exit_code: 23, output: "bad", original_token_count: 12, output_truncated: true }),
			write: async () => result(),
			getSessionCommand: () => undefined,
			shutdown: async () => undefined,
		} satisfies ExecSessionManager;
		const tool = createExecCommandTool({ getManager: () => manager });
		const toolResult = await tool.execute("call", { cmd: "fail", shell: "/bin/sh" }, undefined, undefined, {
			cwd: "/work",
			isProjectTrusted: () => true,
		} as never);
		expect(toolResult.content[0]).toEqual(
			expect.objectContaining({ text: expect.stringContaining("Process exited with code 23") }),
		);
		expect(toolResult.details).toMatchObject({
			progress: { output: "bad", originalTokenCount: 12, outputTruncated: true },
			outcome: { status: "failed", exitCode: 23, failure: "Process exited with code 23" },
		});
	});
});

test("runtime shutdown discards the manager before a new session starts", async () => {
	let created = 0;
	let stopped = 0;
	const runtime = createExecRuntime(() => {
		created += 1;
		return {
			exec: async () => result(),
			write: async () => result(),
			getSessionCommand: () => undefined,
			shutdown: async () => {
				stopped += 1;
			},
		};
	});
	runtime.start();
	expect(created).toBe(1);
	await runtime.shutdown();
	expect(stopped).toBe(1);
	runtime.start();
	expect(created).toBe(2);
});

test("runtime shutdown coalesces callers and can own the next session afterward", async () => {
	let created = 0;
	let finishShutdown = () => {};
	const runtime = createExecRuntime(() => {
		created += 1;
		return {
			exec: async () => result(),
			write: async () => result(),
			getSessionCommand: () => undefined,
			shutdown: () =>
				new Promise<void>((resolve) => {
					finishShutdown = resolve;
				}),
		};
	});
	runtime.start();

	const first = runtime.shutdown();
	const second = runtime.shutdown();
	expect(second).toBe(first);
	finishShutdown();
	await first;

	runtime.start();
	expect(created).toBe(2);
});
