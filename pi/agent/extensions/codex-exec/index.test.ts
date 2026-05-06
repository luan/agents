import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import codexExecExtension from "./index.ts";
import {
	formatElapsedTime,
	type RenderTheme,
	renderExecCommandCall,
	renderOutputBlock,
	renderWriteStdinCall,
} from "./tools/codex-rendering.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";

const testTheme: RenderTheme = {
	fg: (role, text) => `<${role}>${text}</${role}>`,
	bold: (text) => `<bold>${text}</bold>`,
};

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

test("exec command call renders Codex-style inline syntax-highlighted commands", () => {
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

test("exec command call unwraps simple shell wrappers before rendering", () => {
	const rendered = renderExecCommandCall(`bash -lc 'git status --short'`, "running", testTheme);
	expect(rendered).toBe(
		`<dim>•</dim> <bold>Running</bold> <syntaxFunction>git</syntaxFunction> status <syntaxKeyword>--short</syntaxKeyword>`,
	);
});

test("exec command call limits very long command lines", () => {
	const rendered = renderExecCommandCall(`printf ${"x".repeat(300)}`, "done", testTheme);
	expect(rendered).toEndWith("...");
	expect(rendered).not.toContain("x".repeat(200));
});

test("write stdin call uses unwrapped command previews", () => {
	const rendered = renderWriteStdinCall(3, "", `bash -lc 'git status --short'`, testTheme);
	expect(rendered).toBe(
		`<success>• </success><bold>Waited for background terminal</bold><dim> · </dim><muted>git status --short</muted>`,
	);
});

test("running terminal calls show elapsed time", () => {
	expect(formatElapsedTime(65_400)).toBe("1m 05s");
	expect(renderExecCommandCall("sleep 60", "running", testTheme, false, 65_400)).toBe(
		`<dim>•</dim> <bold>Running</bold> <syntaxFunction>sleep</syntaxFunction> 60<dim> · 1m 05s</dim>`,
	);
	expect(renderWriteStdinCall(3, "", "sleep 60", testTheme, "running", false, 65_400)).toBe(
		`<dim>• </dim><bold>Waiting for background terminal</bold><dim> · 1m 05s</dim><dim> · </dim><muted>sleep 60</muted>`,
	);
});

test("yielded background exec calls do not keep scheduling elapsed redraws", () => {
	let tool: any;
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	try {
		registerExecCommandTool({ registerTool: (definition: any) => (tool = definition) } as any, tracker, sessions);
		tracker.recordStart("call", "sleep 60");
		tracker.recordPersistentSession("call", 7);

		const state: { elapsedTimer?: ReturnType<typeof setTimeout> } = {};
		tool.renderCall({ cmd: "sleep 60" }, testTheme, {
			toolCallId: "call",
			state,
			isPartial: false,
			invalidate: () => {
				throw new Error("final background row should not schedule redraws");
			},
		});

		expect(state.elapsedTimer).toBeUndefined();
	} finally {
		tracker.clear();
		sessions.shutdown();
	}
});

test("exec command call renders failed status as a red dot", () => {
	const rendered = renderExecCommandCall("false", "done", testTheme, true);
	expect(rendered).toBe(`<error>•</error> <bold>Ran</bold> <syntaxFunction>false</syntaxFunction>`);
});

test("output block keeps a vertical gutter and preserves ANSI color", () => {
	const rendered = renderOutputBlock("plain\n\u001b[32m✓ green\u001b[0m\n", testTheme);
	expect(rendered).toBe(`<dim>  ├ </dim><dim>plain</dim>\n<dim>  └ </dim>\u001b[32m✓ green\u001b[0m`);
});

test("output block preserves plain line spacing", () => {
	const rendered = renderOutputBlock("  indented  ", testTheme);
	expect(rendered).toBe("<dim>  └ </dim><dim>  indented  </dim>");
});

test("output block limits very long plain lines", () => {
	const rendered = renderOutputBlock("x".repeat(300), testTheme);
	expect(rendered).toBe(`<dim>  └ </dim><dim>${"x".repeat(217)}...</dim>`);
});

test("output block collapses large output in the middle", () => {
	const rendered = renderOutputBlock(
		Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"),
		testTheme,
		undefined,
		{ maxLines: 5 },
	);

	expect(rendered).toBe(
		[
			"<dim>  ├ </dim><dim>line 1</dim>",
			"<dim>  │ </dim><dim>line 2</dim>",
			"<dim>  │ </dim><dim>… +4 lines</dim>",
			"<dim>  │ </dim><dim>line 7</dim>",
			"<dim>  └ </dim><dim>line 8</dim>",
		].join("\n"),
	);
});

test("output block marks token-truncated output at the top", () => {
	const rendered = renderOutputBlock("tail", testTheme, undefined, {
		truncatedAbove: true,
		originalTokenCount: 1234,
	});

	expect(rendered).toBe(
		"<dim>  ├ </dim><dim>… output truncated above (original ~1234 tokens)</dim>\n<dim>  └ </dim><dim>tail</dim>",
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
		expect(rendered).toContain("<dim>  ├ </dim><dim>visible output</dim>");
		expect(rendered).toContain("<dim>  └ </dim><dim>next line</dim>");
		expect(rendered).not.toContain("Exit code: 0");
	} finally {
		sessions.shutdown();
	}
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

test("shutdown terminates descendant processes that escaped the shell process group", async () => {
	const marker = `codex-exec-shutdown-descendant-${process.pid}-${Date.now()}`;
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
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	codexExecExtension(pi);

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

test("extension disables bash for Codex models and blocks direct bash calls", () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	let activeTools = ["read", "bash"];
	const setActiveToolsCalls: string[][] = [];
	const pi = {
		registerTool() {},
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
	codexExecExtension(pi);

	for (const handler of handlers.get("session_start") ?? []) {
		handler(undefined, { model: { provider: "openai", id: "codex-mini-latest" } });
	}

	expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
	expect(setActiveToolsCalls).toContainEqual(["read", "exec_command", "write_stdin"]);

	const block = handlers
		.get("tool_call")
		?.map((handler) => handler({ toolName: "bash" }, { model: { provider: "openai", id: "codex-mini-latest" } }))
		.find((result) => result?.block);

	expect(block).toEqual({
		block: true,
		reason: "bash is disabled for Codex models. Use exec_command instead.",
	});

	for (const handler of handlers.get("model_select") ?? []) {
		handler(undefined, { model: { provider: "anthropic", id: "claude-sonnet" } });
	}

	expect(activeTools).toEqual(["read", "bash"]);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

test("extension truncates oversized non-exec tool results before session history", () => {
	type Handler = (event?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	codexExecExtension(pi);

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
	expect(text).toContain("tokens truncated");
	expect(text).toContain("\ntail");
	expect(text.length).toBeLessThan(41_000);
	for (const handler of handlers.get("session_shutdown") ?? []) handler();
});

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

test("exec session manager uses Codex-style middle truncation", async () => {
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
	try {
		const result = await sessions.exec(
			{ cmd: "node -e \"process.stdout.write('x'.repeat(200000))\"", yield_time_ms: 5000 },
			process.cwd(),
		);
		expect(result.output_truncated).toBe(true);
		expect(result.output).toStartWith("Total output lines: 1\n\n");
		expect(result.output).toContain("tokens truncated");
		expect(result.output.length).toBeLessThan(41_000);
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

test("exec session manager uses Codex-style non-color environment", async () => {
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
