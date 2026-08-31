import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	configureTuiAppearance,
	DEFAULT_TUI_APPEARANCE,
	getTuiAppearance,
	icon,
	sharedMotionScheduler,
	whenSyntaxReady,
} from "pi-libtui";
import { DEFAULT_EXEC_COMMAND_SETTINGS } from "../src/contributions/xsettings.ts";
import type { ExecProcessSnapshot } from "../src/session-manager.ts";
import { createExecCommandTool } from "../src/tools/exec-command/definition.ts";
import { TEST_EXEC_COMMAND_PREPARATION_RUNTIME } from "./exec-command-preparation-runtime.ts";
import { normalizeExecCommandArguments, normalizeWriteStdinArguments } from "../src/tools/presentation.ts";
import { createExecToolResult } from "../src/tools/result.ts";
import { createWriteStdinTool } from "../src/tools/write-stdin/definition.ts";

const theme = {
	name: "exec-presentation-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => (token === "text" ? "\x1b[38;2;240;240;240m" : "\x1b[38;2;100;140;200m"),
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never as Theme;

afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

interface ContextOverrides {
	readonly executionStarted?: boolean;
	readonly isPartial?: boolean;
	readonly isError?: boolean;
	readonly invalidate?: () => void;
}

interface FakeMotionTimer {
	readonly callback: () => void;
	readonly cadenceMs: number;
	stopped: boolean;
	unref(): void;
}

function context(args: object, lastComponent?: object, overrides: ContextOverrides = {}) {
	return {
		args,
		toolCallId: "call-1",
		invalidate() {},
		lastComponent,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	} as never;
}

function observableRuntime() {
	let listener: ((snapshots: readonly ExecProcessSnapshot[]) => void) | undefined;
	let unsubscribeCount = 0;
	const manager = {
		subscribeProcesses(next: (snapshots: readonly ExecProcessSnapshot[]) => void) {
			listener = next;
			next([]);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				unsubscribeCount += 1;
				if (listener === next) listener = undefined;
			};
		},
	};
	return {
		runtime: { getManager: () => manager as never },
		publish(snapshots: readonly ExecProcessSnapshot[]) {
			listener?.(snapshots);
		},
		get unsubscribeCount() {
			return unsubscribeCount;
		},
	};
}

function processSnapshot(overrides: Partial<ExecProcessSnapshot> = {}): ExecProcessSnapshot {
	return {
		id: 7,
		command: "sleep 30",
		cwd: "/tmp",
		shell: "/bin/zsh",
		tty: false,
		stdinOpen: false,
		state: "running",
		startedAtMs: 1_000,
		output: "",
		outputTruncated: false,
		...overrides,
	};
}

beforeAll(async () => {
	await new Promise<void>((resolve) => whenSyntaxReady(resolve));
});

describe("exec tool presentation", () => {
	test("syntax-colors shell commands through shared Shiki without changing their source", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const source = "echo \"$HOME\" && printf '%s\\n' ok";
		const component = tool.renderCall?.(
			{ cmd: source },
			theme,
			context({ cmd: source }, undefined, { executionStarted: false, isPartial: false }),
		);
		const rendered = component?.render(120).join("\n") ?? "";
		const commandStart = rendered.indexOf("$");
		const commandAnsi = commandStart >= 0 ? rendered.slice(commandStart + 1) : "";
		const foregroundSpans = commandAnsi.match(/\x1b\[38;[^m]*m/gu) ?? [];

		expect(Bun.stripANSI(rendered)).toBe(`$ ${source}`);
		expect(new Set(foregroundSpans).size).toBeGreaterThan(1);
		expect(Bun.stripANSI(commandAnsi)).toBe(` ${source}`);
	});

	test("uses the configured shell language and keeps unsupported shells on the POSIX fallback", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const source = "set -l value 1";
		const renderForShell = (shell: string) => {
			const args = { cmd: source, tty: false };
			const result = createExecToolResult({
				tool: "exec_command",
				phase: "final",
				arguments: normalizeExecCommandArguments(args, "/tmp", shell),
				command: source,
				result: {
					chunk_id: `shell-${shell}`,
					output: "",
					exit_code: 0,
					wall_time_seconds: 0,
					output_truncated: false,
				},
			});
			const component = tool.renderResult?.(
				result,
				{ expanded: false, isPartial: false },
				theme,
				context(args, undefined, { isPartial: false }),
			);
			return component?.render(120).join("\n") ?? "";
		};

		const zsh = renderForShell("/bin/zsh");
		const bash = renderForShell("/bin/bash");
		const fish = renderForShell("/bin/fish");
		const unsupported = renderForShell("/bin/unsupported");

		expect(bash).toBe(zsh);
		expect(fish).not.toBe(zsh);
		expect(unsupported).toBe(zsh);
	});

	test("falls back compactly for malformed restored presentation details", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "pwd", tty: false };
		const valid = createExecToolResult({
			tool: "exec_command",
			phase: "final",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
			result: {
				chunk_id: "restored",
				output: "/tmp\n",
				exit_code: 0,
				wall_time_seconds: 0.1,
				output_truncated: false,
			},
		});
		for (const details of [
			{ ...valid.details, timing: undefined },
			{ ...valid.details, progress: { ...valid.details.progress, output: 42 } },
		]) {
			const malformed = { ...valid, details } as never;
			const component = tool.renderResult?.(
				malformed,
				{ expanded: false, isPartial: false },
				theme,
				context(args, undefined, { isPartial: false }),
			);
			const rendered = Bun.stripANSI(component?.render(72).join("\n") ?? "");
			expect(rendered).toBe("$ pwd ›");
			expect(rendered).not.toContain("[object Object]");
		}
	});

	test("does not invent a shell command when restored details contain no command", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const result = createExecToolResult({
			tool: "exec_command",
			phase: "final",
			arguments: normalizeExecCommandArguments({ cmd: "pwd", tty: false }, "/tmp", "/bin/zsh"),
			command: "pwd",
			result: {
				chunk_id: "missing-command",
				output: "output",
				exit_code: 1,
				wall_time_seconds: 0.1,
				output_truncated: false,
			},
		});
		const malformed = { ...result, details: { timing: undefined, command: undefined, arguments: undefined } } as never;
		const component = tool.renderResult?.(
			malformed,
			{ expanded: false, isPartial: false },
			theme,
			context(undefined as never, undefined, { isPartial: false, isError: true }),
		);
		const rendered = Bun.stripANSI(component?.render(72).join("\n") ?? "");
		expect(rendered).not.toContain("$ command");
		expect(rendered).toContain(`${icon("error")} Command failed`);
	});

	test("moves from a compact command preview to a reused streamed result surface", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "bun test --only-failures", tty: false };
		const call = tool.renderCall?.(args, theme, context(args, undefined, { executionStarted: false }));
		expect(Bun.stripANSI(call?.render(72).join("\n") ?? "")).toContain("bun test --only-failures");

		const normalized = normalizeExecCommandArguments(args, "/tmp", "/bin/zsh");
		const partial = createExecToolResult({
			tool: "exec_command",
			phase: "partial",
			arguments: normalized,
			command: args.cmd,
		});
		const active = tool.renderResult?.(partial, { expanded: false, isPartial: true }, theme, context(args));
		expect(Bun.stripANSI(active?.render(72).join("\n") ?? "")).toContain("$ bun test --only-failures");

		const final = createExecToolResult({
			tool: "exec_command",
			phase: "final",
			arguments: normalized,
			command: args.cmd,
			result: {
				chunk_id: "abc",
				wall_time_seconds: 1.25,
				output: "172 pass\n0 fail\n",
				exit_code: 0,
				original_token_count: 8,
				output_truncated: false,
			},
		});
		const completed = tool.renderResult?.(
			final,
			{ expanded: false, isPartial: false },
			theme,
			context(args, active, { isPartial: false }),
		);
		expect(completed).toBe(active);
		const rendered = Bun.stripANSI(completed?.render(72).join("\n") ?? "");
		expect(rendered).toContain("$ bun test --only-failures");
		expect(rendered).not.toContain("Ran command");
		expect(rendered).toContain("172 pass");
		expect(rendered).toContain("1.3s");
		expect(rendered).not.toMatch(/[╭╮╰╯│├┤]/u);
		expect(rendered).not.toContain("Output");
	});

	test("animates a live partial presentation through shared motion and disposes cleanly", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "sleep 1", tty: false };
		const partial = createExecToolResult({
			tool: "exec_command",
			phase: "partial",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
		});
		const mountsBefore = sharedMotionScheduler.activeMountCount;
		const timersBefore = sharedMotionScheduler.activeTimerCount;
		const timers: FakeMotionTimer[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const originalPerformanceNow = performance.now;
		let nowMs = 0;

		globalThis.setTimeout = ((callback: TimerHandler, cadenceMs?: number) => {
			if (typeof callback !== "function") throw new TypeError("motion timer callback must be callable");
			const timer: FakeMotionTimer = {
				callback: callback as () => void,
				cadenceMs: cadenceMs ?? 0,
				stopped: false,
				unref() {},
			};
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		}) as unknown as typeof setTimeout;
		globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
			(handle as unknown as FakeMotionTimer).stopped = true;
		}) as typeof clearTimeout;
		performance.now = () => nowMs;

		try {
			let invalidations = 0;
			const active = tool.renderResult?.(
				partial,
				{ expanded: false, isPartial: true },
				theme,
				context(args, undefined, { invalidate: () => invalidations++ }),
			) as unknown as { render(width: number): string[]; dispose(): void };

			expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore + 1);
			expect(sharedMotionScheduler.activeTimerCount).toBe(timersBefore + 1);
			expect(timers).toHaveLength(1);
			expect(timers[0]?.cadenceMs).toBe(80);
			expect(Bun.stripANSI(active.render(72).join("\n"))).toContain("⠋ $ sleep 1");

			nowMs = 80;
			timers[0]!.callback();
			expect(invalidations).toBe(1);
			expect(Bun.stripANSI(active.render(72).join("\n"))).toContain("⠙ $ sleep 1");

			active.dispose();
			expect(timers.at(-1)!.stopped).toBe(true);
			expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);
			expect(sharedMotionScheduler.activeTimerCount).toBe(timersBefore);
			active.dispose();
			expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
			performance.now = originalPerformanceNow;
		}
	});

	test("switches a running command to the configured activity animation", () => {
		configureTuiAppearance({ activityIndicator: "static", textEffect: "off" });
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "sleep 1", tty: false };
		const partial = createExecToolResult({
			tool: "exec_command",
			phase: "partial",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
		});
		const active = tool.renderResult?.(
			partial,
			{ expanded: false, isPartial: true },
			theme,
			context(args),
		) as unknown as { render(width: number): string[]; dispose(): void };

		expect(Bun.stripANSI(active.render(72).join("\n"))).toContain("● $ sleep 1");
		configureTuiAppearance({ activityIndicator: "off", textEffect: "glow" });
		expect(Bun.stripANSI(active.render(72).join("\n"))).toContain("$ sleep 1");
		expect(Bun.stripANSI(active.render(72).join("\n"))).not.toContain("◆");
		configureTuiAppearance({ activityIndicator: "static", pulseEffect: "color" });
		expect(Bun.stripANSI(active.render(72).join("\n"))).toContain("● $ sleep 1");
		active.dispose();
	});

	test("lets exec_command disable its marker without changing the shared default", () => {
		configureTuiAppearance({ activityIndicator: "spinner", textEffect: "off" });
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME, {
			...DEFAULT_EXEC_COMMAND_SETTINGS,
			activityIndicator: "off",
		});
		const args = { cmd: "sleep 1", tty: false };
		const partial = createExecToolResult({
			tool: "exec_command",
			phase: "partial",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
		});
		const timersBefore = sharedMotionScheduler.activeTimerCount;
		const active = tool.renderResult?.(
			partial,
			{ expanded: false, isPartial: true },
			theme,
			context(args),
		) as unknown as { render(width: number): string[]; dispose(): void };

		expect(Bun.stripANSI(active.render(72).join("\n"))).toContain("$ sleep 1");
		expect(Bun.stripANSI(active.render(72).join("\n"))).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \$/u);
		expect(sharedMotionScheduler.activeTimerCount).toBe(timersBefore);
		expect(getTuiAppearance().activityIndicator).toBe("spinner");
		active.dispose();
	});

	test("opens long output from its omission row and keeps expanded scrolling bounded", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "long-output", tty: false };
		const result = createExecToolResult({
			tool: "exec_command",
			phase: "final",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
			result: {
				chunk_id: "long-output",
				wall_time_seconds: 0.1,
				output: Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"),
				exit_code: 0,
				output_truncated: false,
			},
		});
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			theme,
			context(args, undefined, { isPartial: false }),
		) as unknown as {
			render(width: number): string[];
			onMouse(event: object): boolean;
		};
		const compact = component.render(80);
		const compactText = compact.map((line) => Bun.stripANSI(line));
		const omissionRow = compactText.findIndex((line) => line.includes("rows omitted"));
		expect(omissionRow).toBe(1);
		expect(compactText.join("\n")).not.toContain("line 0");
		expect(compactText.join("\n")).toContain("line 49");

		const event = {
			type: "press" as const,
			row: omissionRow,
			col: 2,
			screenRow: omissionRow,
			screenCol: 2,
			button: 0 as const,
			wheel: undefined,
			shift: false as const,
			alt: false as const,
			ctrl: false as const,
		};
		expect(component.onMouse(event)).toBe(true);
		expect(component.onMouse({ ...event, type: "release" })).toBe(true);

		const expanded = component.render(80);
		expect(expanded.length).toBeGreaterThan(compact.length);
		expect(expanded.length).toBeLessThanOrEqual(22);
		expect(Bun.stripANSI(expanded[0]!)).toContain("⌄");
		expect(Bun.stripANSI(expanded.join("\n"))).toContain("line 0");
		expect(Bun.stripANSI(expanded.join("\n"))).not.toContain("rows omitted");

		for (let index = 0; index < 20; index += 1)
			component.onMouse({ ...event, type: "wheel", button: undefined, wheel: 1 });
		const scrolled = Bun.stripANSI(component.render(80).join("\n"));
		expect(scrolled).toContain("line 49");
		expect(component.render(80).length).toBe(expanded.length);
	});

	test("does not render write_stdin output as a separate transcript block", () => {
		const tool = createWriteStdinTool({} as never);
		const input = { session_id: 7 };
		const result = createExecToolResult({
			tool: "write_stdin",
			phase: "final",
			arguments: normalizeWriteStdinArguments(input, false),
			command: "long-output",
			result: {
				chunk_id: "long-output",
				wall_time_seconds: 0.1,
				output: Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"),
				session_id: 7,
				output_truncated: false,
			},
		});
		const rendered = tool
			.renderResult?.(
				result,
				{ expanded: false, isPartial: false },
				theme,
				context(input, undefined, { isPartial: false }),
			)
			.render(80)
			.map((line) => Bun.stripANSI(line));

		expect(rendered).toEqual([]);
	});

	test("keeps partial and final write_stdin results transcript-silent", () => {
		const tool = createWriteStdinTool({} as never);
		const input = { session_id: 7 };
		const arguments_ = normalizeWriteStdinArguments(input, false);
		const partial = createExecToolResult({
			tool: "write_stdin",
			phase: "partial",
			arguments: arguments_,
			command: "streaming-command",
			result: {
				chunk_id: "partial",
				wall_time_seconds: 0.1,
				output: "old",
				session_id: 7,
				output_truncated: false,
			},
		});
		const active = tool.renderResult?.(
			partial,
			{ expanded: false, isPartial: true },
			theme,
			context(input, undefined, { isPartial: true }),
		);
		expect(active?.render(72)).toEqual([]);

		const final = createExecToolResult({
			tool: "write_stdin",
			phase: "final",
			arguments: arguments_,
			command: "streaming-command",
			result: {
				chunk_id: "final",
				wall_time_seconds: 0.2,
				output: "new",
				session_id: 7,
				output_truncated: false,
			},
		});
		const completed = tool.renderResult?.(
			final,
			{ expanded: false, isPartial: false },
			theme,
			context(input, active, { isPartial: false }),
		);
		expect(completed?.render(72)).toEqual([]);
	});

	test("does not disclose a second failure view when shell output already explains it", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "cat missing", tty: false };
		const result = createExecToolResult({
			tool: "exec_command",
			phase: "final",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
			result: {
				chunk_id: "failed",
				wall_time_seconds: 0.1,
				output: "cat: missing: No such file or directory\n",
				exit_code: 1,
				output_truncated: false,
			},
		});
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			theme,
			context(args, undefined, { isPartial: false, isError: true }),
		) as unknown as {
			render(width: number): string[];
			children: Array<{ onMouse?(event: object): boolean }>;
		};
		const before = component.render(72);
		const pointer = {
			type: "press",
			row: 0,
			col: 4,
			screenRow: 0,
			screenCol: 4,
			button: 0,
			wheel: undefined,
			shift: false,
			alt: false,
			ctrl: false,
		};
		expect(component.children[0]?.onMouse?.(pointer)).toBe(false);
		expect(component.render(72)).toEqual(before);
		expect(Bun.stripANSI(before.join("\n"))).toContain("cat: missing: No such file or directory");
	});

	test("projects TTY rewrites instead of printing terminal controls", async () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "progress", tty: true };
		const details = createExecToolResult({
			tool: "exec_command",
			phase: "final",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
			result: {
				chunk_id: "tty",
				wall_time_seconds: 0.1,
				output: "progress 10%\rprogress 100%\n",
				exit_code: 0,
				output_truncated: false,
			},
		});
		let parsed: (() => void) | undefined;
		let invalidations = 0;
		const parsedPromise = new Promise<void>((resolve) => {
			parsed = resolve;
		});
		const component = tool.renderResult?.(
			details,
			{ expanded: false, isPartial: false },
			theme,
			context(args, undefined, {
				isPartial: false,
				invalidate: () => {
					invalidations++;
					if (invalidations >= 1) parsed?.();
				},
			}),
		);
		await parsedPromise;
		const rendered = component?.render(60).join("\n") ?? "";

		expect(rendered).toContain("progress 100%");
		expect(rendered).not.toContain("progress 10%");
	});

	test("preserves a TTY emulator when partial output becomes a truncated cumulative tail", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "progress", tty: true };
		const arguments_ = normalizeExecCommandArguments(args, "/tmp", "/bin/zsh");
		const cumulative = `\x1b[31m${"red ".repeat(80)}`;
		const first = createExecToolResult({
			tool: "exec_command",
			phase: "partial",
			arguments: arguments_,
			command: args.cmd,
			result: {
				chunk_id: "first",
				wall_time_seconds: 0.1,
				output: cumulative,
				session_id: 7,
				output_truncated: false,
			},
		});
		const active = tool.renderResult?.(first, { expanded: false, isPartial: true }, theme, context(args));
		const tail = createExecToolResult({
			tool: "exec_command",
			phase: "partial",
			arguments: arguments_,
			command: args.cmd,
			result: {
				chunk_id: "tail",
				wall_time_seconds: 0.2,
				output: cumulative.slice(-100),
				session_id: 7,
				output_truncated: true,
			},
		});
		const updated = tool.renderResult?.(tail, { expanded: false, isPartial: true }, theme, context(args, active));

		expect(updated).toBe(active);
		expect(updated?.render(60).join("\n")).toContain("31m");
	});

	test("replaces a truncated pipe tail when its bounded window advances", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "stream", tty: false };
		const arguments_ = normalizeExecCommandArguments(args, "/tmp", "/bin/zsh");
		const partial = (chunkId: string, output: string) =>
			createExecToolResult({
				tool: "exec_command",
				phase: "partial",
				arguments: arguments_,
				command: args.cmd,
				result: {
					chunk_id: chunkId,
					wall_time_seconds: 0.1,
					output,
					session_id: 7,
					output_truncated: true,
				},
			});
		const active = tool.renderResult?.(
			partial("first", "old-tail-output"),
			{ expanded: false, isPartial: true },
			theme,
			context(args),
		);
		const updated = tool.renderResult?.(
			partial("second", "new-tail-output"),
			{ expanded: false, isPartial: true },
			theme,
			context(args, active),
		);

		expect(updated).toBe(active);
		const rendered = Bun.stripANSI(updated?.render(60).join("\n") ?? "");
		expect(rendered).toContain("new-tail-output");
		expect(rendered).not.toContain("old-tail-output");
	});

	test("keeps write_stdin calls and results transcript-silent", () => {
		const tool = createWriteStdinTool({} as never);
		const poll = { session_id: 7 };
		expect(
			tool
				.renderCall?.(poll, theme, context(poll, undefined, { executionStarted: false }))
				.render(60)
				.join("\n"),
		).toBe("");

		const input = { session_id: 7, chars: "yes\n" };
		const details = createExecToolResult({
			tool: "write_stdin",
			phase: "final",
			arguments: normalizeWriteStdinArguments(input, false),
			command: "dangerous prompt",
			result: {
				chunk_id: "def",
				wall_time_seconds: 0.05,
				output: "accepted\n",
				session_id: 7,
				output_truncated: false,
			},
		});
		const rendered = Bun.stripANSI(
			tool
				.renderResult?.(
					details,
					{ expanded: false, isPartial: false },
					theme,
					context(input, undefined, { isPartial: false }),
				)
				.render(60)
				.join("\n") ?? "",
		);
		expect(rendered).toBe("");
	});

	test("keeps a yielded command animated until its continuation completes", () => {
		const processes = observableRuntime();
		const tool = createExecCommandTool(processes.runtime, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "sleep 30", tty: false };
		const final = createExecToolResult({
			tool: "exec_command",
			phase: "final",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
			result: {
				chunk_id: "yielded",
				output: "",
				session_id: 7,
				wall_time_seconds: 0.1,
				output_truncated: false,
			},
		});
		const before = sharedMotionScheduler.activeMountCount;
		const component = tool.renderResult?.(
			final,
			{ expanded: false, isPartial: false },
			theme,
			context(args, undefined, { executionStarted: true, isPartial: false }),
		);
		expect(sharedMotionScheduler.activeMountCount).toBe(before + 1);
		expect(Bun.stripANSI(component?.render(60).join("\n") ?? "")).toContain("$ sleep 30");

		const poll = { session_id: 7 };
		const completed = createExecToolResult({
			tool: "write_stdin",
			phase: "final",
			arguments: normalizeWriteStdinArguments(poll, false),
			command: args.cmd,
			result: {
				chunk_id: "completed",
				output: "done\n",
				exit_code: 0,
				wall_time_seconds: 30,
				output_truncated: false,
			},
		});
		const settled = createWriteStdinTool({} as never).renderResult?.(
			completed,
			{ expanded: false, isPartial: false },
			theme,
			context(poll, component, { executionStarted: true, isPartial: false }),
		);

		expect(settled).toBe(component);
		expect(sharedMotionScheduler.activeMountCount).toBe(before);
		expect(Bun.stripANSI(settled?.render(60).join("\n") ?? "")).toContain("done");
		expect(processes.unsubscribeCount).toBe(1);
	});

	test("settles a background transcript when the process exits without a continuation", () => {
		const processes = observableRuntime();
		const tool = createExecCommandTool(processes.runtime, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "sleep 30", tty: false };
		const yielded = createExecToolResult({
			tool: "exec_command",
			phase: "final",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
			result: {
				chunk_id: "yielded",
				output: "",
				session_id: 7,
				wall_time_seconds: 0.1,
				output_truncated: false,
			},
		});
		let invalidations = 0;
		const before = sharedMotionScheduler.activeMountCount;
		const component = tool.renderResult?.(
			yielded,
			{ expanded: false, isPartial: false },
			theme,
			context(args, undefined, { executionStarted: true, isPartial: false, invalidate: () => invalidations++ }),
		);
		expect(sharedMotionScheduler.activeMountCount).toBe(before + 1);

		processes.publish([processSnapshot({ output: "started\n" })]);
		expect(Bun.stripANSI(component?.render(60).join("\n") ?? "")).toContain("started");
		processes.publish([
			processSnapshot({
				state: "exited",
				exitCode: 0,
				finishedAtMs: 31_000,
				output: "finished\n",
			}),
		]);

		const rendered = Bun.stripANSI(component?.render(60).join("\n") ?? "");
		expect(rendered).toContain("$ sleep 30");
		expect(rendered).toContain("finished");
		expect(rendered).not.toContain("started");
		expect(sharedMotionScheduler.activeMountCount).toBe(before);
		expect(processes.unsubscribeCount).toBe(1);
		expect(invalidations).toBe(2);
	});

	test("keeps TTY write_stdin results transcript-silent", () => {
		const tool = createWriteStdinTool({} as never);
		const input = { session_id: 7 };
		const details = createExecToolResult({
			tool: "write_stdin",
			phase: "final",
			arguments: normalizeWriteStdinArguments(input, true),
			command: "progress",
			result: {
				chunk_id: "tty-poll",
				wall_time_seconds: 0.1,
				output: "\x1b]52;c;Y2xpcGJvYXJk\x07progress 10%\rprogress 100%\n",
				session_id: 7,
				output_truncated: false,
			},
		});
		const component = tool.renderResult?.(
			details,
			{ expanded: false, isPartial: false },
			theme,
			context(input, undefined, { isPartial: false }),
		);
		expect(component?.render(60)).toEqual([]);
	});

	test("keeps replayed partial results static", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "long-running-task" };
		const details = createExecToolResult({
			tool: "exec_command",
			phase: "partial",
			arguments: normalizeExecCommandArguments(args, "/tmp", "/bin/zsh"),
			command: args.cmd,
		});
		const mountsBefore = sharedMotionScheduler.activeMountCount;
		const replayed = tool.renderResult?.(
			details,
			{ expanded: false, isPartial: true },
			theme,
			context(args, undefined, { executionStarted: false }),
		);
		const rendered = replayed?.render(60).join("\n") ?? "";

		expect(Bun.stripANSI(rendered)).toContain("$ long-running-task");
		expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);
	});

	test("renders missing persisted details as a compact failure instead of raw JSON", () => {
		const tool = createExecCommandTool({} as never, TEST_EXEC_COMMAND_PREPARATION_RUNTIME);
		const args = { cmd: "broken-command" };
		const component = tool.renderResult?.(
			{ content: [{ type: "text", text: "spawn failed" }], details: undefined as never },
			{ expanded: false, isPartial: false },
			theme,
			context(args, undefined, { executionStarted: false, isPartial: false, isError: true }),
		);
		const rendered = Bun.stripANSI(component?.render(60).join("\n") ?? "");
		expect(rendered).toBe("$ broken-command ›");
		expect(rendered).not.toContain("details");
	});
});
