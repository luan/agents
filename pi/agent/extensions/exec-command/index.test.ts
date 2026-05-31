import { beforeAll, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashExecutionComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { markExecCommandContextGuardEnabled, resetExecCommandContextGuardEnabled } from "../context-guard/pi/index.ts";
import { DEFAULT_EXEC_SHELL, resolveRuntimeShell } from "./adapter/runtime-shell.ts";
import execCommandExtension from "./index.ts";
import type { ShellAction } from "./shell/summary.ts";
import {
	type RenderOutputBlockOptions,
	type RenderTheme,
	rawCommandToExecCell,
	renderBackgroundTerminalHud,
	renderExecCell,
	renderExecCellComponent,
} from "./tools/exec-cell-presentation.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import { computeRtkRewriteDecision, parseRtkExecutablePath } from "./tools/rtk-wrapper.ts";
import { formatUnifiedExecResult } from "./tools/unified-exec-format.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";
import { BackgroundTerminalOverlay } from "./ui/background-terminal-overlay.ts";

const testTheme: RenderTheme = {
	fg: (role, text) => `<${role}>${text}</${role}>`,
	bold: (text) => `<bold>${text}</bold>`,
};

const rgbTestTheme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
	getFgAnsi: (role: string) => (role === "accent" ? "\x1b[38;2;100;120;200m" : "\x1b[38;2;255;255;255m"),
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeAll(() => {
	initTheme("dark");
});

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function processList(): string {
	return execSync("ps -axo pid,ppid,pgid,stat,command", { encoding: "utf8" });
}

async function waitForProcessListToExclude(marker: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (!processList().includes(marker)) return;
		await Bun.sleep(100);
	}
	expect(processList()).not.toContain(marker);
}

async function waitForCondition(condition: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(50);
	}
	expect(condition()).toBe(true);
}

function renderExecCommandCall(
	command: string,
	state: "running" | "done",
	theme: RenderTheme,
	failed = false,
	elapsedMs?: number,
	rtkWrapped = false,
	contextGuardWrapped = false,
): string {
	return renderExecCell(
		rawCommandToExecCell({ command, status: state, failed, elapsedMs, rtkWrapped, contextGuardWrapped }),
		{
			theme,
			part: "header",
		},
	);
}

function renderGroupedExecCommandCall(
	actionGroups: ShellAction[][],
	state: "running" | "done",
	theme: RenderTheme,
	failed = false,
	elapsedMs?: number,
	rtkWrapped = false,
): string {
	return renderExecCell(
		{ kind: "exploration", status: state, actionGroups, failed, elapsedMs, rtkWrapped },
		{ theme, part: "header" },
	);
}

function renderOutputBlock(
	output: string,
	theme: Pick<RenderTheme, "fg">,
	footer?: string,
	options: RenderOutputBlockOptions = {},
): string {
	return renderExecCell(
		{
			kind: "command",
			status: "done",
			outputBlock: { output, footer, options },
		},
		{ theme: theme as RenderTheme, part: "output", expanded: options.expanded, width: options.width },
	);
}

function renderSpawnedBackgroundTerminalCall(command: string, theme: RenderTheme, rtkWrapped = false): string {
	return renderExecCell(
		{ kind: "spawned-background-terminal", status: "done", command, rtkWrapped },
		{ theme, part: "header" },
	);
}

function renderWriteStdinCall(
	sessionId: number | string,
	input: string | undefined,
	command: string | undefined,
	theme: RenderTheme,
	state: "running" | "done" = "done",
	failed = false,
	elapsedMs?: number,
	stdinOpen?: boolean,
): string {
	return renderExecCell(
		{
			kind: "write-stdin",
			status: state,
			command,
			failed,
			elapsedMs,
			writeStdin: { sessionId, input, stdinOpen },
		},
		{ theme, part: "header" },
	);
}

function renderBackgroundTerminalHudLine(
	command: string | undefined,
	output: string,
	theme: RenderTheme,
	elapsedMs: number,
	width = 120,
	stdinOpen?: boolean,
): string {
	return renderBackgroundTerminalHud({ command, output, elapsedMs, stdinOpen }, { theme, width });
}

async function runExecCommandCompletionScenario(command: string, toolCallId: string) {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	let renderer: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer: (_customType: string, registered: any) => {
			renderer = registered;
		},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const result = await execTool.execute(
			toolCallId,
			{ cmd: command, yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.session_id).toBeNumber();
		await Bun.sleep(500);
		return { result, sentMessages, renderer };
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
}

test("exec command call renders inline syntax-highlighted commands", () => {
	const rendered = renderExecCommandCall(
		`git diff --stat luan/pbt...luan/pbt-fixes && gh pr edit 57220 --title "fix(sync): resolve PBT convergence failures"`,
		"done",
		testTheme,
	);
	expect(
		rendered.startsWith(
			`<success>•</success> <bold>Ran</bold> <syntaxFunction>git</syntaxFunction> diff <syntaxKeyword>--stat</syntaxKeyword>`,
		),
	).toBe(true);
	expect(rendered).toContain(
		`<syntaxOperator>&&</syntaxOperator> <syntaxFunction>gh</syntaxFunction> pr edit 57220 <syntaxKeyword>--title</syntaxKeyword> <syntaxString>"fix(sync): resolve PBT convergence failures"</syntaxString>`,
	);
	expect(rendered).not.toContain("\n<dim>  └ ");
});

test("exec cell facade renders raw command cells with RTK presentation metadata", () => {
	const cell = rawCommandToExecCell({
		command: "cargo test",
		status: "done",
		rtkWrapped: true,
	});
	const rendered = renderExecCell(cell, { theme: testTheme, part: "header" });

	expect(rendered).toBe(renderExecCommandCall("cargo test", "done", testTheme, false, undefined, true));
});

test("exec cell facade renders raw command cells with Context Guard presentation metadata", () => {
	const cell = rawCommandToExecCell({
		command: "cargo test",
		status: "done",
		contextGuardWrapped: true,
	});
	const rendered = renderExecCell(cell, { theme: testTheme, part: "header" });

	expect(rendered).toBe(renderExecCommandCall("cargo test", "done", testTheme, false, undefined, false, true));
});

test("exec cell facade renders exploration rows from an explicit cell model", () => {
	const rendered = renderExecCell(
		{
			kind: "exploration",
			status: "done",
			actionGroups: [[{ kind: "search", command: "rg Parser", query: "Parser", path: "src" }]],
		},
		{ theme: testTheme, part: "header" },
	);

	expect(rendered).toBe(
		renderGroupedExecCommandCall(
			[[{ kind: "search", command: "rg Parser", query: "Parser", path: "src" }]],
			"done",
			testTheme,
		),
	);
});

test("exec cell facade renders combined command header and output block", () => {
	const rendered = renderExecCell(
		{
			kind: "command",
			status: "done",
			command: "printf ok",
			outputBlock: { output: "ok" },
		},
		{ theme: testTheme },
	);

	expect(rendered).toBe(
		`${renderExecCommandCall("printf ok", "done", testTheme)}\n${renderOutputBlock("ok", testTheme)}`,
	);
});

test("exec cell facade renders output components with caller width", () => {
	const component = renderExecCellComponent(
		{
			kind: "command",
			status: "done",
			command: "printf ok",
			outputBlock: {
				output: "https://example.test/api/v1/projects/alpha-team/releases/2026-02-17/builds/1234567890\ntail",
				options: { maxLines: 2 },
			},
		},
		{ theme: testTheme, part: "output" },
	);
	const rendered = component.render(32).join("\n");

	expect(rendered).toContain("… +");
	expect(rendered).toContain("tail");
});

test("exec cell facade caches stable component renders by width", () => {
	const component = renderExecCellComponent(
		{
			kind: "command",
			status: "done",
			command: "printf 'hello'",
			outputBlock: { output: "hello" },
		},
		{ theme: testTheme },
	);

	const first = component.render(80);
	expect(component.render(80)).toBe(first);
	expect(component.render(72)).not.toBe(first);
	component.invalidate();
	expect(component.render(80)).not.toBe(first);
});

test("exec cell facade does not retain render caches for large output blocks", () => {
	const component = renderExecCellComponent(
		{
			kind: "command",
			status: "done",
			command: "printf large",
			outputBlock: { output: `${"x".repeat(20_000)}\nend` },
		},
		{ theme: testTheme },
	);

	const first = component.render(80);
	expect(component.render(80)).not.toBe(first);
});

test("exec cell facade reuses running renders when visible text is unchanged", () => {
	const component = renderExecCellComponent(
		{
			kind: "command",
			status: "running",
			command: "sleep 60",
			elapsedMs: 0,
		},
		{ theme: testTheme },
	);

	const first = component.render(80);
	expect(component.render(80)).toBe(first);
});

test("exec cell facade renders write_stdin cells and output blocks", () => {
	const call = renderExecCell(
		{
			kind: "write-stdin",
			status: "running",
			command: "python repl.py",
			elapsedMs: 65_400,
			writeStdin: {
				sessionId: 3,
				input: "print(1)\n",
				stdinOpen: true,
			},
		},
		{ theme: testTheme, part: "header" },
	);
	const output = renderExecCell(
		{
			kind: "write-stdin",
			status: "done",
			outputBlock: {
				output: "1\n",
				footer: `${testTheme.fg("accent", "Session 3 still running")}${testTheme.fg("dim", " · ")}${testTheme.fg("mdLink", "tty")}`,
			},
		},
		{ theme: testTheme, part: "output" },
	);

	expect(call).toBe(
		renderWriteStdinCall(3, "print(1)\n", "python repl.py", testTheme, "running", false, 65_400, true),
	);
	expect(output).toBe(
		renderOutputBlock(
			"1\n",
			testTheme,
			`${testTheme.fg("accent", "Session 3 still running")}${testTheme.fg("dim", " · ")}${testTheme.fg("mdLink", "tty")}`,
		),
	);
});

test("exec cell facade renders spawned background terminal cells and HUD lines", () => {
	const spawned = renderExecCell(
		{
			kind: "spawned-background-terminal",
			status: "done",
			command: "npm run dev",
			rtkWrapped: true,
		},
		{ theme: testTheme, part: "header" },
	);
	const hud = renderBackgroundTerminalHud(
		{
			command: "npm run dev",
			output: "ready\n",
			elapsedMs: 65_000,
			stdinOpen: true,
		},
		{ theme: testTheme, width: 80 },
	);

	expect(spawned).toBe(renderSpawnedBackgroundTerminalCall("npm run dev", testTheme, true));
	expect(hud).toBe(renderBackgroundTerminalHudLine("npm run dev", "ready\n", testTheme, 65_000, 80, true));
});

test("exec command call unwraps simple shell wrappers before rendering", () => {
	const rendered = renderExecCommandCall(`bash -lc 'git status --short'`, "running", testTheme);
	expect(rendered).toBe(
		`<dim>⠋</dim> <bold>Running</bold> <syntaxFunction>git</syntaxFunction> status <syntaxKeyword>--short</syntaxKeyword>`,
	);
});

test("exec command call wraps very long command lines", () => {
	const rendered = renderExecCommandCall(`printf ${"x".repeat(300)}`, "done", testTheme);
	expect(rendered).toContain("\n<dim>    </dim>");
	expect(rendered).not.toContain("x".repeat(200));
});

test("write stdin call uses unwrapped command previews", () => {
	const rendered = renderWriteStdinCall(3, "", `bash -lc 'git status --short'`, testTheme);
	expect(rendered).toBe(
		`<success>• </success><bold>Waited for background terminal</bold><dim> · </dim><muted>git status --short</muted>`,
	);
});

test("write stdin call keeps long command previews compact", () => {
	const rendered = renderWriteStdinCall(3, "", `printf ${"x".repeat(300)}`, testTheme);
	expect(rendered).toEndWith("...</muted>");
	expect(rendered).not.toContain("\n<dim>    </dim>");
});

test("running terminal calls show elapsed time", () => {
	const firstFrame = renderExecCommandCall("sleep 60", "running", testTheme, false, 0);
	const secondFrame = renderExecCommandCall("sleep 60", "running", testTheme, false, 120);
	expect(firstFrame).not.toBe(secondFrame);
	expect(renderExecCommandCall("sleep 60", "running", testTheme, false, 65_400)).toContain(
		`<bold>Running</bold> <syntaxFunction>sleep</syntaxFunction> 60<dim> · 1m 05s</dim>`,
	);
	expect(renderWriteStdinCall(3, "", "sleep 60", testTheme, "running", false, 65_400)).toBe(
		`<dim>⠴ </dim><bold>Waiting for background terminal</bold><dim> · 1m 05s</dim><dim> · </dim><muted>sleep 60</muted>`,
	);
});

test("background terminal HUD summarizes command, output size, and last line", () => {
	const rendered = renderBackgroundTerminalHudLine(
		"just sync-proptest mock 1 --skip-triage",
		"first\nmiddle\nlast line\n",
		testTheme,
		360,
		120,
	);

	expect(rendered).toBe(
		"<accent>●</accent> <bold>background terminal</bold><dim> · </dim><dim>0s</dim><dim> · </dim><muted>(3 lines)</muted><dim> · </dim><dim>last line</dim><dim> · </dim><muted>just sync-proptest mock 1 --skip-triage</muted>",
	);
});

test("background terminal pulse marker uses smooth RGB intensity like Working", () => {
	const dark = renderBackgroundTerminalHudLine(undefined, "", rgbTestTheme, 0).split(" ")[0] ?? "";
	const bright = renderBackgroundTerminalHudLine(undefined, "", rgbTestTheme, 600).split(" ")[0] ?? "";

	expect(stripAnsi(dark)).toBe("●");
	expect(stripAnsi(bright)).toBe("●");
	expect(dark).toContain("\x1b[38;2;45;54;90m");
	expect(bright).toContain("\x1b[38;2;145;174;255m");
});

test("background terminal HUD label uses Working-style trickle animation", () => {
	const early = renderBackgroundTerminalHudLine(undefined, "", rgbTestTheme, 0);
	const later = renderBackgroundTerminalHudLine(undefined, "", rgbTestTheme, 240);

	expect(stripAnsi(early)).toContain("background terminal");
	expect(stripAnsi(later)).toContain("background terminal");
	expect(early).not.toBe(later);
	expect(later).toContain("\x1b[38;2;155;186;255m");
});

test("background terminal HUD shows stdin capability when available", () => {
	const rendered = renderBackgroundTerminalHudLine("node repl.js", "", testTheme, 0, 120, true);

	expect(rendered).toContain("<mdLink>tty</mdLink>");
	expect(rendered).not.toContain("stdin");
});

test("unified exec format hides non-tty stdin and labels tty sessions", () => {
	const rendered = formatUnifiedExecResult({
		chunk_id: "chunk",
		wall_time_seconds: 0.25,
		output: "",
		session_id: 7,
		stdin_open: false,
	});

	expect(rendered).toContain("Process running with session ID 7");
	expect(rendered).not.toContain("Stdin:");

	const ttyRendered = formatUnifiedExecResult({
		chunk_id: "chunk",
		wall_time_seconds: 0.25,
		output: "",
		session_id: 8,
		stdin_open: true,
	});
	expect(ttyRendered).toContain("TTY: yes");
});

test("background terminal overlay renders empty and visible session rows", () => {
	let records: any[] = [];
	const listeners: Array<() => void> = [];
	let renderRequests = 0;
	let doneCalls = 0;
	const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const overlay = new BackgroundTerminalOverlay(
		{
			listSessions: () => records,
			onSessionUpdate: (listener) => {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
		} as any,
		{ terminal: { rows: 20 }, requestRender: () => renderRequests++ } as any,
		plainTheme,
		() => doneCalls++,
	);

	expect(overlay.render(100).join("\n")).toContain("No background terminals");

	records = [
		{
			id: 3,
			command: "node repl.js",
			output: "first\nlast line\n",
			running: true,
			stdinOpen: true,
		},
		{
			id: 4,
			command: `printf ${"x".repeat(160)}`,
			output: "",
			running: false,
			exitCode: 7,
			stdinOpen: false,
		},
	];
	listeners[0]?.();
	const rendered = overlay.render(80).join("\n");

	expect(renderRequests).toBe(1);
	expect(rendered).toContain("background terminals");
	expect(rendered).toContain("#3");
	expect(rendered).toContain("running");
	expect(rendered).toContain("tty");
	expect(rendered).toContain("node repl.js");
	expect(rendered).toContain("last: last line");
	expect(rendered).toContain("#4");
	expect(rendered).toContain("exited 7");
	expect(rendered).not.toContain("stdin closed");
	expect(rendered).not.toContain("x".repeat(80));

	overlay.handleInput("q");
	expect(doneCalls).toBe(1);
	listeners[0]?.();
	expect(renderRequests).toBe(1);
});

test("background terminal overlay supports vim navigation, attach, and kill", () => {
	let records: any[] = [
		{
			id: 3,
			command: "sleep 60",
			output: "tick 1\n",
			running: true,
			stdinOpen: false,
		},
		{
			id: 4,
			command: "node repl.js",
			output: "ready\nprompt\n",
			running: true,
			stdinOpen: true,
		},
	];
	const listeners: Array<() => void> = [];
	const killed: number[] = [];
	let renderRequests = 0;
	const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const overlay = new BackgroundTerminalOverlay(
		{
			listSessions: () => records,
			stopSession: (sessionId: number) => {
				killed.push(sessionId);
				records = records.filter((record) => record.id !== sessionId);
				for (const listener of listeners) listener();
				return true;
			},
			onSessionUpdate: (listener) => {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
		} as any,
		{ terminal: { rows: 18 }, requestRender: () => renderRequests++ } as any,
		plainTheme,
		() => {},
	);

	expect(overlay.render(100).join("\n")).toContain("> #3");

	overlay.handleInput("j");
	expect(overlay.render(100).join("\n")).toContain("> #4");

	overlay.handleInput("l");
	let rendered = overlay.render(100).join("\n");
	expect(rendered).toContain("background terminal #4 attached");
	expect(rendered).toContain("prompt");

	records = [{ ...records[1], output: "ready\nprompt\nnext\n" }];
	listeners[0]?.();
	rendered = overlay.render(100).join("\n");
	expect(renderRequests).toBeGreaterThan(0);
	expect(rendered).toContain("next");

	overlay.handleInput("h");
	expect(overlay.render(100).join("\n")).toContain("> #4");

	overlay.handleInput("x");
	rendered = overlay.render(100).join("\n");
	expect(killed).toEqual([4]);
	expect(rendered).toContain("Killed background terminal #4");
	expect(rendered).toContain("No background terminals");
	expect(rendered).not.toContain("node repl.js");
});

test("grouped exploration rows use a one-line in-flight placeholder", () => {
	const actionGroups = [[{ kind: "read", title: "Read", body: "a.ts" }]] as any;
	const running = renderGroupedExecCommandCall(actionGroups, "running", testTheme, false, 0);
	const done = renderGroupedExecCommandCall(actionGroups, "done", testTheme, false, 120);

	expect(running).toBe("<dim>⠋</dim> <bold>Exploring</bold>");
	expect(running).not.toContain("a.ts");
	expect(done).toContain("<success>•</success> <bold>Explored</bold>");
	expect(done).toContain("<accent>Read</accent>");
});

test("exploration grouping keeps the first row as the visible anchor", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);

		tracker.recordStart("call-1", "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts");
		tracker.recordStart("call-2", "sed -n '1,20p' pi/agent/extensions/exec-command/tools/exec-command-tool.ts");

		const firstRow = tool
			.renderCall({ cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts" }, testTheme, {
				toolCallId: "call-1",
				state: {},
				isPartial: true,
				invalidate() {},
			})
			.render(200)
			.join("\n");
		const secondRow = tool
			.renderCall({ cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/tools/exec-command-tool.ts" }, testTheme, {
				toolCallId: "call-2",
				state: {},
				isPartial: true,
				invalidate() {},
			})
			.render(200)
			.join("\n");

		expect(firstRow).toContain("<bold>Exploring</bold>");
		expect(firstRow).not.toContain("index.ts");
		expect(firstRow).not.toContain("exec-command-tool.ts");
		expect(secondRow).toBe("");
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exploration grouping hides later placeholders before execution starts", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);

		const firstRow = tool
			.renderCall({ cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts" }, testTheme, {
				toolCallId: "call-1",
				state: {},
				isPartial: true,
				invalidate() {},
			})
			.render(200)
			.join("\n");
		const secondRow = tool
			.renderCall({ cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/tools/exec-command-tool.ts" }, testTheme, {
				toolCallId: "call-2",
				state: {},
				isPartial: true,
				invalidate() {},
			})
			.render(200)
			.join("\n");

		expect(firstRow).toContain("<bold>Exploring</bold>");
		expect(secondRow).toBe("");
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("completed render contexts do not keep running-command elapsed timers alive", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "sleep 60");

		const state: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			toolCallId: "call",
			state,
			isPartial: false,
			invalidate() {},
		});

		expect(state.elapsedTimer).toBeUndefined();
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("running render contexts keep only one elapsed timer per tool call", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "sleep 60");

		const firstState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		const secondState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			toolCallId: "call",
			state: firstState,
			isPartial: true,
			invalidate() {},
		});
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			toolCallId: "call",
			state: secondState,
			isPartial: true,
			invalidate() {},
		});

		expect(firstState.elapsedTimer).toBeDefined();
		expect(secondState.elapsedTimer).toBeUndefined();
		if (firstState.elapsedTimer) clearTimeout(firstState.elapsedTimer);
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("running render contexts without tool call ids de-dupe by command", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "sleep 60");

		const firstState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		const secondState: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			state: firstState,
			isPartial: true,
			invalidate() {},
		});
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			state: secondState,
			isPartial: true,
			invalidate() {},
		});

		expect(firstState.elapsedTimer).toBeDefined();
		expect(secondState.elapsedTimer).toBeUndefined();
		if (firstState.elapsedTimer) clearTimeout(firstState.elapsedTimer);
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});
test("exploration grouping does not append a single command output preview", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);

		tracker.recordStart("call-1", "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts");
		const resultRow = tool.renderResult(
			{
				content: [{ type: "text", text: "fallback" }],
			},
			{ expanded: false, isPartial: false },
			testTheme,
			{
				toolCallId: "call-1",
				args: { cmd: "sed -n '1,20p' pi/agent/extensions/exec-command/index.ts" },
				state: {},
			},
		);

		expect(resultRow.render(200)).toEqual([]);
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("yielded background exec calls render a static spawned row", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = {
		exec: async () => {
			throw new Error("unexpected exec");
		},
		write: async () => {
			throw new Error("unexpected write");
		},
		hasSession: () => true,
		getSessionCommand: () => "sleep 60",
		getSessionSnapshot: () => ({
			command: "sleep 60",
			output: "first\nlast\n",
			running: true,
		}),
		onSessionExit: () => () => {},
		shutdown() {},
	};
	try {
		registerExecCommandTool(
			{ registerTool: (definition: any) => (tool = definition) } as any,
			tracker,
			sessions as any,
		);
		tracker.recordStart("call", "sleep 60");
		tracker.recordPersistentSession("call", 7);

		const state: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		const row = tool
			.renderCall({ cmd: "sleep 60" }, testTheme, {
				toolCallId: "call",
				state,
				isPartial: false,
				invalidate() {},
			})
			.render(120)
			.join("\n");

		expect(row).toContain("<bold>Spawned background terminal</bold>");
		expect(row).toContain("<syntaxFunction>sleep</syntaxFunction> 60");
		expect(row).not.toContain("Waiting for background terminal");
		expect(state.elapsedTimer).toBeUndefined();

		tracker.recordSessionFinished(7);
		const finishedRow = tool
			.renderCall({ cmd: "sleep 60" }, testTheme, {
				toolCallId: "call",
				state: {},
				isPartial: false,
				invalidate() {},
			})
			.render(120)
			.join("\n");

		expect(finishedRow).toContain("<bold>Spawned background terminal</bold>");
		expect(finishedRow).not.toContain("<bold>Ran</bold>");
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exec command call renders failed status as a red dot", () => {
	const rendered = renderExecCommandCall("false", "done", testTheme, true);
	expect(rendered).toBe(`<error>•</error> <bold>Ran</bold> <syntaxFunction>false</syntaxFunction>`);
});

test("exec command call can show an RTK routing marker", () => {
	const rendered = renderExecCommandCall("cargo test", "done", testTheme, false, undefined, true);
	expect(rendered).toBe(
		`<success>•</success> <bold>Ran</bold> <syntaxFunction>cargo</syntaxFunction> test<dim> · </dim><mdLink>\x1b[3mvia rtk\x1b[23m</mdLink>`,
	);
});

test("exec command call can show a Context Guard routing marker", () => {
	const rendered = renderExecCommandCall("cargo test", "done", testTheme, false, undefined, false, true);
	expect(rendered).toBe(
		`<success>•</success> <bold>Ran</bold> <syntaxFunction>cargo</syntaxFunction> test<dim> · </dim><mdLink>\x1b[3mvia context-guard\x1b[23m</mdLink>`,
	);
});

test("line-safe rg summaries do not display numeric limits as the query", () => {
	const rendered = renderExecCommandCall(
		`rg -n -M 400 --max-columns-preview "struct SyncPersistenceUtilities|class SyncPersistenceUtilities"`,
		"done",
		testTheme,
	);
	expect(rendered).toContain("<bold>Explored</bold>");
	expect(rendered).toContain(
		"<accent>Search</accent> <muted>struct SyncPersistenceUtilities|class SyncPersistenceUtilities</muted>",
	);
	expect(rendered).not.toContain("<muted>400");
});

test("compact rtk grep summaries do not display output limits as the query", () => {
	const rendered = renderExecCommandCall(
		`rtk grep -m 100 -l 400 "struct SyncPersistenceUtilities|class SyncPersistenceUtilities" src`,
		"done",
		testTheme,
	);
	expect(rendered).toContain("<bold>Explored</bold>");
	expect(rendered).toContain(
		"<accent>Search</accent> <muted>struct SyncPersistenceUtilities|class SyncPersistenceUtilities in src</muted>",
	);
	expect(rendered).not.toContain("<muted>400");
});

test("output block uses Codex-like prefixes and preserves ANSI color", () => {
	const rendered = renderOutputBlock("plain\n\u001b[32m✓ green\u001b[0m\n", testTheme);
	expect(rendered).toBe(`<dim>  └ </dim><dim>plain</dim>\n<dim>    </dim>\u001b[32m✓ green\u001b[0m`);
});

test("output block preserves plain line spacing", () => {
	const rendered = renderOutputBlock("  indented  ", testTheme);
	expect(rendered).toBe("<dim>  └ </dim><dim>  indented  </dim>");
});

test("output block limits very long plain lines", () => {
	const rendered = renderOutputBlock("x".repeat(300), testTheme);
	expect(rendered).toBe(`<dim>  └ </dim><dim>${"x".repeat(217)}...</dim>`);
});

test("output block truncates by displayed rows for long URL-like lines", () => {
	const longUrl = "https://example.test/api/v1/projects/alpha-team/releases/2026-02-17/builds/1234567890";
	const rendered = renderOutputBlock(`${longUrl}\ntail`, testTheme, undefined, {
		maxLines: 2,
		width: 32,
	});

	expect(rendered).toContain("… +");
	expect(rendered).toContain("tail");
});

test("output block collapses large output in the middle", () => {
	const rendered = renderOutputBlock(
		Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"),
		testTheme,
		undefined,
		{ maxLines: 5 },
	);

	expect(stripAnsi(rendered)).toBe(
		[
			"<dim>  └ </dim><dim>line 1</dim>",
			"<dim>    </dim><dim>line 2</dim>",
			"<dim>    </dim>… +4 lines ( transcript)",
			"<dim>    </dim><dim>line 7</dim>",
			"<dim>    </dim><dim>line 8</dim>",
		].join("\n"),
	);
	expect(rendered).toContain("\x1b[");
});

test("output block marks token-truncated output at the top", () => {
	const rendered = renderOutputBlock("tail", testTheme, undefined, {
		truncatedAbove: true,
		originalTokenCount: 1234,
	});

	expect(rendered).toBe(
		"<dim>  └ </dim><dim>… output truncated above (original ~1234 tokens)</dim>\n<dim>    </dim><dim>tail</dim>",
	);
});

test("exec renderers self-render without the default success shell", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool(
			{ registerTool: (definition: any) => (tool = definition) } as any,
			createExecCommandTracker(),
			sessions,
		);

		expect(tool.renderShell).toBe("self");
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "fallback" }],
				details: { output: "visible output\nnext line\n", exit_code: 0 },
			},
			{ expanded: false, isPartial: false },
			testTheme,
			{ toolCallId: "call", args: { cmd: "printf visible" } },
		);
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("<dim>  └ </dim><dim>visible output</dim>");
		expect(rendered).toContain("<dim>    </dim><dim>next line</dim>");
		expect(rendered).not.toContain("Exit code: 0");
	} finally {
		sessions.shutdown();
	}
});

test("user bash executions render with shared exec command styling", () => {
	execCommandExtension({
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on() {},
	} as any);

	const component = new BashExecutionComponent("echo hello", { requestRender() {} } as any);
	component.appendOutput("hello\n");
	component.setComplete(0, false);

	const raw = component.render(80).join("\n");
	const rendered = stripAnsi(raw);
	expect(rendered).toContain("You ran");
	expect(rendered).toContain("echo hello");
	expect(rendered).toContain("  └ hello");
	expect(rendered).not.toContain("$ echo hello");
	expect(rendered).not.toContain("─");
	expect(raw).toContain("\x1b[");
});

test("exec result renderer truncates output by rendered width", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool(
			{ registerTool: (definition: any) => (tool = definition) } as any,
			createExecCommandTracker(),
			sessions,
		);

		const longUrl = `https://example.test/${"very-long-segment/".repeat(20)}`;
		const rendered = tool
			.renderResult(
				{
					content: [{ type: "text", text: "fallback" }],
					details: { output: `${longUrl}\ntail`, exit_code: 0 },
				},
				{ expanded: false, isPartial: false },
				testTheme,
				{ toolCallId: "call", args: { cmd: "printf long" }, state: {} },
			)
			.render(32)
			.join("\n");

		expect(rendered).toContain("… +");
		expect(rendered).toContain("tail");
	} finally {
		sessions.shutdown();
	}
});

test("exec result renderer hides yielded background-terminal session details", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool(
			{ registerTool: (definition: any) => (tool = definition) } as any,
			createExecCommandTracker(),
			sessions,
		);

		const rendered = tool
			.renderResult(
				{
					content: [{ type: "text", text: "fallback" }],
					details: { output: "partial\n", session_id: 9, stdin_open: false },
				},
				{ expanded: false, isPartial: false },
				testTheme,
				{ toolCallId: "call", args: { cmd: "sleep 60" }, state: {} },
			)
			.render(120)
			.join("\n");

		expect(rendered).toBe("");
	} finally {
		sessions.shutdown();
	}
});

test("exec result renderer hides tracker-known background terminal results even when details are omitted", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "sleep 60");
		tracker.recordPersistentSession("call", 9);

		const rendered = tool
			.renderResult(
				{
					content: [
						{
							type: "text",
							text: formatUnifiedExecResult({
								chunk_id: "abc123",
								wall_time_seconds: 0.25,
								output: "partial\n",
								session_id: 9,
							}),
						},
					],
				},
				{ expanded: false, isPartial: false },
				testTheme,
				{ toolCallId: "call", args: { cmd: "sleep 60" }, state: {} },
			)
			.render(120)
			.join("\n");

		expect(rendered).toBe("");
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("extension hides empty self-rendered tool rows", () => {
	type Handler = () => void;
	const handlers = new Map<string, Handler[]>();
	execCommandExtension({
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any);

	const hiddenTool = {
		renderShell: "self",
		renderCall() {
			return new Container();
		},
		renderResult() {
			return new Container();
		},
	};
	const component = new ToolExecutionComponent(
		"hidden",
		"call-hidden",
		{},
		{},
		hiddenTool as any,
		{ requestRender() {} } as any,
		process.cwd(),
	);

	expect(component.render(80)).toEqual([]);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("exec command streams partial output while the process is still running", async () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager({ minNonInteractiveExecYieldTimeMs: 50 });
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		const updates: any[] = [];
		const result = await tool.execute(
			"call-stream",
			{ cmd: "printf first; sleep 0.25; printf second", yield_time_ms: 5000 },
			undefined,
			(update: any) => updates.push(update),
			{ cwd: process.cwd() },
		);

		expect(result.details.output).toBe("firstsecond");
		expect(updates.some((update) => update.details?.output?.includes("first"))).toBe(true);
		expect(updates.some((update) => update.details?.session_id !== undefined)).toBe(true);
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exec command suppresses partial output streaming for exploration commands", async () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	let receivedUpdateCallback = false;
	const sessions = {
		exec: async (_input: unknown, _cwd: string, _signal?: AbortSignal, onUpdate?: unknown) => {
			receivedUpdateCallback = typeof onUpdate === "function";
			return {
				chunk_id: "explore",
				wall_time_seconds: 0,
				output: "content",
				exit_code: 0,
			};
		},
		write: async () => {
			throw new Error("unexpected write");
		},
		hasSession: () => false,
		getSessionCommand: () => undefined,
		onSessionExit: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions as any);

	await tool.execute(
		"call-explore-stream",
		{ cmd: "sed -n '1,80p' pi/agent/extensions/exec-command/index.ts", yield_time_ms: 5000 },
		undefined,
		() => {
			throw new Error("exploration command should not stream partial output");
		},
		{ cwd: process.cwd() },
	);

	expect(receivedUpdateCallback).toBe(false);
	tracker.clear();
});

test("write stdin renderer self-renders without the default success shell", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerWriteStdinTool({ registerTool: (definition: any) => (tool = definition) } as any, sessions);

		expect(tool.renderShell).toBe("self");
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { output: "poll output\n", exit_code: 0 },
			},
			{ expanded: false, isPartial: false },
			testTheme,
		);
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("<dim>  └ </dim><dim>poll output</dim>");
		expect(rendered).not.toContain("Exit code: 0");
	} finally {
		sessions.shutdown();
	}
});

test("write stdin hides still-running empty background terminal polls from transcript", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerWriteStdinTool({ registerTool: (definition: any) => (tool = definition) } as any, sessions);

		expect(tool.renderCall({ session_id: 3 }, testTheme, { isPartial: false }).render(120)).toEqual([]);
		const waitState: { elapsedTimer?: ReturnType<typeof setTimeout>; startedAtMs?: number } = {};
		expect(
			tool
				.renderCall({ session_id: 3 }, testTheme, {
					isPartial: true,
					state: waitState,
					invalidate() {},
				})
				.render(120),
		).toEqual([]);
		expect(waitState.elapsedTimer).toBeUndefined();
		expect(
			tool
				.renderResult(
					{
						content: [{ type: "text", text: "" }],
						details: { output: "still running\n", session_id: 3 },
					},
					{ expanded: false, isPartial: false },
					testTheme,
					{ args: { session_id: 3 } },
				)
				.render(120),
		).toEqual([]);

		const interacted = tool
			.renderCall({ session_id: 3, chars: "\u0003" }, testTheme, { isPartial: false })
			.render(120);
		expect(interacted.join("\n")).toContain("<bold>Interacted with background terminal</bold>");
	} finally {
		sessions.shutdown();
	}
});

test("write stdin result renderer parses stdin capability from formatted transcripts", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerWriteStdinTool({ registerTool: (definition: any) => (tool = definition) } as any, sessions);

		const rendered = tool
			.renderResult(
				{
					content: [
						{
							type: "text",
							text: [
								"Chunk ID: chunk",
								"Wall time: 0.2500 seconds",
								"Process running with session ID 3",
								"Stdin: open",
								"Output:",
								"hello",
							].join("\n"),
						},
					],
				},
				{ expanded: false, isPartial: false },
				testTheme,
				{ args: { session_id: 3, chars: "\u0003" } },
			)
			.render(120)
			.join("\n");

		expect(rendered).toContain("Session 3 still running");
		expect(rendered).toContain("<mdLink>tty</mdLink>");
		expect(rendered).not.toContain("stdin open");
	} finally {
		sessions.shutdown();
	}
});

test("write stdin renders animated in-flight interaction rows", () => {
	let tool: any;
	const sessions = createExecSessionManager();
	try {
		registerWriteStdinTool({ registerTool: (definition: any) => (tool = definition) } as any, sessions);

		const interactionState: { elapsedTimer?: ReturnType<typeof setTimeout>; startedAtMs?: number } = {};
		const interactionRow = tool
			.renderCall({ session_id: 3, chars: "\u0003" }, testTheme, {
				isPartial: true,
				state: interactionState,
				invalidate() {},
			})
			.render(120)
			.join("\n");
		expect(interactionRow).toContain("<bold>Interacting with background terminal</bold>");
		expect(interactionState.elapsedTimer).toBeDefined();
		if (interactionState.elapsedTimer) clearTimeout(interactionState.elapsedTimer);
	} finally {
		sessions.shutdown();
	}
});

test("shutdown terminates descendant processes that escaped the shell process group", async () => {
	const marker = `exec-command-shutdown-descendant-${process.pid}-${Date.now()}`;
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 250 });
	const childCode = [
		"import signal,time",
		"signal.signal(signal.SIGTERM, signal.SIG_IGN)",
		"signal.signal(signal.SIGHUP, signal.SIG_IGN)",
		"time.sleep(30)",
	].join("; ");
	const parentCode = [
		"import subprocess,time",
		`p=subprocess.Popen(["python3","-c",${JSON.stringify(childCode)},${JSON.stringify(`${marker}-child`)}], start_new_session=True)`,
		'print("child="+str(p.pid), flush=True)',
		"time.sleep(30)",
	].join("; ");

	try {
		const result = await sessions.exec(
			{
				cmd: `python3 -c ${shellQuote(parentCode)} ${shellQuote(`${marker}-parent`)}`,
				yield_time_ms: 250,
			},
			process.cwd(),
		);
		expect(result.session_id).toBeDefined();
		let output = result.output;
		for (let attempt = 0; !output.includes("child=") && attempt < 12; attempt += 1) {
			const poll = await sessions.write({ session_id: result.session_id!, yield_time_ms: 250 });
			output += poll.output;
		}
		expect(output).toContain("child=");
		expect(processList()).toContain(`${marker}-child`);

		sessions.shutdown();

		await waitForProcessListToExclude(marker);
	} finally {
		sessions.shutdown();
		try {
			execSync(`pkill -KILL -f ${shellQuote(marker)}`);
		} catch {
			// Process already exited.
		}
	}
});

test("extension marks nonzero exec results as errors for red status dots", () => {
	type Handler = (event?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const toolResultHandlers = handlers.get("tool_result") ?? [];
	const nonzero = toolResultHandlers.map((handler) =>
		handler({
			toolName: "exec_command",
			details: { output: "", exit_code: 1 },
		}),
	);
	const zero = toolResultHandlers.map((handler) =>
		handler({
			toolName: "exec_command",
			details: { output: "", exit_code: 0 },
		}),
	);

	expect(nonzero).toContainEqual({ isError: true });
	expect(zero.every((result) => result === undefined)).toBe(true);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("extension status shows background terminal and stdin-open counts", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	const statusCalls: Array<{ key: string; text: string | undefined }> = [];
	const widgetCalls: Array<{ key: string; content: any; options?: any }> = [];
	let widgetText = "";
	let activeTools = ["read", "bash"];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
			setWidget: (key: string, content: any, options?: any) => {
				widgetCalls.push({ key, content, options });
				if (typeof content === "function") {
					const component = content(
						{ requestRender() {} },
						{ fg: (_role: string, text: string) => text, bold: (text: string) => text },
					);
					widgetText = component.render(120).join("\n");
				}
			},
			notify() {},
		},
		cwd: process.cwd(),
	};

	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const result = await execTool.execute(
			"call-status",
			{ cmd: "sleep 1; printf done", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details.session_id).toBeNumber();
		expect(statusCalls.at(-1)).toEqual({
			key: "background-terminals",
			text: "1 background terminal · 1 running",
		});
		expect(widgetCalls.at(-1)?.key).toBe("background-terminals");
		expect(widgetCalls.at(-1)?.options).toEqual({ placement: "aboveEditor" });
		expect(widgetText).toContain("background terminal");
		expect(widgetText).toContain("sleep 1; printf done");
		expect(widgetText).not.toContain("stdin closed");
		expect(widgetText).toContain("(no output)");
		expect(widgetText).toContain("0s");

		await Bun.sleep(1200);
		expect(statusCalls.at(-1)).toEqual({
			key: "background-terminals",
			text: "1 background terminal · 0 running",
		});
		expect(widgetCalls.at(-1)).toEqual({ key: "background-terminals", content: undefined, options: undefined });
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}

	expect(statusCalls.at(-1)).toEqual({ key: "background-terminals", text: undefined });
	expect(widgetCalls.at(-1)).toEqual({ key: "background-terminals", content: undefined, options: undefined });
});

test("extension resume clears stale background terminal sessions and HUD state", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	let writeTool: any;
	const statusCalls: Array<{ key: string; text: string | undefined }> = [];
	const widgetCalls: Array<{ key: string; content: any; options?: any }> = [];
	let activeTools = ["read", "bash"];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
			setWidget: (key: string, content: any, options?: any) => widgetCalls.push({ key, content, options }),
			notify() {},
		},
		cwd: process.cwd(),
	};

	for (const handler of handlers.get("session_start") ?? []) handler({ reason: "startup" }, ctx);
	const result = await execTool.execute(
		"call-resume-stale-terminal",
		{ cmd: "sleep 60", yield_time_ms: 250 },
		undefined,
		undefined,
		ctx,
	);
	expect(result.details.session_id).toBeNumber();
	expect(statusCalls.at(-1)).toEqual({
		key: "background-terminals",
		text: "1 background terminal · 1 running",
	});
	expect(widgetCalls.at(-1)?.key).toBe("background-terminals");

	for (const handler of handlers.get("session_start") ?? []) handler({ reason: "resume" }, ctx);

	expect(statusCalls.at(-1)).toEqual({ key: "background-terminals", text: undefined });
	expect(widgetCalls.at(-1)).toEqual({ key: "background-terminals", content: undefined, options: undefined });
	await expect(
		writeTool.execute(
			"poll-cleared-stale-terminal",
			{ session_id: result.details.session_id, chars: "", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		),
	).rejects.toThrow(`Unknown process id ${result.details.session_id}`);

	for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
});

test("extension status counts stdin-open tty sessions", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	const statusCalls: Array<{ key: string; text: string | undefined }> = [];
	let activeTools = ["read", "bash"];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
			notify() {},
		},
		cwd: process.cwd(),
	};

	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const result = await execTool.execute(
			"call-status-tty",
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details.session_id).toBeNumber();
		expect(statusCalls.at(-1)).toEqual({
			key: "background-terminals",
			text: "1 background terminal · 1 running · 1 tty",
		});
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension HUD keeps line count and last output visible before long commands", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	let widgetText = "";
	const longCommand = `printf 'first line\\nlast visible line\\n'; sleep 1; printf '${"x".repeat(120)}'`;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus() {},
			setWidget(_key: string, content: any) {
				if (typeof content === "function") {
					let component: any;
					const rerender = () => {
						widgetText = component.render(80).join("\n");
					};
					component = content(
						{ requestRender: rerender },
						{ fg: (_role: string, text: string) => text, bold: (text: string) => text },
					);
					rerender();
				}
			},
			notify() {},
		},
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		await execTool.execute("call-hud-output", { cmd: longCommand, yield_time_ms: 250 }, undefined, undefined, ctx);

		expect(widgetText).toContain("●");
		expect(widgetText).toContain("(2 lines)");
		expect(widgetText).toContain("last visible line");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension appends a new completion message when a background terminal exits", async () => {
	const { result, sentMessages, renderer } = await runExecCommandCompletionScenario(
		"sleep 0.3; printf done",
		"call-finished-message",
	);

	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
	expect(sentMessages[0]?.message.display).toBe(true);
	expect(sentMessages[0]?.message.content).toContain("Command: sleep 0.3; printf done");
	expect(sentMessages[0]?.message.content).toContain("Wall time:");
	expect(sentMessages[0]?.message.content).toContain("Process exited with code 0");
	expect(sentMessages[0]?.message.content).toContain("Output:\ndone");
	expect(sentMessages[0]?.message.details.session_id).toBe(result.details.session_id);
	expect(sentMessages[0]?.message.details.elapsed_ms).toBeNumber();
	expect(sentMessages[0]?.message.details.exit_code).toBe(0);
	expect(sentMessages[0]?.message.details.output).toBe("done");
	expect(sentMessages[0]?.message.details.output_truncated).toBe(false);

	const rendered = renderer(sentMessages[0]!.message, { expanded: false }, testTheme).render(120).join("\n");
	expect(rendered).toContain("<bold>Ran</bold>");
	expect(rendered).toContain("sleep");
	expect(rendered).toContain("done");
	expect(rendered).not.toContain("Session ");
});

test("extension emits completion message for quiet successful background terminal", async () => {
	const { result, sentMessages } = await runExecCommandCompletionScenario("sleep 0.3", "call-quiet-finished-message");

	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
	expect(sentMessages[0]?.message.details.session_id).toBe(result.details.session_id);
	expect(sentMessages[0]?.message.details.exit_code).toBe(0);
	expect(sentMessages[0]?.message.details.output).toBe("");
	expect(sentMessages[0]?.message.details.output_truncated).toBe(false);
	expect(sentMessages[0]?.message.content).toContain("Process exited with code 0");
	expect(sentMessages[0]?.message.content).toContain("Output:\n");
});

test("extension wakes the agent with completion details when an interactive background terminal exits", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	let writeStdinTool: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeStdinTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-no-wake",
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const sessionId = spawned.details.session_id;
		expect(sessionId).toBeNumber();
		expect(spawned.details.stdin_open).toBe(true);
		expect(sentMessages).toHaveLength(0);

		const write = await writeStdinTool.execute(
			"write-no-wake",
			{ session_id: sessionId, chars: "hello\n", yield_time_ms: 500 },
			undefined,
			undefined,
			ctx,
		);
		expect(write.details.exit_code).toBe(0);
		expect(write.details.output).toContain("got:hello");

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
		expect(sentMessages[0]?.message.details.session_id).toBe(sessionId);
		expect(sentMessages[0]?.message.details.output).toContain("got:hello");
		expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(sentMessages[0]?.message.content).toContain('Command: read line; printf "got:$line"');
		expect(sentMessages[0]?.message.content).toContain("Process exited with code 0");
		expect(sentMessages[0]?.message.content).toContain("got:hello");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension reports timed-out background terminal completion distinctly", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-timeout-completion",
			{
				cmd: "printf before-timeout; sleep 5",
				yield_time_ms: 250,
				timeout: 350,
				context_guard: false,
			},
			undefined,
			undefined,
			ctx,
		);
		const sessionId = spawned.details.session_id;
		expect(sessionId).toBeNumber();

		await Bun.sleep(900);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
		expect(sentMessages[0]?.message.details.session_id).toBe(sessionId);
		expect(sentMessages[0]?.message.details.terminal_state).toBe("timed_out");
		expect(sentMessages[0]?.message.details.timed_out).toBe(true);
		expect(sentMessages[0]?.message.details.exit_code).toBeUndefined();
		expect(sentMessages[0]?.message.details.output).toContain("before-timeout");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension reports stopped background terminals as cancelled completions", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let execTool: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-cancelled-completion",
			{ cmd: "printf before-cancel; sleep 60", yield_time_ms: 250, context_guard: false },
			undefined,
			undefined,
			ctx,
		);
		const sessionId = spawned.details.session_id;
		expect(sessionId).toBeNumber();

		await commands.get("stop").handler(String(sessionId), ctx);
		await Bun.sleep(500);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
		expect(sentMessages[0]?.message.details.session_id).toBe(sessionId);
		expect(sentMessages[0]?.message.details.terminal_state).toBe("cancelled");
		expect(sentMessages[0]?.message.details.cancelled).toBe(true);
		expect(sentMessages[0]?.message.details.exit_code).toBeUndefined();
		expect(sentMessages[0]?.message.details.output).toContain("before-cancel");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension reports nonzero background terminal exit as command completion", async () => {
	const { result, sentMessages } = await runExecCommandCompletionScenario(
		"sleep 0.3; printf failed; exit 7",
		"call-nonzero-finished-message",
	);

	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
	expect(sentMessages[0]?.message.details.session_id).toBe(result.details.session_id);
	expect(sentMessages[0]?.message.details.terminal_state).toBe("exited");
	expect(sentMessages[0]?.message.details.exit_code).toBe(7);
	expect(sentMessages[0]?.message.details.timed_out).toBeUndefined();
	expect(sentMessages[0]?.message.details.cancelled).toBeUndefined();
	expect(sentMessages[0]?.message.details.output).toBe("failed");
});

test("extension does not emit speculative events for idle-running background terminals", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-idle-running",
			{ cmd: "sleep 2", yield_time_ms: 250, context_guard: false },
			undefined,
			undefined,
			ctx,
		);
		expect(spawned.details.session_id).toBeNumber();

		await Bun.sleep(600);

		expect(sentMessages).toHaveLength(0);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("exec session manager reports spawn failures as session errors, not command exits", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
	});
	try {
		const result = await sessions.exec(
			{ cmd: "printf unreachable", shell: "/tmp/definitely-missing-pi-shell", yield_time_ms: 250 },
			process.cwd(),
		);

		expect(result.terminal_state).toBe("session_error");
		expect(result.session_error).toContain("definitely-missing-pi-shell");
		expect(result.exit_code).toBeUndefined();
		expect(result.output).toContain("definitely-missing-pi-shell");
	} finally {
		sessions.shutdown();
	}
});

test("extension completion message includes truncation metadata for large final output", async () => {
	const { result, sentMessages } = await runExecCommandCompletionScenario(
		"sleep 0.3; node -e \"process.stdout.write('x'.repeat(1000))\"",
		"call-truncated-finished-message",
	);

	expect(sentMessages).toHaveLength(1);
	expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
	expect(sentMessages[0]?.message.details.session_id).toBe(result.details.session_id);
	expect(sentMessages[0]?.message.details.exit_code).toBe(0);
	expect(sentMessages[0]?.message.details.output_truncated).toBe(true);
	expect(sentMessages[0]?.message.details.original_token_count).toBeNumber();
	expect(sentMessages[0]?.message.details.output).toContain("chars truncated");
	expect(sentMessages[0]?.message.content).toContain("chars truncated");
});

test("extension pushes completion after non-empty write_stdin interaction", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	let writeStdinTool: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeStdinTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-stdin-completion",
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const sessionId = spawned.details.session_id;
		expect(sessionId).toBeNumber();
		expect(spawned.details.stdin_open).toBe(true);
		expect(sentMessages).toHaveLength(0);

		const write = await writeStdinTool.execute(
			"write-stdin-completion",
			{ session_id: sessionId, chars: "hello\n", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(write.details.session_id).toBeUndefined();
		expect(write.details.exit_code).toBe(0);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.message.customType).toBe("exec_command.completed");
		expect(sentMessages[0]?.message.details.session_id).toBe(sessionId);
		expect(sentMessages[0]?.message.details.exit_code).toBe(0);
		expect(sentMessages[0]?.message.details.output).toContain("got:hello");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension hides empty poll output after rendering a background terminal completion message", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let execTool: any;
	let writeStdinTool: any;
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeStdinTool = definition;
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const spawned = await execTool.execute(
			"call-duplicated-output",
			{ cmd: "printf 'alpha\\n'; sleep 0.3; printf 'omega\\n'", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const sessionId = spawned.details.session_id;
		expect(sessionId).toBeNumber();

		await Bun.sleep(500);
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.message.details.output).toContain("omega");

		const poll = await writeStdinTool.execute(
			"poll-duplicated-output",
			{ session_id: sessionId, chars: "", yield_time_ms: 5000 },
			undefined,
			undefined,
			ctx,
		);
		expect(poll.details.output).toBe("omega\n");

		const renderedPoll = writeStdinTool
			.renderResult(poll, { expanded: false, isPartial: false }, testTheme, {
				args: { session_id: sessionId, chars: "" },
				state: {},
			})
			.render(120)
			.join("\n");
		expect(renderedPoll).toBe("");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("ps command opens a background terminal overlay", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let customOptions: any;
	let overlayText = "";
	let setFocusCalls = 0;
	const pi = {
		registerTool() {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	await commands.get("ps").handler("", {
		hasUI: true,
		ui: {
			custom(factory: any, options: any) {
				customOptions = options;
				const component = factory(
					{ terminal: { rows: 20 }, requestRender() {}, setFocus: () => setFocusCalls++ },
					{ fg: (_role: string, text: string) => text, bold: (text: string) => text },
					{},
					() => {},
				);
				overlayText = component.render(100).join("\n");
				return Promise.resolve();
			},
		},
	});

	expect(commands.get("ps").description).toBe("list background terminals");
	expect(customOptions.overlay).toBe(true);
	expect(customOptions.overlayOptions.width).toBe("90%");
	expect(customOptions.overlayOptions.minWidth).toBe(60);
	expect(setFocusCalls).toBe(0);
	expect(overlayText).toContain("background terminals");
	expect(overlayText).toContain("No background terminals");
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("stop command stops one background terminal and completes visible ids", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let execTool: any;
	let writeTool: any;
	const notifications: Array<{ message: string; type?: string }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus() {},
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const first = await execTool.execute(
			"call-stop-1",
			{ cmd: "sleep 60", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const second = await execTool.execute(
			"call-stop-2",
			{ cmd: "sleep 60", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const firstId = first.details.session_id;
		const secondId = second.details.session_id;
		expect(firstId).toBeNumber();
		expect(secondId).toBeNumber();

		expect(await commands.get("stop").getArgumentCompletions("")).toEqual([
			{ value: String(firstId), label: `#${firstId}`, description: "sleep 60" },
			{ value: String(secondId), label: `#${secondId}`, description: "sleep 60" },
		]);

		await commands.get("stop").handler(String(firstId), ctx);

		expect(notifications).toContainEqual({ message: `Stopped background terminal #${firstId}.`, type: "info" });
		await expect(
			writeTool.execute(
				"write-stopped",
				{ session_id: firstId, chars: "", yield_time_ms: 250 },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(`Unknown process id ${firstId}`);
		const pollSecond = await writeTool.execute(
			"write-running",
			{ session_id: secondId, chars: "", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(pollSecond.details.session_id).toBe(secondId);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("stop command warns for invalid ids without stopping sessions", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let execTool: any;
	let writeTool: any;
	const notifications: Array<{ message: string; type?: string }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
			if (definition.name === "write_stdin") writeTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus() {},
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		const result = await execTool.execute(
			"call-invalid-stop",
			{ cmd: "sleep 60", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		const sessionId = result.details.session_id;
		expect(sessionId).toBeNumber();

		await commands.get("stop").handler("999999", ctx);
		await commands.get("stop").handler("not-a-number", ctx);

		expect(notifications).toContainEqual({ message: "No background terminal with id 999999.", type: "warning" });
		expect(notifications).toContainEqual({ message: "Usage: /stop [id]", type: "warning" });
		const poll = await writeTool.execute(
			"write-after-invalid-stop",
			{ session_id: sessionId, chars: "", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(poll.details.session_id).toBe(sessionId);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("stop command without arguments stops all background terminals and clears status", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let execTool: any;
	const notifications: Array<{ message: string; type?: string }> = [];
	const statusCalls: Array<{ key: string; text: string | undefined }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		cwd: process.cwd(),
	};
	for (const handler of handlers.get("session_start") ?? []) handler(undefined, ctx);

	try {
		await execTool.execute("call-stop-all-1", { cmd: "sleep 60", yield_time_ms: 250 }, undefined, undefined, ctx);
		await execTool.execute("call-stop-all-2", { cmd: "sleep 60", yield_time_ms: 250 }, undefined, undefined, ctx);
		expect(statusCalls.at(-1)?.text).toBe("2 background terminals · 2 running");

		await commands.get("stop").handler("", ctx);

		expect(notifications).toContainEqual({ message: "Stopped 2 background terminals.", type: "info" });
		expect(statusCalls.at(-1)).toEqual({ key: "background-terminals", text: undefined });
		expect(await commands.get("stop").getArgumentCompletions("")).toBeNull();
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler(undefined, ctx);
	}
});

test("extension disables bash and activates exec_command plus write_stdin for every model", () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let activeTools = ["read", "bash"];
	const setActiveToolsCalls: string[][] = [];
	const pi = {
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => activeTools,
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "exec_command" }, { name: "write_stdin" }],
		setActiveTools: (next: string[]) => {
			activeTools = next;
			setActiveToolsCalls.push(next);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	for (const handler of handlers.get("session_start") ?? []) {
		handler(undefined, { model: { provider: "anthropic", id: "claude-sonnet" } });
	}

	expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
	expect(setActiveToolsCalls).toContainEqual(["read", "exec_command", "write_stdin"]);

	const block = handlers
		.get("tool_call")
		?.map((handler) => handler({ toolName: "bash" }, { model: { provider: "anthropic", id: "claude-sonnet" } }))
		.find((result) => result?.block);

	expect(block).toEqual({
		block: true,
		reason: "bash is disabled. Use exec_command instead.",
	});
	const writeBlock = handlers
		.get("tool_call")
		?.map((handler) =>
			handler({ toolName: "write_stdin" }, { model: { provider: "anthropic", id: "claude-sonnet" } }),
		)
		.find((result) => result?.block);
	expect(writeBlock).toBeUndefined();

	for (const handler of handlers.get("model_select") ?? []) {
		handler(undefined, { model: { provider: "anthropic", id: "claude-sonnet" } });
	}

	expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("exec_command keeps write_stdin active across non-interactive and tty runs", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	let activeTools = ["read", "bash"];
	let execTool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") execTool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => activeTools,
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "exec_command" }, { name: "write_stdin" }],
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		model: { provider: "anthropic", id: "claude-sonnet" },
		ui: { notify() {} },
	};
	for (const handler of handlers.get("session_start") ?? []) {
		handler(undefined, ctx);
	}
	try {
		await commands.get("rtk").handler("off", ctx);

		expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
		const nonTty = await execTool.execute(
			"call-non-tty",
			{ cmd: "sleep 0.5; printf done", yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(nonTty.details.session_id).toBeNumber();
		expect(nonTty.terminate).toBeUndefined();
		expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);

		const tty = await execTool.execute(
			"call-tty",
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			undefined,
			undefined,
			ctx,
		);
		expect(tty.details.session_id).toBeNumber();
		expect(tty.terminate).toBeUndefined();
		expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) handler();
	}
});

test("rtk command toggles default-on exec command wrapping", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const commands = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	let tool: any;
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			if (command === "which") return { code: 0, stdout: "/usr/local/bin/rtk\n", stderr: "" };
			return { code: 3, stdout: "printf rtk-wrapped\n", stderr: "" };
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		cwd: process.cwd(),
	};
	const rtkCommand = commands.get("rtk");
	expect(rtkCommand).toBeDefined();
	expect(await rtkCommand.getArgumentCompletions("o")).toEqual([
		{ value: "on", label: "on" },
		{ value: "off", label: "off" },
	]);

	const enabled = await tool.execute(
		"call-enabled",
		{ cmd: "printf original", yield_time_ms: 5000 },
		undefined,
		undefined,
		ctx,
	);

	expect(enabled.details.output).toBe("rtk-wrapped");
	expect(enabled.content[0].text).toContain("Command: printf original");
	expect(enabled.content[0].text).not.toContain("printf rtk-wrapped");
	expect(execCalls).toEqual([
		{ command: "which", args: ["rtk"] },
		{ command: "/usr/local/bin/rtk", args: ["rewrite", "printf original"] },
	]);
	expect(notifications.some((notice) => notice.message.startsWith("RTK rewrite:"))).toBe(false);

	for (const handler of handlers.get("tool_execution_start") ?? []) {
		handler({
			toolName: "exec_command",
			toolCallId: "call-render",
			args: { cmd: "printf original" },
		});
	}
	await tool.execute("call-render", { cmd: "printf original", yield_time_ms: 5000 }, undefined, undefined, ctx);
	for (const handler of handlers.get("tool_execution_end") ?? []) {
		handler({ toolName: "exec_command", toolCallId: "call-render" });
	}
	const renderedCall = tool
		.renderCall({ cmd: "printf original" }, testTheme, {
			toolCallId: "call-render",
			state: {},
			isPartial: false,
			invalidate() {},
		})
		.render(200)
		.join("\n");
	expect(renderedCall).toContain("<mdLink>\x1b[3mvia rtk\x1b[23m</mdLink>");
	expect(renderedCall).not.toContain("printf rtk-wrapped");

	await rtkCommand.handler("off", ctx);
	const off = await tool.execute("call-off", { cmd: "printf off", yield_time_ms: 5000 }, undefined, undefined, ctx);
	expect(off.details.output).toBe("off");
	expect(notifications).toContainEqual({ message: "RTK wrapping disabled.", type: "info" });

	await rtkCommand.handler("on", ctx);
	expect(notifications).toContainEqual({ message: "RTK wrapping enabled.", type: "info" });

	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("cg-wrap command toggles default-on Context Guard wrapping", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
	const originalSkipLocalBin = process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN;
	const commands = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	let tool: any;
	const notifications: Array<{ message: string; type?: string }> = [];
	const dir = mkdtempSync(join(tmpdir(), "exec-command-cg-wrap-toggle-"));
	const coreBin = join(dir, "context-guard-core.js");
	const logPath = join(dir, "requests.log");
	writeFileSync(
		coreBin,
		[
			`#!${process.execPath}`,
			"const fs = require('node:fs');",
			`const logPath = ${JSON.stringify(logPath)};`,
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', chunk => input += chunk);",
			"process.stdin.on('end', () => {",
			"  const request = JSON.parse(input);",
			"  fs.appendFileSync(logPath, JSON.stringify(request) + '\\n', 'utf8');",
			"  const text = request.command === 'batch' ? 'ignored' : '{}';",
			"  process.stdout.write(JSON.stringify({",
			"    ok: true,",
			"    content: [{ type: 'text', text }],",
			"    details: { results: [{ output: 'wrapped from core\\n', summary: 'ok', exitCode: 0 }] }",
			"  }));",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(coreBin, 0o755);
	process.env.CONTEXT_GUARD_BIN = coreBin;
	delete process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN;
	markExecCommandContextGuardEnabled();

	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		cwd: process.cwd(),
	};
	const toggle = commands.get("cg-wrap");
	expect(toggle).toBeDefined();
	expect(await toggle.getArgumentCompletions("o")).toEqual([
		{ value: "on", label: "on" },
		{ value: "off", label: "off" },
	]);

	try {
		const enabled = await tool.execute("call-cg-enabled", { cmd: "printf raw-disabled" }, undefined, undefined, ctx);
		expect(enabled.details.output).toBe("wrapped from core\n");

		await toggle.handler("off", ctx);
		const disabled = await tool.execute("call-cg-disabled", { cmd: "printf raw-enabled" }, undefined, undefined, ctx);
		expect(disabled.details.output).toBe("raw-enabled");
		expect(notifications).toContainEqual({ message: "Context Guard wrapping disabled.", type: "info" });

		await toggle.handler("on", ctx);
		expect(notifications).toContainEqual({ message: "Context Guard wrapping enabled.", type: "info" });

		const reenabled = await tool.execute(
			"call-cg-reenabled",
			{ cmd: "printf raw-disabled-again" },
			undefined,
			undefined,
			ctx,
		);
		expect(reenabled.details.output).toBe("wrapped from core\n");

		const coreRequests = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(coreRequests.filter((request) => request.command === "batch")).toHaveLength(2);
	} finally {
		if (originalCoreBin === undefined) {
			delete process.env.CONTEXT_GUARD_BIN;
		} else {
			process.env.CONTEXT_GUARD_BIN = originalCoreBin;
		}
		if (originalSkipLocalBin === undefined) {
			delete process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN;
		} else {
			process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN = originalSkipLocalBin;
		}
		resetExecCommandContextGuardEnabled();
		for (const handler of handlers.get("session_shutdown") ?? []) handler();
	}
});

test("rtk wrapping updates legacy command argument aliases", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const commands = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	let tool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools() {},
		exec: async (command: string) => {
			if (command === "which") return { code: 0, stdout: "/usr/local/bin/rtk\n", stderr: "" };
			return { code: 0, stdout: "printf alias-wrapped\n", stderr: "" };
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const ctx = { hasUI: false, ui: { notify() {} }, cwd: process.cwd() };
	const prepared = tool.prepareArguments({ command: "printf alias-original", yield_time_ms: 5000 });
	const result = await tool.execute("call-alias", prepared, undefined, undefined, ctx);

	expect(result.details.output).toBe("alias-wrapped");
	expect(result.content[0].text).toContain("Command: printf alias-original");

	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("rtk helper parses executable paths", () => {
	expect(parseRtkExecutablePath("'rtk path'\n")).toBe("rtk path");
});

test("rtk rewrite is allowed to rewrite rg commands", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			if (command === "which") return { code: 0, stdout: "/usr/local/bin/rtk\n", stderr: "" };
			return { code: 0, stdout: "rtk grep --files\n", stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "pwd && rg --files -g '!*node_modules*' | head -200", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("rtk grep --files");
	expect(execCalls).toEqual([
		{ command: "which", args: ["rtk"] },
		{
			command: "/usr/local/bin/rtk",
			args: ["rewrite", "pwd && rg --files -g '!*node_modules*' | head -200"],
		},
	]);
});

test("rtk grep rewrite of rg uses raw rg immediately", async () => {
	let tool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
	} as any;
	const tracker = createExecCommandTracker();
	const executedCommands: string[] = [];
	const sessions = {
		exec: async (input: { cmd: string }) => {
			executedCommands.push(input.cmd);
			return {
				chunk_id: "ok",
				wall_time_seconds: 0,
				output: "pi/agent/extensions/exec-command/tools/rtk-wrapper.ts\n",
				exit_code: 0,
			};
		},
		write: async () => {
			throw new Error("unexpected write");
		},
		hasSession: () => false,
		getSessionCommand: () => undefined,
		onSessionExit: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool(pi, tracker, sessions as any, {
		rewriteCommand: () => "pwd && rtk grep --files",
	});

	const result = await tool.execute(
		"call-rg-fallback",
		{ cmd: "rg --files pi/agent/extensions/exec-command/tools/rtk-wrapper.ts" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	expect(executedCommands).toEqual(["rg --files pi/agent/extensions/exec-command/tools/rtk-wrapper.ts"]);
	expect(result.details.output).toContain("rtk-wrapper.ts");
	expect(result.isError).toBe(false);
});

test("rtk grep rewrite of raw-only rg modes uses raw rg immediately", async () => {
	let tool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
	} as any;
	const tracker = createExecCommandTracker();
	const executedCommands: string[] = [];
	const sessions = {
		exec: async (input: { cmd: string }) => {
			executedCommands.push(input.cmd);
			return {
				chunk_id: "rg",
				wall_time_seconds: 0,
				output: "ripgrep 15.1.0\n",
				exit_code: 0,
			};
		},
		write: async () => {
			throw new Error("unexpected write");
		},
		hasSession: () => false,
		getSessionCommand: () => undefined,
		onSessionExit: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool(pi, tracker, sessions as any, {
		rewriteCommand: () => "rtk grep --version",
	});

	const result = await tool.execute("call-rg-version", { cmd: "rg --version" }, undefined, undefined, {
		cwd: process.cwd(),
	});

	expect(executedCommands).toEqual(["rg --version"]);
	expect(result.details.output).toContain("ripgrep");
	expect(result.isError).toBe(false);
});

test("non-rtk safety rewrites do not render a via rtk marker", async () => {
	let tool: any;
	const pi = {
		registerTool: (definition: any) => {
			if (definition.name === "exec_command") tool = definition;
		},
	} as any;
	const tracker = createExecCommandTracker();
	const sessions = {
		exec: async () => ({
			chunk_id: "git",
			wall_time_seconds: 0,
			output: "",
			exit_code: 0,
		}),
		write: async () => {
			throw new Error("unexpected write");
		},
		hasSession: () => false,
		getSessionCommand: () => undefined,
		onSessionExit: () => () => {},
		shutdown() {},
	};
	registerExecCommandTool(pi, tracker, sessions as any, {
		rewriteCommand: () => ({ command: "GIT_OPTIONAL_LOCKS=0 git status --short", rtkWrapped: false }),
	});

	await tool.execute("call-git-safety", { cmd: "git status --short" }, undefined, undefined, { cwd: process.cwd() });

	const renderedCall = tool
		.renderCall({ cmd: "git status --short" }, testTheme, {
			toolCallId: "call-git-safety",
			state: {},
			isPartial: false,
			invalidate() {},
		})
		.render(200)
		.join("\n");
	expect(renderedCall).not.toContain("via rtk");
});

test("rtk rewrite preserves returned shell-expanded path globs", async () => {
	const original = `rg -n "pub fn draw|fn draw" src/font/sprite/draw/*.zig`;
	const rewritten = `rtk rg -n "pub fn draw|fn draw" src/font/sprite/draw/*.zig`;
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			if (command === "which") return { code: 0, stdout: "/usr/local/bin/rtk\n", stderr: "" };
			return { code: 0, stdout: `${rewritten}\n`, stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, original, true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe(rewritten);
	expect(execCalls).toEqual([
		{ command: "which", args: ["rtk"] },
		{ command: "/usr/local/bin/rtk", args: ["rewrite", original] },
	]);
});

test("rtk rewrite adds optional-lock suppression to git commands without invoking rtk", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "rtk git status --short\n", stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "git status --short", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("GIT_OPTIONAL_LOCKS=0 git status --short");
	expect(execCalls).toEqual([]);
});

test("rtk rewrite does not wrap git write commands", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "rtk git add file.txt\n", stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "git add file.txt", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("GIT_OPTIONAL_LOCKS=0 git add file.txt");
	expect(execCalls).toEqual([]);
});

test("rtk rewrite applies git optional-lock suppression across shell segments", async () => {
	const pi = {
		exec: async () => {
			throw new Error("rtk should not be invoked for git commands");
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "git add file.txt && git status -sb", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe(
		"GIT_OPTIONAL_LOCKS=0 git add file.txt && GIT_OPTIONAL_LOCKS=0 git status -sb",
	);
});

test("rtk rewrite applies git optional-lock suppression inside shell scripts", async () => {
	const pi = {
		exec: async () => {
			throw new Error("rtk should not be invoked for git commands");
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "bash -lc 'git status --short'", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("bash -lc 'GIT_OPTIONAL_LOCKS=0 git status --short'");
});

test("rtk rewrite suppresses optional locks for explicit rtk git commands", async () => {
	const pi = {
		exec: async () => {
			throw new Error("rtk rewrite should not be invoked for explicit rtk commands");
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "rtk git status -sb", true);

	expect(decision.changed).toBe(true);
	expect(decision.rewrittenCommand).toBe("GIT_OPTIONAL_LOCKS=0 rtk git status -sb");
});

test("rtk rewrite leaves already-protected git commands raw", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "rtk git status --short\n", stderr: "" };
		},
	} as any;

	const decision = await computeRtkRewriteDecision(pi, "GIT_OPTIONAL_LOCKS=0 git status --short", true);

	expect(decision.changed).toBe(false);
	expect(decision.rewrittenCommand).toBe("GIT_OPTIONAL_LOCKS=0 git status --short");
	expect(execCalls).toEqual([]);
});

test("rtk rewrite does not wrap graphite or gh commands", async () => {
	const execCalls: Array<{ command: string; args?: string[] }> = [];
	const pi = {
		exec: async (command: string, args?: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "rtk gt up\n", stderr: "" };
		},
	} as any;

	const graphite = await computeRtkRewriteDecision(pi, "gt up", true);
	const github = await computeRtkRewriteDecision(pi, "gh pr view", true);

	expect(graphite.changed).toBe(false);
	expect(graphite.rewrittenCommand).toBe("gt up");
	expect(github.changed).toBe(false);
	expect(github.rewrittenCommand).toBe("gh pr view");
	expect(execCalls).toEqual([]);
});

test("extension truncates oversized non-exec tool results before session history", () => {
	type Handler = (event?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	execCommandExtension(pi);

	const toolResultHandlers = handlers.get("tool_result") ?? [];
	const output = `${"head\n"}${"x".repeat(200000)}${"\ntail"}`;
	const results = toolResultHandlers.map((handler) =>
		handler({
			toolName: "read",
			content: [{ type: "text", text: output }],
			details: undefined,
			isError: false,
		}),
	);

	const patch = results.find((result) => result?.content);
	const text = patch.content[0].text;
	expect(text).toStartWith("Total output lines: 3\n\nhead\n");
	expect(text).toContain("chars truncated");
	expect(text).toContain("\ntail");
	expect(text.length).toBeLessThan(41_000);
	expect(text.split("\n").every((line: string) => line.length <= 430)).toBe(true);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("exec session manager runs short non-interactive commands", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec({ cmd: "printf exec-command", yield_time_ms: 5000 }, process.cwd());
		expect(result.output).toBe("exec-command");
		expect(result.exit_code).toBe(0);
		expect(result.session_id).toBeUndefined();
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager uses middle truncation", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: "node -e \"process.stdout.write('x'.repeat(200000))\"", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output_truncated).toBe(true);
		expect(result.output).toStartWith("Total output lines: 1\n\n");
		expect(result.output).toContain("chars truncated");
		expect(result.output.length).toBeLessThan(41_000);
		expect(result.output.split("\n").every((line) => line.length <= 430)).toBe(true);
		expect(result.original_token_count).toBe(50000);
		expect("full_output_path" in result).toBe(false);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager keeps head and tail when truncating many output lines", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: "node -e \"for (let i = 0; i < 12000; i++) console.log('line ' + i)\"", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output_truncated).toBe(true);
		expect(result.output).toContain("Total output lines: 12000");
		expect(result.output).toContain("line 0\n");
		expect(result.output).toContain("line 11999");
		expect(result.output).not.toContain("line 6000\n");
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager preserves ANSI SGR color output", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: "printf '\\033[32m✓ green\\033[0m\\n'", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output).toBe("\u001b[32m✓ green\u001b[0m\n");
		expect(result.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager uses a non-color environment", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{
				cmd: '[ -z "$FORCE_COLOR" ] && fc=unset || fc="$FORCE_COLOR"; printf "%s|%s|%s" "$NO_COLOR" "$TERM" "$fc"',
				yield_time_ms: 5000,
			},
			process.cwd(),
		);
		expect(result.output).toBe("1|dumb|unset");
		expect(result.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager maps fish to the codex-compatible fallback shell", async () => {
	expect(resolveRuntimeShell("/opt/homebrew/bin/fish")).toBe(DEFAULT_EXEC_SHELL);
	if (process.platform === "darwin") {
		expect(DEFAULT_EXEC_SHELL).toBe("/bin/zsh");
	}

	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: 'printf "%s" "$SHELL"', shell: "/opt/homebrew/bin/fish", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output).toBe(DEFAULT_EXEC_SHELL);
		expect(result.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager lists running and exited-unread sessions with stdin capability", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const first = await sessions.exec({ cmd: "sleep 0.5; printf done", yield_time_ms: 250 }, process.cwd());
		expect(first.session_id).toBeNumber();

		expect(sessions.listSessions()).toEqual([
			{
				id: first.session_id!,
				command: "sleep 0.5; printf done",
				output: "",
				running: true,
				exitCode: undefined,
				stdinOpen: false,
				startedAtMs: expect.any(Number),
			},
		]);

		await waitForCondition(() => sessions.listSessions()[0]?.running === false);

		expect(sessions.listSessions()).toEqual([
			{
				id: first.session_id!,
				command: "sleep 0.5; printf done",
				output: "done",
				running: false,
				exitCode: 0,
				stdinOpen: false,
				startedAtMs: expect.any(Number),
			},
		]);

		const final = await sessions.write({ session_id: first.session_id!, chars: "", yield_time_ms: 250 });
		expect(final.output).toBe("done");
		expect(final.exit_code).toBe(0);
		expect(sessions.listSessions()).toEqual([]);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager lazily removes exited sessions when a new session starts", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const exited = await sessions.exec({ cmd: "sleep 0.4; printf done", yield_time_ms: 250 }, process.cwd());
		expect(exited.session_id).toBeNumber();

		await Bun.sleep(600);

		expect(sessions.listSessions()).toMatchObject([
			{
				id: exited.session_id!,
				running: false,
				output: "done",
			},
		]);

		const running = await sessions.exec({ cmd: "sleep 1", yield_time_ms: 250 }, process.cwd());
		expect(running.session_id).toBeNumber();
		expect(sessions.listSessions().map((session) => session.id)).toEqual([running.session_id!]);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager includes stdin capability in running results and snapshots", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const nonInteractive = await sessions.exec({ cmd: "sleep 1", yield_time_ms: 250 }, process.cwd());
		expect(nonInteractive.session_id).toBeNumber();
		expect(nonInteractive.stdin_open).toBe(false);
		expect(sessions.getSessionSnapshot(nonInteractive.session_id!)?.stdinOpen).toBe(false);

		const interactive = await sessions.exec(
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(interactive.session_id).toBeNumber();
		expect(interactive.stdin_open).toBe(true);
		expect(sessions.getSessionSnapshot(interactive.session_id!)?.stdinOpen).toBe(true);
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager marks tty-requested sessions as stdin open", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
	});
	try {
		const first = await sessions.exec(
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(first.session_id).toBeNumber();

		expect(sessions.listSessions()[0]).toMatchObject({
			id: first.session_id!,
			command: 'read line; printf "got:$line"',
			running: true,
			stdinOpen: true,
		});
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager stops one session without clearing other sessions or history", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
	});
	try {
		const first = await sessions.exec({ cmd: "sleep 60", yield_time_ms: 250 }, process.cwd());
		const second = await sessions.exec({ cmd: "sleep 60", yield_time_ms: 250 }, process.cwd());
		expect(first.session_id).toBeNumber();
		expect(second.session_id).toBeNumber();

		expect(sessions.stopSession(first.session_id!)).toBe(true);
		expect(sessions.stopSession(999_999)).toBe(false);
		expect(sessions.listSessions().map((session) => session.id)).toEqual([second.session_id!]);
		expect(sessions.getSessionCommand(first.session_id!)).toBe("sleep 60");
		expect(sessions.getSessionCommand(second.session_id!)).toBe("sleep 60");
	} finally {
		sessions.shutdown();
	}
});

test("exec session manager stops all sessions and notifies subscribers", async () => {
	const sessions = createExecSessionManager({
		defaultExecYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
	});
	const updates: number[] = [];
	const unsubscribe = sessions.onSessionUpdate(() => updates.push(sessions.listSessions().length));
	try {
		const first = await sessions.exec({ cmd: "sleep 60", yield_time_ms: 250 }, process.cwd());
		const second = await sessions.exec({ cmd: "sleep 60", yield_time_ms: 250 }, process.cwd());
		expect(first.session_id).toBeNumber();
		expect(second.session_id).toBeNumber();
		expect(sessions.listSessions()).toHaveLength(2);

		expect(sessions.stopAllSessions()).toBe(2);
		expect(sessions.listSessions()).toEqual([]);
		expect(updates).toContain(1);
		expect(updates).toContain(2);
		expect(updates.at(-1)).toBe(0);
	} finally {
		unsubscribe();
		sessions.shutdown();
	}
});

test("exec session manager can poll running sessions", async () => {
	const sessions = createExecSessionManager();
	try {
		const first = await sessions.exec({ cmd: "sleep 1; printf done", yield_time_ms: 250 }, process.cwd());
		expect(first.session_id).toBeNumber();
		const next = await sessions.write({
			session_id: first.session_id!,
			chars: "",
			yield_time_ms: 5000,
		});
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
		const first = await sessions.exec(
			{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(first.session_id).toBeNumber();
		const next = await sessions.write({
			session_id: first.session_id!,
			chars: "hi\n",
			yield_time_ms: 5000,
		});
		expect(next.output).toContain("got:hi");
		expect(next.exit_code).toBe(0);
	} finally {
		sessions.shutdown();
	}
});
