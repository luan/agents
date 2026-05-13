# Spawn / mosaic compatibility smoke evidence

Date: 2026-05-13

Environment:

- Repository: `/Users/luan.santos/src/agents`
- tmux: `tmux 3.6a`
- Active tmux context: session `agents`, pane `%1115`
- zellij: not installed on this machine

## tmux live smoke

These checks used the active Pi tool surfaces and then cleaned up the spawned
tmux panes.

### `spawn_lane` command lane

Request:

```json
{
  "runtime": "command",
  "placement": "new-window",
  "mux": "tmux",
  "name": "smoke-command-20260513",
  "command": "printf 'spawn command smoke ok\\n'",
  "cwd": "/Users/luan.santos/src/agents"
}
```

Result:

```text
Spawned command root lane: smoke-command-20260513
Pane: %1116
Window: agents:5
spawn command smoke ok
[spawn command exited with 0]
```

Cleanup: `tmux kill-pane -t %1116`.

### `spawn_lane` shell lane

Request:

```json
{
  "runtime": "shell",
  "placement": "new-window",
  "mux": "tmux",
  "name": "smoke-shell-20260513",
  "cwd": "/Users/luan.santos/src/agents"
}
```

Probe sent to pane `%1117`:

```bash
printf 'spawn shell smoke ok\n'
```

Result:

```text
spawn shell smoke ok
```

Cleanup: `tmux kill-pane -t %1117`.

### `spawn_lane` direct Pi lane

Request:

```json
{
  "runtime": "pi",
  "payload": "direct",
  "relation": "child",
  "placement": "new-window",
  "mux": "tmux",
  "name": "smoke-direct-20260513",
  "goal": "Spawn direct smoke test",
  "prompt": "Smoke test only. Reply exactly: spawn direct smoke ok",
  "cwd": "/Users/luan.santos/src/agents"
}
```

Result:

```text
Spawned direct child lane: smoke-direct-20260513
Pane: %1118
Window: agents:5
spawn direct smoke ok
```

Cleanup: `tmux kill-pane -t %1118`.

### `Agent` with `run_in_background`

Request:

```json
{
  "subagent_type": "general-purpose",
  "description": "Mosaic background smoke",
  "prompt": "Smoke test only. Reply exactly: agent background smoke ok. Do not use tools.",
  "run_in_background": true,
  "max_turns": 1,
  "thinking": "off"
}
```

Result:

```text
Agent started as a full mosaic target.
Agent ID: 9b76433b-aac3-42e
Window: mc: Mosaic background smoke (@1075)
Pane: %1119

agent background smoke ok
```

Cleanup: `tmux kill-pane -t %1119`.

## zellij evidence

Live zellij smoke was not possible because `zellij` is not installed in this
environment. Command-shape coverage is provided by:

- `pi/agent/extensions/shared/lane-placement.test.ts`
- `pi/agent/extensions/mosaic/multiplexer.test.ts`

Covered zellij paths:

- `new-tab` for `new-window`
- `new-pane` for `split-pane`
- background session + tab for `hidden`
- mosaic full-session launch routed through split-pane placement when zellij is
  active, and hidden placement when zellij is only installed

## Reloaded tool-entrypoint retest

Date: 2026-05-13, after extension reload.

Entrypoints exercised:

- `spawn_lane`
  - command + hidden tmux: passed (`%1122`, cleaned up)
  - shell + split-pane tmux: passed (`%1123`, cleaned up)
  - Pi direct + new-window tmux: passed (`%1124`, cleaned up)
  - explicit zellij: graceful unavailable response because `zellij` is not installed
  - hidden PTY alias: design changed after this retest; `mux=pty` now requires
    zellij and opens a hidden zellij session instead of starting a local PTY
    process. A later live retest confirmed this path creates a hidden zellij
    session; source now wraps owned sessions with cleanup so they self-delete
    after the launched process exits.
- `spawn_list`: passed; rendered hidden tmux and legacy records.
- `spawn_map`: passed; rendered Pi session topology only.
- `Agent` with `run_in_background`: passed (`%1125`, cleaned up).
- `steer_subagent`: passed against the full mosaic target.
- `get_subagent_result`: passed and returned final `tool steer smoke ok`.

## zellij installed matrix

Date: 2026-05-13, after installing `zellij 0.44.3`.

Environment:

- Current Pi process is still inside tmux, not zellij.
- `mux=auto` therefore prefers tmux in this session.

Entrypoints and cases exercised:

- `spawn_lane` with `mux=pty` and a short command:
  - created a hidden zellij session and tab
  - after cleanup patch/reload, owned session self-clean was confirmed with
    `tool-smoke-pty-autoclean` (`cleaned-1`)
- `spawn_lane` with `runtime=pi`, `payload=direct`, `mux=pty`, `name=ptypi`:
  - created hidden zellij session `ptypi`
  - child session replied `pty pi smoke ok`
  - session stayed alive while the Pi child was running, then was manually
    deleted
- `spawn_lane` with explicit `targetMuxWorkspace=sharedws`:
  - created/used zellij session `sharedws`
  - session intentionally remained after the command exited
  - manually deleted as expected for user-owned/shared workspaces
- `spawn_lane` with `mux=zellij`, `placement=hidden`, `name=zjhidden`:
  - created hidden zellij session `zjhidden`
  - session remained because this was direct zellij hidden placement, not the
    self-cleaning `pty` alias
  - manually deleted
- `spawn_lane` with `mux=zellij`, `placement=new-window`,
  `targetMuxWorkspace=visiblews`:
  - created tab `1` in zellij session `visiblews`
  - manually deleted test session
- `spawn_lane` with `mux=zellij`, `placement=split-pane`,
  `targetMuxWorkspace=splitws`:
  - created pane `terminal_1` in zellij session `splitws`
  - manually deleted test session
- `spawn_lane` with `mux=auto`, `placement=hidden` while current Pi is in tmux:
  - selected tmux and created pane `%1130`
  - manually cleaned up
- `spawn_lane` with `mux=pty`, `placement=new-window`:
  - correctly rejected with
    `mux='pty' is a hidden zellij-session alias; use placement='hidden'`
- `Agent` with `run_in_background=true` while current Pi is in tmux:
  - still used tmux (`Pane: %1131`, `Window: @1085`)
  - child transcript contained `mosaic tmux preference smoke ok`
  - manually cleaned up pane
- `spawn_list`:
  - rendered tmux, zellij hidden, zellij new-window, zellij split-pane, and Pi
    hidden zellij records
- `spawn_map`:
  - remained Pi session-topology oriented and did not inspect live zellij state

Additional issue found and fixed during this matrix:

- Long owned hidden zellij session names can exceed zellij's Unix socket path
  limit under macOS `$TMPDIR`.
- Owned hidden zellij session names are now compacted to at most 16 characters.
- Cleanup now uses the actual returned zellij session name, not the original
  requested lane name.

Not live-tested in this tmux-based session:

- `mux=auto` from inside a zellij-hosted Pi process. Unit coverage verifies the
  resolver prefers current zellij when the current backend is zellij.

## Mosaic split-pane default update

Date: 2026-05-13.

Mosaic full-session agents now default to split-pane placement when the parent
is already inside a multiplexer. The layout policy is:

- first agent: split the main pane to the right
- later agents: split below the first agent pane, forming a right-side agent
  column
- tmux: targets the main/first-agent pane directly
- active zellij: focuses the main/first-agent pane before splitting
- installed-but-not-active zellij: remains hidden/background because there is no
  current zellij tab to split

Covered by `pi/agent/extensions/mosaic/multiplexer.test.ts`.

## Verification commands

```bash
bun test \
  pi/agent/extensions/shared/lane-placement.test.ts \
  pi/agent/extensions/mosaic/multiplexer.test.ts \
  pi/agent/extensions/spawn/index.test.ts
node --check pi/agent/extensions/spawn/index.ts
node --check pi/agent/extensions/shared/lane-placement.ts
node --check pi/agent/extensions/mosaic/multiplexer.ts
node --check pi/agent/extensions/mosaic/full-session-agent.ts
bun run typecheck
git diff --check
```
