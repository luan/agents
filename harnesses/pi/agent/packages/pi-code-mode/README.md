# pi-code-mode

`pi-code-mode` adds two Pi tools:

- `exec` runs restricted JavaScript that can call selected tools through the
  `tools` object.
- `wait` collects more output from a running `exec` cell or terminates it.

## Install

Build the native host from the repository root, then install the package:

```sh
cargo build --release -p code-mode-host
pi install ./harnesses/pi/agent/packages/pi-code-mode
```

The extension looks for `target/release/code-mode-host`. Set
`PI_CODE_MODE_HOST_BINARY` when the host is somewhere else.

## Who owns the tool hierarchy

Code Mode is the only package that decides whether a tool is direct or lives
under `exec`.

At session start it lifts a tool only when all of these are true:

1. `pi-code-mode.enabled` is true.
2. `exec` is already active. A strict `--tools` list must include `exec`.
3. The tool is active, registered, selected in `pi-code-mode.tools`, and has a
   Code Mode execution adapter.

Lifted tools disappear from Pi's direct tool list and become methods on
`tools` inside `exec`. They are not available in both places. A tool package
can register its normal Pi tool and an execution adapter, but the adapter only
describes how to invoke it. It cannot move itself, change Code Mode settings,
or create another hierarchy.

The settings picker is built from adapters available at session start. This
means Code Mode does not need to know every extension in advance: an extension
that wants to be liftable registers the adapter contract from `pi-code-mode/sdk`.
Users can then select its exact tool name in xsettings.

If Code Mode is disabled, it removes `exec` and `wait` from the active set and
does not activate configured tools. If `exec` is not active, it removes the
unusable `wait` tool and leaves the other tools alone.

## Configure

`pi-xsettings` stores these values in `~/.pi/agent/xsettings.toml`:

```toml
[tools]
pi-code-mode.enabled = true
pi-code-mode.tools = ["skill", "web__run", "exec_command", "write_stdin", "apply_patch"]
pi-code-mode.defaultOutputTokens = 10000
pi-code-mode.defaultExecYieldMs = 30000
pi-code-mode.defaultWaitYieldMs = 10000
```

`tools` is an unordered multi-select. It contains every registered tool with a
Code Mode adapter, including adapters supplied by other extensions. Checked
tools are exec-only when they are also active. A name that is inactive,
unregistered, or unadapted is ignored; Code Mode never activates an omitted or
disabled tool just because it appears in a file. Reopen the session after
changing the list so the hierarchy is rebuilt.

The output choices are `1000`, `2500`, `5000`, `10000`, `20000`, `50000`, and
`100000` tokens. Yield choices are `1000`, `5000`, `10000`, `30000`, and
`60000` milliseconds.

## Using `exec`

The input is JavaScript source, not a JSON wrapper or Markdown fence. The
host runs it in a fresh async V8 isolate. It has no Node.js APIs, filesystem,
network, or `console` access.

Nested tools are methods on the global `tools` object. They are not top-level
Pi tools and their names are not JavaScript globals. For example:

```js
const status = await tools.exec_command({ cmd: "git status --short" });
text(status);
```

Independent calls can run concurrently with ordinary JavaScript:

```js
const [left, right] = await Promise.all([
  tools.first_tool({ value: "left" }),
  tools.second_tool({ value: "right" }),
]);
text({ left, right });
```

There is no `multi_tool_use.parallel` tool. Use `Promise.all` inside `exec`,
or call a separately registered top-level tool if one exists. The nested
declarations in the `exec` description are the authoritative names and input
shapes; do not invent a namespace such as `functions.exec`.

The host also provides `text`, `image`, `generatedImage`, `store`, `load`,
`notify`, `exit`, `setTimeout`, `clearTimeout`, `yield_control`, and
`ALL_TOOLS`. For `openai-codex`, it also advertises Codex's `audio(...)`
helper and the Codex Responses adapter serializes its result as `input_audio`.
Other providers do not receive that helper description because Pi's shared
provider contract does not yet carry audio tool results. A first-line pragma
can override one call's limits:

```js
// @exec: {"yield_time_ms": 10000, "max_output_tokens": 2000}
text(await tools.some_tool({ query: "example" }));
```

`exec` may return a cell ID when the code is still running. Call `wait` only
with that ID:

```json
{"cell_id":"<id returned by exec>","yield_time_ms":10000}
```

Set `terminate: true` to stop the cell. `wait` returns only new output since
the last yield. Its `max_tokens` and `yield_time_ms` values use the defaults
from xsettings when omitted.

Nested calls do not pass through Pi's `tool_call` or `tool_result` hooks. A
policy or safety extension that protects a tool on both paths must install a
direct Pi hook and a Code Mode preflight.

## Adapter API

An ordinary Pi function tool registers through the UI-free SDK's
`registerCodeModeFunctionTool`. The bridge reuses the tool's `execute`,
`renderCall`, and `renderResult` implementations, so direct and nested calls
have one execution path and one presentation owner:

```ts
import { registerCodeModeFunctionTool } from "pi-code-mode/sdk";

const dispose = registerCodeModeFunctionTool(tool, {
  outputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  resultValue: (result) => result.details,
});
```

Use the lower-level adapter only for freeform tools or behavior that cannot be
expressed by a Pi `ToolDefinition`:

```ts
import { registerCodeModeToolAdapter } from "pi-code-mode/sdk";

const dispose = registerCodeModeToolAdapter({
  name: "example_tool",
  kind: "function", // or "freeform" for a raw string input
  description: "Do one example operation.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  invoke(input, context, signal) {
    // Reuse the tool's normal execution path here.
    return runExampleTool(input, context.extensionContext, signal);
  },
});
```

Function adapters must provide `parameters`; freeform adapters receive a raw
string. `context` includes `cwd`, `toolCallId`, the Pi extension context, and
an optional `onUpdate` callback. An adapter may implement `onScopeChange` to
observe the other tools currently under `exec` (for example, `tool_search`),
but it must not change the hierarchy policy.

`resultValue(result)` may return the stable JavaScript value for a nested call.
Use it when `AgentToolResult.details` is a presentation model rather than the
tool's programmatic result. The complete result remains in the bounded nested
trace for rendering.

`renderTrace(trace, context)` is the lower-level presentation hook for a
nonstandard adapter. Ordinary function tools do not implement it: the shared
`ToolDefinition` bridge invokes their existing Pi renderers. Compact mode shows
nested components or the call's own result content directly; only the Code Mode
action row is hidden. Ctrl+O restores that row with expanded Code and Result
details, while failures keep it visible. Successful `exec` calls with no output
render nothing. Successful `wait` calls
forward nested trace updates to the original tool presentation and render no row of
their own. Successful nested `write_stdin` calls update the original
session-owning tool presentation while staying in the model-visible result and
Process Hub. A Code Mode cell whose only work is that continuation renders no
script or serialized result row. Failures remain visible. Activate a visible row to
open one section with explicit `Code` and `Result` tabs. The first shows
syntax-highlighted orchestration source; the second shows the parsed,
pretty-printed result. Compact mode never emits a separate `Code output` row or
raw argument/result JSON dump. Restored transcript rows use the same semantic
components, but only live executions claim continuation ownership because Pi
can reuse terminal session IDs and nested trace IDs after a restart.

Register nested policy checks with `registerNestedToolPreflight` from the
package root. The preflight receives the tool name, input, cwd, call ID, Pi
context, and abort signal; it can return `{ block: true, reason }`.

## Architecture map

| Role | Owner |
| --- | --- |
| Tool definitions | `src/tools/exec/definition.ts`, `src/tools/wait/definition.ts` |
| Hierarchy and session lifecycle | `src/runtime/lifecycle.ts` and `src/runtime/code-mode.ts` |
| Nested execution | `src/runtime/delegation.ts` |
| Native boundary | `src/host/` and the `code-mode-host` binary |
| State owner | `CodeModeRuntime`; the native host owns live cells |
| Presentation owner | `src/ui/presentation.ts` composes semantic child renderers and generic `pi-libtui` activities |
| Public capabilities | `pi-code-mode/sdk` adapter, hierarchy, and preflight contracts |

The `details` payload on `exec` and `wait` is versioned and serializable. It
contains normalized input, timing, output bounds, errors, and bounded nested
call traces.

## Troubleshooting

- **A selected tool remains direct:** check that `exec` is active, the tool is
  active at session start, its adapter package is loaded, and the setting uses
  the exact Pi tool name.
- **`wait` is missing:** `exec` was not active, or Code Mode is disabled.
- **The settings picker does not show a tool:** its package has not registered
  the Pi tool and a Code Mode adapter yet. A tool may appear in the picker while
  inactive, but it is lifted only when the session activates it.
- **The host cannot be found:** run `cargo build --release -p code-mode-host`
  or set `PI_CODE_MODE_HOST_BINARY` to an executable host.
- **A nested call is blocked:** check Code Mode preflight registrations as well
  as the direct-call hook; nested execution does not fire Pi's normal tool
  hooks.

## Validation

```sh
bun run --cwd=harnesses/pi/agent/packages/pi-code-mode typecheck
bun test --cwd=harnesses/pi/agent/packages/pi-code-mode
cargo build --release -p code-mode-host
```

From the repository root, `just check` runs the aggregate TypeScript, Rust,
and harness checks.
