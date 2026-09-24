# @luan.sh/pi-code-mode&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-code-mode)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-code-mode)

Code Mode adds two tools to Pi:

- `exec` runs restricted JavaScript that calls selected Pi tools through a
  `tools` object, so one model turn can compose several tool calls.
- `wait` collects more output from a running `exec` cell or terminates it.

Tools moved under `exec` are removed from Pi's direct tool list, which keeps
the model's tool catalog small. Other Pi extensions can make their tools
available inside `exec` through the SDK described below.

## Preview

![@luan.sh/pi-code-mode in Bootty](https://pi.luan.sh/media/previews/pi-code-mode-1fb9bf32cd5a.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-code-mode-90738a72b416.mp4).

## Install

```sh
pi install npm:@luan.sh/pi-code-mode
```

Requires a Rust toolchain (https://rustup.rs). The `code-mode-host` binary
builds itself on first use under Pi's agent directory
(`native/code-mode-host/<version>/`). Set `PI_CODE_MODE_HOST_BINARY` to use a
prebuilt binary.

Optional companion: `pi install npm:@luan.sh/pi-xsettings` adds the
`/xsettings` editor for the settings listed below; without it the defaults
apply.

## How the tool hierarchy works

Code Mode is the only component that decides whether a tool is direct or lives
under `exec`. At session start it lifts a tool only when all of these hold:

1. `pi-code-mode.enabled` is true.
2. `exec` is active. A strict `--tools` list must include `exec`.
3. The tool is active, registered, selected in `pi-code-mode.tools`, and has a
   Code Mode adapter (registered through the SDK).

Lifted tools disappear from Pi's direct tool list and become methods on
`tools` inside `exec`. They are never available in both places. An adapter
only describes how to invoke a tool; it cannot move the tool, change Code Mode
settings, or create another hierarchy.

If Code Mode is disabled, it removes `exec` and `wait` from the active set and
lifts nothing. If `exec` is not active, it removes the unusable `wait` tool and
leaves other tools alone. Session-tree navigation stops live cells without
changing the hierarchy; session shutdown releases it.

## Settings

Settings use the `@luan.sh/pi-code-mode` namespace and are edited with `/xsettings` when
`@luan.sh/pi-xsettings` is installed; otherwise the defaults apply.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Move selected direct tools under `exec`. |
| `tools` | `skill`, `web__run`, `exec_command`, `write_stdin`, `apply_patch`, `view_image` (each only if an adapter exists) | Unordered multi-select of tools available only through `exec`. |
| `defaultOutputTokens` | `10000` | Aggregate output token budget. Choices: 1000, 2500, 5000, 10000, 20000, 50000, 100000. |
| `defaultExecYieldMs` | `30000` | Initial `exec` yield time. Choices: 1000, 5000, 10000, 30000, 60000. |
| `defaultWaitYieldMs` | `10000` | Default `wait` yield time. Same choices. |

The `tools` picker lists every registered tool that has a Code Mode adapter,
including adapters supplied by other extensions. A selected name that is
inactive, unregistered, or unadapted is ignored; Code Mode never activates a
tool just because it is listed. Start a new session after changing the list so
the hierarchy is rebuilt.

Code Mode registers no keyboard actions.

## Using `exec`

The input is JavaScript source, not a JSON wrapper or Markdown fence. The host
runs it in a fresh async V8 isolate with no Node.js APIs, filesystem, network,
or `console`.

Nested tools are methods on the global `tools` object, with names normalized
to JavaScript identifiers (`mcp__server__tool` stays as is; other characters
become `_`):

```js
const status = await tools.exec_command({ cmd: "git status --short" });
text(status);
```

Independent calls can run concurrently:

```js
const [left, right] = await Promise.all([tools.first_tool({ value: "left" }), tools.second_tool({ value: "right" })]);
text({ left, right });
```

The `exec` tool description lists the exact nested declarations; those are the
authoritative names and input shapes.

Host globals: `text`, `image`, `generatedImage`, `store`, `load`, `notify`,
`exit`, `setTimeout`, `clearTimeout`, `yield_control`, and `ALL_TOOLS`.
`store`/`load` persist values across `exec` calls in the same session. With
the `openai-codex` provider the description also advertises an `audio(...)`
helper; other providers do not receive it.

A first-line pragma overrides one call's limits (only these two fields are
accepted):

```js
// @exec: {"yield_time_ms": 10000, "max_output_tokens": 2000}
text(await tools.some_tool({ query: "example" }));
```

`exec` returns a cell ID when the script is still running after the yield time.
Call `wait` with that ID:

```json
{"cell_id":"<id returned by exec>","yield_time_ms":10000}
```

`wait` returns only new output since the last yield. `terminate: true` stops
the cell. Omitted `max_tokens` and `yield_time_ms` fall back to the settings
above; `max_tokens` is capped at 100000.

Nested calls do not pass through Pi's `tool_call` or `tool_result` hooks. A
policy extension that must guard a tool on both paths needs a direct Pi hook
and a Code Mode preflight (see below).

Compact transcript mode shows nested tool components or the call's own result
directly and hides the Code Mode action row; Pi's expanded tool-output view
restores that row with `Code` and `Result` details. Failures always stay
visible. Successful `exec` calls with no output render nothing, and successful
`wait` calls update the original row instead of adding one. The `details`
payload on results is versioned and serializable: normalized input, timing,
output bounds, errors, and bounded nested call traces.

## SDK for other extensions

Depend on `@luan.sh/pi-code-mode` and import from `@luan.sh/pi-code-mode/sdk`
(UI-free). Registering an adapter makes a tool eligible for lifting; the user
still selects it in `pi-code-mode.tools`.

An ordinary Pi function tool registers with `registerCodeModeFunctionTool`.
The bridge reuses the tool's `execute`, `prepareArguments`, `renderCall`, and
`renderResult`, so direct and nested calls share one execution path:

```ts
import { registerCodeModeFunctionTool } from "@luan.sh/pi-code-mode/sdk";

const dispose = registerCodeModeFunctionTool(tool, {
  outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  resultValue: (result) => result.details,
});
```

`resultValue(result)` picks the JavaScript value returned to the script; use
it when `details` is a presentation model rather than the programmatic result.
The full result stays in the bounded nested trace for rendering.

Use `registerCodeModeToolAdapter` for freeform tools or behaviour a
`ToolDefinition` cannot express:

```ts
import { registerCodeModeToolAdapter } from "@luan.sh/pi-code-mode/sdk";

const dispose = registerCodeModeToolAdapter({
  name: "example_tool",
  kind: "function", // or "freeform" for a raw string input
  description: "Do one example operation.",
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  invoke(input, context, signal) {
    return runExampleTool(input, context.extensionContext, signal);
  },
});
```

Function adapters must provide `parameters`; freeform adapters receive a raw
string. `context` has `cwd`, `toolCallId`, `extensionContext`, and an optional
`onUpdate`. Optional members: `outputSchema`, `yieldTimeMs`, `prepareInput`,
`resultValue`, `renderTrace(trace, context)` (custom nested presentation),
`presentationKey(trace)` (share one transcript row across calls), and
`onScopeChange(scope)`, which lets an adapter observe and narrow the other
tools currently under `exec` without changing the hierarchy policy. Every
register function returns a dispose callback.

From the package root, `registerNestedToolPreflight(guard)` adds a policy
check for nested calls. The guard receives `{ toolName, input, cwd,
toolCallId, extensionContext, signal }` and may return `{ block: true, reason }`.
`listCodeModeToolNames()` returns the names currently lifted.

## Troubleshooting

- **A selected tool remains direct:** check that `exec` is active, the tool is
  active at session start, its adapter package is loaded, and the setting uses
  the exact Pi tool name.
- **`wait` is missing:** `exec` was not active, or Code Mode is disabled.
- **The host fails to build:** make sure `cargo` is on `PATH`, or set
  `PI_CODE_MODE_HOST_BINARY` to an executable host.
- **A nested call is blocked:** check preflight registrations; nested calls do
  not fire Pi's normal tool hooks.

## Layout

| Responsibility | File |
| --- | --- |
| Extension entry, settings wiring | `src/extension.ts` |
| Settings definitions | `src/contributions/xsettings.ts` |
| Hierarchy and session lifecycle | `src/runtime/lifecycle.ts`, `src/runtime/code-mode.ts` |
| Nested execution | `src/runtime/delegation.ts` |
| Adapter, hierarchy, preflight contracts and function-tool bridge | `src/protocol/` |
| Native host client and protocol | `src/host/` |
| `exec` / `wait` tool definitions | `src/tools/exec/`, `src/tools/wait/` |
| Transcript presentation | `src/ui/presentation.ts` |

## Develop

Source: https://github.com/luan/agents, directory
harnesses/pi/agent/packages/pi-code-mode. Run `bun run typecheck` and
`bun test test` in that directory.

## Persistent notebook companion

[`pi-notebook`](../pi-notebook/README.md) adds separate Deno cells with bindings,
checkpoints, and stored profiles. Code Mode continues to use a fresh restricted
V8 isolate for every `exec`; installing Notebook does not change that contract.
Its tools can be called through the normal Code Mode bridge.
