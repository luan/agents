import { expect, test } from "bun:test";
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
  const rendered = renderExecCommandCall(
    `bash -lc 'git status --short'`,
    "running",
    testTheme,
  );
  expect(rendered).toBe(
    `<dim>•</dim> <bold>Running</bold> <syntaxFunction>git</syntaxFunction> status <syntaxKeyword>--short</syntaxKeyword>`,
  );
});

test("write stdin call uses unwrapped command previews", () => {
  const rendered = renderWriteStdinCall(
    3,
    "",
    `bash -lc 'git status --short'`,
    testTheme,
  );
  expect(rendered).toBe(
    `<success>• </success><bold>Waited for background terminal</bold><dim> · </dim><muted>git status --short</muted>`,
  );
});

test("running terminal calls show elapsed time", () => {
  expect(formatElapsedTime(65_400)).toBe("1m 05s");
  expect(
    renderExecCommandCall("sleep 60", "running", testTheme, false, 65_400),
  ).toBe(
    `<dim>•</dim> <bold>Running</bold> <syntaxFunction>sleep</syntaxFunction> 60<dim> · 1m 05s</dim>`,
  );
  expect(
    renderWriteStdinCall(
      3,
      "",
      "sleep 60",
      testTheme,
      "running",
      false,
      65_400,
    ),
  ).toBe(
    `<dim>• </dim><bold>Waiting for background terminal</bold><dim> · 1m 05s</dim><dim> · </dim><muted>sleep 60</muted>`,
  );
});

test("exec command call renders failed status as a red dot", () => {
  const rendered = renderExecCommandCall("false", "done", testTheme, true);
  expect(rendered).toBe(
    `<error>•</error> <bold>Ran</bold> <syntaxFunction>false</syntaxFunction>`,
  );
});

test("output block keeps a vertical gutter and preserves ANSI color", () => {
  const rendered = renderOutputBlock(
    "plain\n\u001b[32m✓ green\u001b[0m\n",
    testTheme,
  );
  expect(rendered).toBe(
    `<dim>  ├ </dim><dim>plain</dim>\n<dim>  └ </dim>\u001b[32m✓ green\u001b[0m`,
  );
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
    registerWriteStdinTool(
      { registerTool: (definition: any) => (tool = definition) } as any,
      sessions,
    );

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

test("exec session manager runs short non-interactive commands", async () => {
  const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
  try {
    const result = await sessions.exec(
      { cmd: "printf codex-exec", yield_time_ms: 5000 },
      process.cwd(),
    );
    expect(result.output).toBe("codex-exec");
    expect(result.exit_code).toBe(0);
    expect(result.session_id).toBeUndefined();
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

test("exec session manager enables color output for non-tty commands", async () => {
  const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 5000 });
  try {
    const result = await sessions.exec(
      { cmd: 'printf %s "$FORCE_COLOR"', yield_time_ms: 5000 },
      process.cwd(),
    );
    expect(result.output).toBe("1");
    expect(result.exit_code).toBe(0);
  } finally {
    sessions.shutdown();
  }
});

test("exec session manager can poll running sessions", async () => {
  const sessions = createExecSessionManager();
  try {
    const first = await sessions.exec(
      { cmd: "sleep 1; printf done", yield_time_ms: 250 },
      process.cwd(),
    );
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
