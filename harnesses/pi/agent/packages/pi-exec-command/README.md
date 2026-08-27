# pi-exec-command

`pi-exec-command` adds two Pi tools backed by the Rust
`exec_command_bridge` binary:

- `exec_command` starts a shell command.
- `write_stdin` sends input to, or polls, a running command.

The package can be used directly or through Code Mode. Code Mode decides where
the tools appear; this package owns their execution and semantic presentation,
including the shell command transcript and shell-specific action header.
Nested calls reuse the streaming command or terminal view, including TTY
projection and selective output expansion.

The package also provides a Process Hub for the current agent hierarchy. Open it with `/ps` or
the managed `processes.open` action (`alt+s` in this repository). The hub lists
commands owned by the current agent and its descendants, displays bounded pipe output, attaches
to retained PTY state, forwards terminal input, and exposes explicit interrupt
and terminate actions.

## Install

Build the bridge, then install the package from the repository root:

```sh
cargo build --release -p exec-command
pi install ./harnesses/pi/agent/packages/pi-exec-command
```

The binary resolver checks these paths in order:

1. `PI_EXEC_COMMAND_BINARY`, when set;
2. `target/release/exec_command_bridge`;
3. `target/debug/exec_command_bridge`.

The override must point to an executable file. For example:

```sh
PI_EXEC_COMMAND_BINARY=/tmp/exec_command_bridge pi
```

Without an override, build the bridge if Pi reports that it is missing.

## `exec_command`

The required argument is `cmd`. Optional arguments are:

| Argument | Behavior |
| --- | --- |
| `workdir` | Working directory, resolved relative to the current Pi session directory. It does not persist to later calls. |
| `shell` | Compatible shell executable. Defaults to Pi's configured shell, then `$SHELL`; Fish is replaced by zsh/bash/sh because `exec_command` accepts POSIX shell command grammar. |
| `tty` | Allocate a PTY and keep stdin open. Defaults to `false`. |
| `yield_time_ms` | How long to wait for the first result. Values are clamped to 250–30,000 ms; the default is 10,000 ms. |
| `max_output_tokens` | Approximate output limit (four characters per token). The newest output is retained when the limit is exceeded. Default: 10,000. |
| `login` | Use login-shell arguments on POSIX shells. Default: `true`. |

For a normal pipe command, stdout and stderr are combined in the result and
terminal control sequences are removed. PTY output is kept as received so
interactive programs can work.

While a call is waiting, new bridge output is published as bounded partial
tool results. Compact `exec_command` and `write_stdin` output keeps the newest
rows, with older rows available through the disclosure control. Pipe output
uses the shared streamed-output surface. `tty: true` uses `pi-libtui`'s
terminal projection, so carriage-return progress, cursor motion, erases,
colors, and wide glyphs render as terminal state instead of raw control bytes.
The authoritative final result replaces the partial preview.

POSIX shells run as `shell -lc command` when `login` is true and `shell -c
command` otherwise. `cmd.exe` uses `/d /s /c`; PowerShell and `pwsh` use
`-NoLogo -NoProfile -Command`.

If the command exits during the wait, the result includes its exit code. If it
is still running, the result includes a numeric `session_id`:

```json
{
  "cmd": "python -m http.server 8000",
  "tty": true,
  "yield_time_ms": 1000
}
```

Use the returned session ID with `write_stdin`:

```json
{
  "session_id": 1,
  "chars": "\u0003",
  "yield_time_ms": 1000
}
```

Successful `write_stdin` calls and results are transcript-silent. Their output
remains model-visible and the continuous terminal state remains available in
Process Hub; failures still render in the transcript.

The result also reports elapsed time, a chunk ID, whether output was
truncated, and the approximate original token count. A running command is
bounded by the 30-second wait limit even when it keeps producing output.

## `write_stdin`

`session_id` is required. `chars` is optional:

- Omit `chars`, or pass an empty string, to poll for output.
- Send input only to a session created with `tty: true`. Pipe sessions have no
  writable stdin.
- A write waits 250 ms by default. An empty poll starts at 30 seconds and
  backs off up to five minutes while the process remains active. Pass
  `yield_time_ms` to choose a different wait within those bounds.
- Polling a completed session replays its retained output. Up to 32 completed
  sessions and 64 KiB of output per session are retained.
- Writing to a completed or unknown session fails. The manager accepts at most
  64 active sessions.

Aborting a call or shutting down the extension terminates the command's
process group. The bridge is reaped only after its final output has been read.

## Process Hub

The Process Hub aggregates the session-local `ExecSessionManager`s owned by the
current agent and its descendants. It does not infer processes from transcript
text, share managers between agents, or own process lifetime. Each manager
publishes immutable bounded snapshots and raw PTY updates; the owning Rust
bridge remains authoritative for input, resize, interrupt, termination, exit,
and reap behavior.

While a process is running, its original `exec_command` transcript row stays
live from those same snapshots. A compact above-editor widget and status item
also show running processes when that row is offscreen; both disappear when no
processes remain active. The widget uses the terminal icon, renders a configurable
activity indicator and dimmed shell syntax for each process, and opens that
process directly in the Process Hub when clicked.

In the process list:

- `j`/`k`, arrows, and page keys move through processes;
- `enter` opens pipe output or attaches to a PTY;
- `i` sends `SIGINT` to the process group;
- `x` terminates the process group;
- `alt+s`, `q`, or `escape` closes the hub.

Pipe output supports normal and page scrolling. PTY mode forwards input
directly to the selected terminal and resizes the native PTY to its visible
viewport. During resize, the hub keeps the current projection until the first
native redraw bytes arrive, then applies the new dimensions before parsing
that redraw. Press `ctrl+]` to return to the process list. Recently completed
processes follow the same bounded 32-session retention used by `write_stdin`.

## Settings

If `pi-xsettings` is installed, edit `~/.pi/agent/xsettings.toml`:

```toml
[tools]
pi-exec-command.defaultOutputTokens = 10000
pi-exec-command.defaultExecYieldMs = 10000
pi-exec-command.defaultLoginShell = true

[appearance]
pi-exec-command.activityIndicator = "inherit"
pi-exec-command.processWidgetIndicator = "inherit"
```

Available output limits are `1000`, `2500`, `5000`, `10000`, `20000`, `50000`,
and `100000`. Available default exec waits are `1000`, `5000`, `10000`, and
`30000` milliseconds. The compiled defaults are the values in the example.

Without the xsettings host, the package uses those compiled defaults. Do not
create a second settings file. Saving settings republishes the tool
definitions; reload Pi when changing a default for an already-running bridge.

Running command rows inherit the shared `pi-libtui.activityIndicator` by default.
Set `pi-exec-command.activityIndicator = "off"` to remove only their indicator, or
select any shared indicator style as an Exec Command-specific override. The
shared text effect, speed, and smoothness settings still apply. Package-local
presentation overrides affect new renderers after settings are republished;
inherited global appearance changes remain live.

The Process Widget indicator follows the same choices through
`pi-exec-command.processWidgetIndicator`. It inherits the shared indicator by
default and updates live when changed.

## Architecture

| Concern | Owner |
| --- | --- |
| Pi registration and lifecycle | `src/extension.ts` |
| `exec_command` schema and call | `src/tools/exec-command/definition.ts` and `execute.ts` |
| `write_stdin` schema and call | `src/tools/write-stdin/definition.ts` and `execute.ts` |
| Session state, waits, limits, and replay | `src/session-manager.ts` |
| Process snapshots and explicit controls | `src/session-manager.ts` over the native bridge protocol |
| Bridge process and wire protocol | `src/bridge-client.ts` and `crates/exec-command` |
| Result/details model | `src/tools/result.ts` and `src/tools/presentation.ts` |
| TUI rendering | `src/ui/presentation.ts`, `src/ui/command-transcript.ts`, and `src/ui/shell-command-action.ts` map exec semantics onto `pi-libtui`'s generic streaming activity |
| Process Hub presentation | `src/ui/process-hub.ts` and `src/ui/process-store.ts` compose `pi-libtui` fullscreen, selection, scrollbar, and terminal primitives |
| Process Hub action | `src/contributions/actions.ts` via `pi-libactions/sdk`; managed keybindings own shortcuts |
| Code Mode adapter | `src/code-mode-adapters.ts` via `pi-code-mode/sdk` |
| Public capabilities | `src/index.ts` exports only the versioned presentation-details contract |

## Troubleshooting

- **Bridge missing:** run `cargo build --release -p exec-command`, or set
  `PI_EXEC_COMMAND_BINARY` to an executable bridge.
- **The command starts in the wrong directory:** pass `workdir`; a previous
  command's `cd` does not affect the next call.
- **Input is rejected:** start the command with `tty: true`.
- **Only the tail of output is visible:** raise `max_output_tokens`; output is
  deliberately bounded and the result reports `output_truncated: true`.
- **A session ID no longer works:** completed replay is bounded to the newest
  32 sessions and extension shutdown clears all sessions.
