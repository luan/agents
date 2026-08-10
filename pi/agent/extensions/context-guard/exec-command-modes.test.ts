import "./setup-home";
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecCommandTracker } from "../exec-command/tools/exec-command-state.ts";
import { registerExecCommandTool } from "../exec-command/tools/exec-command-tool.ts";
import { captureExecOutput } from "./pi/capture.ts";
import { setCurrentContextGuardSessionId } from "./pi/current-session.ts";

const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
const originalProjectDir = process.env.CONTEXT_GUARD_PROJECT_DIR;
const originalPiConfigDir = process.env.PI_CONFIG_DIR;

afterEach(() => {
	if (originalCoreBin === undefined) delete process.env.CONTEXT_GUARD_BIN;
	else process.env.CONTEXT_GUARD_BIN = originalCoreBin;
	if (originalProjectDir === undefined) delete process.env.CONTEXT_GUARD_PROJECT_DIR;
	else process.env.CONTEXT_GUARD_PROJECT_DIR = originalProjectDir;
	if (originalPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalPiConfigDir;
	setCurrentContextGuardSessionId(undefined);
});

function writeCore(source: string): void {
	const dir = mkdtempSync(join(tmpdir(), "context-guard-exec-test-"));
	const coreBin = join(dir, "context-guard-core.js");
	writeFileSync(coreBin, `#!${process.execPath}\n${source}`, "utf8");
	chmodSync(coreBin, 0o755);
	process.env.CONTEXT_GUARD_BIN = coreBin;
}

function createTool(result: Record<string, unknown>, options: Record<string, unknown> = {}) {
	let tool: any;
	let receivedInput: Record<string, unknown> | undefined;
	const receivedInputs: Record<string, unknown>[] = [];
	let backgroundCapture: unknown;
	const onExec = options.onExec as ((input: Record<string, unknown>) => void | Promise<void>) | undefined;
	const resultForInput = options.resultForInput as
		| ((input: Record<string, unknown>) => Record<string, unknown>)
		| undefined;

	const sessions = {
		exec: async (input: Record<string, unknown>) => {
			receivedInput = input;
			receivedInputs.push(input);
			await onExec?.(input);
			return { ...(resultForInput?.(input) ?? result) };
		},
		write: async () => ({}),
		hasSession: () => false,
		getSessionCommand: () => undefined,
		getSessionSnapshot: () => undefined,
		listSessions: () => [],
		stopSession: () => false,
		stopAllSessions: () => 0,
		onSessionExit: () => () => {},
		onSessionUpdate: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool(
		{ registerTool: (definition: any) => (tool = definition) } as any,
		createExecCommandTracker(),
		sessions as any,
		{
			contextGuardEnabled: () => true,
			getOriginalCommand: () => "git status",
			onResult: (_params: unknown, _result: unknown, _ctx: unknown, capture: unknown) => {
				backgroundCapture = capture;
			},
			...options,
		},
	);
	return {
		tool,
		getInput: () => receivedInput,
		getInputs: () => receivedInputs,
		getBackgroundCapture: () => backgroundCapture,
	};
}

describe("exec_command Context Guard capture", () => {
	it("captures foreground output without changing execution", async () => {
		const captureLog = join(tmpdir(), `context-guard-capture-${Date.now()}.json`);
		writeCore(
			[
				"const fs = require('node:fs');",
				"let input = '';",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				`  fs.writeFileSync(${JSON.stringify(captureLog)}, JSON.stringify(request));`,
				"  const payload = { artifactId: 'artifact-1', byteCount: 42, lineCount: 2, preview: 'preview output\\n' };",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }));",
				"});",
			].join("\n"),
		);
		setCurrentContextGuardSessionId("session-a");
		const { tool } = createTool({
			chunk_id: "done",
			wall_time_seconds: 0.01,
			output: "short output\n",
			capture_output: "full output\nsecond line\n",
			terminal_state: "exited",
			exit_code: 0,
		});

		const result = await tool.execute("call-1", { cmd: "rtk git status", workdir: "subdir" }, undefined, undefined, {
			cwd: "/workspace",
		});
		const request = JSON.parse(await Bun.file(captureLog).text());
		expect(request.command).toBe("capture");
		expect(request.params.originalCommand).toBe("git status");
		expect(request.params.executedCommand).toBe("rtk git status");
		expect(request.params.projectDir).toBe("/workspace");
		expect(request.params.cwd).toBe("/workspace/subdir");
		expect(request.params.sessionId).toBe("session-a");
		expect(request.params.output).toBe("full output\nsecond line\n");
		expect(result.details.output).toBe("preview output\n");
		expect(result.details.context_guard_capture).toEqual({
			artifact_id: "artifact-1",
			byte_count: 42,
			line_count: 2,
		});
		expect(result.isError).toBe(false);
	});

	it("reports when the searchable capture omits the command tail", async () => {
		const captureLog = join(tmpdir(), `context-guard-truncated-${Date.now()}.json`);
		writeCore(
			[
				"const fs = require('node:fs');",
				"let input = '';",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				`  fs.writeFileSync(${JSON.stringify(captureLog)}, input);`,
				"  const payload = { artifactId: 'truncated-artifact', byteCount: 99, lineCount: 2, preview: 'truncated preview' };",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }));",
				"});",
			].join("\n"),
		);
		const { tool } = createTool({
			chunk_id: "done",
			wall_time_seconds: 0.01,
			output: "short output",
			capture_output: "captured prefix",
			capture_output_truncated: true,
			terminal_state: "exited",
			exit_code: 0,
		});

		const result = await tool.execute("truncated", { cmd: "printf lots" }, undefined, undefined, {
			cwd: "/workspace",
		});
		const request = JSON.parse(await Bun.file(captureLog).text());
		expect(request.params.output).toContain("capture truncated at 8 MiB");
		expect(request.params.metadata).toMatchObject({
			captureOutputTruncated: true,
			captureOutputMaxBytes: 8 * 1024 * 1024,
		});
		expect(result.details.context_guard_capture_truncated).toBe(true);
	});

	for (const { name, terminalResult, abort } of [
		{
			name: "cancelled",
			terminalResult: { terminal_state: "cancelled", cancelled: true },
			abort: true,
		},
		{
			name: "timed out",
			terminalResult: { terminal_state: "timed_out", timed_out: true },
			abort: false,
		},
	]) {
		it(`captures ${name} foreground output after execution`, async () => {
			const captureLog = join(tmpdir(), `context-guard-${name.replaceAll(" ", "-")}-${Date.now()}.json`);
			writeCore(
				[
					"const fs = require('node:fs');",
					"let input = '';",
					"process.stdin.on('data', chunk => input += chunk);",
					"process.stdin.on('end', () => {",
					`  fs.writeFileSync(${JSON.stringify(captureLog)}, input);`,
					"  const payload = { artifactId: 'terminal-artifact', byteCount: 12, lineCount: 1, preview: 'captured terminal output' };",
					"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }));",
					"});",
				].join("\n"),
			);
			const controller = abort ? new AbortController() : undefined;
			const { tool } = createTool(
				{
					chunk_id: "done",
					wall_time_seconds: 0.01,
					output: "terminal output\n",
					capture_output: "complete terminal output\n",
					...terminalResult,
				},
				{ onExec: () => controller?.abort() },
			);

			const result = await tool.execute(`call-${name}`, { cmd: "printf terminal" }, controller?.signal, undefined, {
				cwd: "/workspace",
			});
			const request = JSON.parse(await Bun.file(captureLog).text());
			expect(request.params.output).toBe("complete terminal output\n");
			expect(result.details.output).toBe("captured terminal output");
			expect(result.details.context_guard_capture?.artifact_id).toBe("terminal-artifact");
			expect(result.isError).toBe(true);
		});
	}

	it("fails open when capture fails", async () => {
		writeCore("process.exit(1);");
		const { tool } = createTool({
			chunk_id: "done",
			wall_time_seconds: 0.01,
			output: "ordinary output\n",
			terminal_state: "exited",
			exit_code: 0,
		});
		const result = await tool.execute("call-2", { cmd: "printf ok" }, undefined, undefined, { cwd: "/workspace" });
		expect(result.details.output).toBe("ordinary output\n");
		expect(result.details.context_guard_capture_failure).toContain("Context Guard core exited 1");
		expect(result.content[0]?.text).toContain("Context Guard capture failed:");
		expect(result.isError).toBe(false);
	});

	it("bypasses capture for TTY commands", async () => {
		writeCore("process.exit(2);");
		const { tool, getInput } = createTool({
			chunk_id: "done",
			wall_time_seconds: 0,
			output: "interactive\n",
			terminal_state: "exited",
			exit_code: 0,
		});
		const result = await tool.execute("call-3", { cmd: "printf ok", tty: true }, undefined, undefined, {
			cwd: "/workspace",
		});
		expect(getInput()?.tty).toBe(true);
		expect(result.details.output).toBe("interactive\n");
		expect(result.details.context_guard_capture).toBeUndefined();
	});

	it("hands background sessions to the completion capture path", async () => {
		setCurrentContextGuardSessionId("session-a");
		const { tool, getBackgroundCapture } = createTool({
			chunk_id: "running",
			wall_time_seconds: 0,
			output: "",
			process_id: 7,
		});
		const result = await tool.execute("call-4", { cmd: "rtk git status" }, undefined, undefined, {
			cwd: "/workspace",
		});
		expect(result.details.process_id).toBe(7);
		expect(getBackgroundCapture()).toEqual({
			projectDir: "/workspace",
			originalCommand: "git status",
			executedCommand: "rtk git status",
			sessionId: "session-a",
			cwd: "/workspace",
		});
	});

	it("captures a background command under its launch session after a session switch", async () => {
		const captureLog = join(tmpdir(), `context-guard-session-switch-${Date.now()}.json`);
		writeCore(
			[
				"const fs = require('node:fs');",
				"let input = '';",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				`  fs.writeFileSync(${JSON.stringify(captureLog)}, input);`,
				"  const payload = { artifactId: 'artifact-2', byteCount: 1, lineCount: 1, preview: 'done' };",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }));",
				"});",
			].join("\n"),
		);
		setCurrentContextGuardSessionId("session-a");
		const { tool, getBackgroundCapture } = createTool({
			chunk_id: "running",
			wall_time_seconds: 0,
			output: "",
			process_id: 8,
		});
		await tool.execute("call-5", { cmd: "printf done" }, undefined, undefined, { cwd: "/workspace" });
		setCurrentContextGuardSessionId("session-b");
		await captureExecOutput(getBackgroundCapture() as any, { output: "done", elapsedMs: 1 });
		const request = JSON.parse(await Bun.file(captureLog).text());
		expect(request.params.sessionId).toBe("session-a");
	});
	it("normalizes command lists and runs at fixed concurrency four", async () => {
		let active = 0;
		let maxActive = 0;
		const { tool, getInputs } = createTool(
			{},
			{
				contextGuardEnabled: () => false,
				onExec: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await Bun.sleep(20);
					active--;
				},
				resultForInput: (input: Record<string, unknown>) => ({
					chunk_id: String(input.cmd),
					wall_time_seconds: 0.02,
					output: `${input.cmd}\n`,
					terminal_state: "exited",
					exit_code: 0,
				}),
			},
		);
		const commands = Array.from({ length: 6 }, (_, index) => ({
			label: `job-${index}`,
			command: `printf ${index}`,
		}));
		const result = await tool.execute("batch", { commands }, undefined, undefined, { cwd: "/workspace" });

		expect(maxActive).toBe(4);
		expect(getInputs()).toHaveLength(6);
		expect(getInputs().every((input) => input.wait_for_exit === true)).toBe(true);
		expect(result.isError).toBe(false);
		expect(result.details.results.map((item: { command: string }) => item.command)).toEqual(
			commands.map(({ command }) => command),
		);
		expect(result.content[0].text.indexOf("job-0")).toBeLessThan(result.content[0].text.indexOf("job-5"));
		expect(result.content[0].text).toContain("## job-0\n");
		expect(result.content[0].text).not.toContain("\\n");
	});

	it("does not launch queued batch commands after cancellation", async () => {
		const controller = new AbortController();
		let started = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { tool, getInputs } = createTool(
			{},
			{
				contextGuardEnabled: () => false,
				onExec: async () => {
					started++;
					if (started === 4) {
						controller.abort();
						release();
					}
					await barrier;
				},
				resultForInput: (input: Record<string, unknown>) => ({
					chunk_id: String(input.cmd),
					wall_time_seconds: 0,
					output: `${input.cmd}\n`,
					terminal_state: "cancelled",
					cancelled: true,
				}),
			},
		);
		const commands = Array.from({ length: 8 }, (_, index) => `printf ${index}`);

		await tool.execute("cancelled-batch", { commands }, controller.signal, undefined, { cwd: "/workspace" });

		expect(getInputs()).toHaveLength(4);
	});

	it("rejects obsolete mode arguments and ignores removed capture overrides", async () => {
		const captureLog = join(tmpdir(), `context-guard-override-${Date.now()}.json`);
		writeCore(
			[
				"const fs = require('node:fs');",
				"let input = '';",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				`  fs.writeFileSync(${JSON.stringify(captureLog)}, input);`,
				"  const payload = { artifactId: 'artifact-override', byteCount: 7, lineCount: 1, preview: 'failed\\n' };",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }));",
				"});",
			].join("\n"),
		);
		const { tool } = createTool({
			chunk_id: "done",
			wall_time_seconds: 0,
			output: "failed\n",
			capture_output: "failed\n",
			terminal_state: "exited",
			exit_code: 7,
		});
		await expect(
			tool.execute("call-5", { mode: "batch", commands: ["pwd"] }, undefined, undefined, { cwd: "/workspace" }),
		).rejects.toThrow("does not accept mode, queries, or concurrency");
		const result = await tool.execute("call-6", { cmd: "false", context_guard: false }, undefined, undefined, {
			cwd: "/workspace",
		});
		expect(await Bun.file(captureLog).exists()).toBe(true);
		expect(result.isError).toBe(true);
		expect(result.details.exit_code).toBe(7);
		expect(result.details.context_guard_capture.artifact_id).toBe("artifact-override");
	});
});
