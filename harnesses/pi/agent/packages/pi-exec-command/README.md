# @luan.sh/pi-exec-command&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-exec-command)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-exec-command)

Bounded shell execution for Pi with persistent PTY sessions, backed by the
native `terminal-bridge` binary. `exec_command` starts a shell command and
returns output or a session ID; `write_stdin` sends input to, or polls, a
running command. A Process Hub lists the commands owned by the current agent
and its subagents, shows their bounded output, attaches to retained PTY state,
forwards terminal input, and exposes interrupt and terminate actions.
## Preview

![@luan.sh/pi-exec-command in Bootty](https://pi.luan.sh/media/previews/pi-exec-command-bdc338239909.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-exec-command-00eaa4fd94c5.mp4).

## Install

```sh
pi install npm:@luan.sh/pi-exec-command
```

Requires a Rust toolchain (https://rustup.rs). The `terminal-bridge` binary
builds itself on first use under Pi's agent directory
(`native/terminal-bridge/<version>/`). Set `PI_TERMINAL_BRIDGE_BINARY` to use
a prebuilt binary; it must point to an executable file.

Optional companions:

- `pi install npm:@luan.sh/pi-xsettings` adds a `/xsettings` UI for the
  settings below; without it the compiled defaults apply.
- `pi install npm:@luan.sh/pi-panels` lets the Process Hub open as a side
  panel tab; without it the hub opens as a fullscreen overlay.
- `pi install npm:@luan.sh/pi-subagents` lets the hub include processes owned
  by descendant agents; without it the hub shows only the current session.

## `exec_command`

Pi 0.99 codemode scripts receive structured results from `exec_command` and
`write_stdin`, including `output`, `exit_code`, and `session_id`.

`cmd` is required. Optional arguments:

| Argument | Behavior |
| --- | --- |
| `workdir` | Working directory, resolved relative to the current Pi session directory. It does not persist to later calls. |
| `shell` | Shell executable. Defaults to Pi's configured shell, then `$SHELL`. Fish is replaced by zsh/bash/sh (macOS prefers `/bin/zsh`, other platforms `/bin/bash`) because `exec_command` accepts POSIX shell command grammar. On Windows, Git Bash is located under Program Files or `%LOCALAPPDATA%`. |
| `tty` | Allocate a PTY and keep stdin open. Default `false`. |
| `yield_time_ms` | How long to wait for the first result. Clamped to 250–30,000 ms; default 10,000 ms. |
| `max_output_tokens` | Approximate output limit (four characters per token). The newest output is kept when exceeded. Default 10,000. |
| `login` | Use login-shell arguments on POSIX shells. Default `true`. |

`command` and `cwd` are accepted as aliases for `cmd` and `workdir`.

POSIX shells run as `shell -lc command` when `login` is true and `shell -c
command` otherwise. `cmd.exe` uses `/d /s /c`; PowerShell and `pwsh` use
`-NoLogo -NoProfile -Command`.

For a pipe command, stdout and stderr are combined and terminal control
sequences are removed. PTY output is kept as received so interactive programs
work. While a call waits, new output is published as bounded partial results:
a syntax-colored `$ command` header, a live indicator, right-aligned metadata,
and the newest output rows, with older rows behind a disclosure control.
`tty: true` renders through a terminal projection, so carriage-return progress,
cursor motion, erases, colors, and wide glyphs display as terminal state rather
than raw control bytes. The final result replaces the preview.

Commands that only read, list, or search (`cat`, `sed -n`, `head`, `ls`,
`tree`, `rg`, `grep`, `fd`, `find`, `git grep`, and similar, including
`cd`/`bash -c` prefixes and pipelines through formatting stages) render as
`Exploring`/`Explored` with one row per step (`Read app.rs, lib.rs`,
`Search query in path`, `List path`). Commands with output redirection,
in-place edits, `-exec`/`-delete`, control flow, or substitutions render as a
plain command.

If the command exits during the wait, the result includes its exit code.
Otherwise it includes a numeric `session_id`:

```json
{ "cmd": "python -m http.server 8000", "tty": true, "yield_time_ms": 1000 }
```

Use that ID with `write_stdin`:

```json
{ "session_id": 1, "chars": "\u0003", "yield_time_ms": 1000 }
```

Every result also reports elapsed wall time, a chunk ID, `output_truncated`,
and the approximate original token count. A single call never waits longer
than 30 seconds, even for a command that keeps producing output.

## `write_stdin`

`session_id` is required. `chars` is optional:

- Omit `chars`, or pass an empty string, to poll for output.
- Input is only accepted by sessions started with `tty: true`; pipe sessions
  have no writable stdin.
- A write waits 250 ms by default. An empty poll starts at 30 seconds and
  backs off up to five minutes while the process stays active. Pass
  `yield_time_ms` to choose a wait within those bounds.
- Polling a completed session replays its retained output. Up to 32 completed
  sessions and 64 KiB of output per session are retained.
- Writing to a completed or unknown session fails. At most 64 sessions may be
  active at once.

Successful `write_stdin` calls are transcript-silent: their output stays
model-visible and the live terminal state stays available in the Process Hub.
Failures still render. Aborting a call or shutting down the extension
terminates the command's process group and clears all sessions; the bridge
process is reaped only after its final output has been read.

## Process Hub

Open the hub with the `/ps` command or the `processes.open` action. Inside a
side-panel host, `Processes` also appears as an empty-panel action. The hub
aggregates the exec sessions of the current agent and its descendants; it does
not infer processes from transcript text or own process lifetime, and the
native bridge stays authoritative for input, resize, interrupt, termination,
exit, and reaping.

The original `exec_command` transcript row stays live. When it is offscreen, a
compact above-editor widget and a `processes` status item show processes that
have been running for more than three seconds. Each visible row stays for at
least three seconds, showing its exit state if it finishes during that window.
The status clears when no displayed processes are running; the widget clears
when the last row expires. Clicking a process in the widget opens it in the hub.

Process list keys:

- `j`/`k`, arrows, `ctrl+u`/`ctrl+d`, page keys, `home`/`end`, `gg`/`G` move;
- `enter` opens pipe output or attaches to a PTY;
- `i` sends `SIGINT` to the process group;
- `x` terminates the process group;
- `alt+s`, `q`, or `escape` closes the hub.

Pipe output view: `j`/`k` scroll, `ctrl+u`/`ctrl+d` page, `G` follows the
tail, `i`/`x` interrupt/terminate, and `ctrl+]`, `escape`, `q`, `h`, or left
return to the list. PTY view: input is forwarded to the terminal, the native
PTY is resized to the visible viewport (capped at 500x200), and `ctrl+]`
returns to the list. Completed processes follow the same 32-session retention
as `write_stdin`. Embedded terminals advertise `TERM=xterm-256color` and
`COLORTERM=truecolor` even when Pi was launched from a reduced environment.

## Keybindings

`processes.open` has no default key. Bind it in Pi's agent directory, normally
`~/.pi/agent/keybindings.json`, where each property is an action ID and each
value is a key ID string or an array of them:

```json
{
  "processes.open": "alt+s"
}
```

## Settings

Settings live in the `@luan.sh/pi-exec-command` namespace and are edited via
`/xsettings` when `@luan.sh/pi-xsettings` is installed; otherwise the defaults
apply. Changes apply live and republish the tool definitions.

| Key | Default | Choices |
| --- | --- | --- |
| `defaultOutputTokens` | `10000` | `1000`, `2500`, `5000`, `10000`, `20000`, `50000`, `100000` |
| `defaultExecYieldMs` | `10000` | `1000`, `5000`, `10000`, `30000` |
| `defaultLoginShell` | `true` | `true`, `false` |
| `activityIndicator` | `"off"` | `"inherit"` or any shared TUI indicator style |
| `processWidgetIndicator` | `"inherit"` | `"inherit"` or any shared TUI indicator style |
| `processHubPresentation` | `"side-panel"` | `"side-panel"`, `"fullscreen"` |

`activityIndicator` overrides the indicator on running `exec_command` rows and
takes effect for new renderers; `processWidgetIndicator` updates the compact
widget live. `"side-panel"` falls back to the fullscreen overlay when no
side-panel host is present.

## Layout

| Responsibility | File |
| --- | --- |
| Pi registration, lifecycle, `/ps` command | `src/extension.ts` |
| Tool schemas and calls | `src/tools/exec-command/`, `src/tools/write-stdin/` |
| Sessions, waits, limits, replay, process snapshots | `src/session-manager.ts` |
| Shell resolution and Fish fallback | `src/runtime-shell.ts` |
| Output bounding and control-sequence stripping | `src/output.ts` |
| Result/details contract | `src/tools/result.ts`, `src/tools/presentation.ts` |
| Read/list/search classification | `src/core/shell-summary.ts` |
| Transcript rendering | `src/ui/presentation.ts`, `src/ui/command-transcript.ts`, `src/ui/shell-command-action.ts` |
| Process Hub, widget, store | `src/ui/process-hub*.ts`, `src/ui/process-store.ts`, `src/ui/process-widget.ts` |
| `processes.open` action, session hierarchy, settings | `src/contributions/` |
| Public exports (presentation contract only) | `src/index.ts` |

## Develop

Source: https://github.com/luan/agents, directory
harnesses/pi/agent/packages/pi-exec-command. Run `bun run typecheck` and
`bun test test` in that directory.
