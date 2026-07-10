# Spawn extension direction

`spawn` is the neutral execution-lane primitive. It owns runtime selection,
session topology, multiplexer placement, and prompt transfer only. It must not
own product workflow, task classification, lens selection, or agent behavior
policy.

## Active surfaces

- Extension: `pi/agent/extensions/spawn/index.ts`
- Command: `/spawn`
- Tools:
  - `spawn_lane`
  - `spawn_list`
  - `spawn_map`

The older handoff API and workflow router are not active product surfaces.
Historical copies may exist under `archive/`, but active settings do not load
them.

## Primitive contract

Spawn requests are described by transport/topology fields:

- `runtime`: `pi`, `shell`, or `command`
- `payload`: `empty`, `direct`, or `context`
- `relation`: `root` or `child`
- `placement`: `new-session`, `new-window`, `split-pane`, or `hidden`
- `mux`: `auto`, `tmux`, `zellij`, `pty`, or `none`
- `cwd`
- `name`
- `goal`
- `prompt`
- `command`
- optional split controls: `splitDirection`, `splitSizePercent`
- optional targets: `targetSessionPath`, `targetMuxWorkspace`
- legacy target alias: `targetMuxSession`

These fields say what runs, where the lane opens, how it is parented when it is
a Pi session, and what initial text it receives. They do not say what kind of
product work an agent should do.

When `runtime` is omitted, spawn chooses the basic terminal behavior: `command`
when `command` is supplied, `pi` when `direct` or `context` payload is supplied,
and `shell` otherwise.

## Runtime behavior

### `pi`

Creates a Pi agent lane. This is the only runtime that supports `direct`,
`context`, Pi session files, prompt artifacts, and linked parent/child session
relationships.

### `shell`

Opens a fresh login shell in the requested placement and working directory.
Shell lanes do not create Pi session files, prompt artifacts, or Pi child
relationships. `new-window`, `split-pane`, and `hidden` placements use the
resolved mux backend.

Examples:

```text
/spawn shell --placement split-pane --split-direction horizontal
/spawn bash --placement new-window --cwd ../other-project
```

### `command`

Runs a command in the requested placement and working directory. Command lanes
do not create Pi session files, prompt artifacts, or Pi child relationships.
Visible tmux/zellij placements keep the pane open after the command exits so the
output remains inspectable.

Examples:

```text
/spawn command --placement split-pane --split-direction horizontal -- bash -lc 'pwd; echo ok'
/spawn run --placement new-window -- npm run tauri dev
```

## Payload behavior

### `empty`

For Pi runtime, creates a lane/session with no initial user message. For
`shell` and `command` runtimes, `empty` is the only valid payload because no Pi
prompt is sent.

### `direct`

Builds a direct prompt frame only:

- task text
- target directory when known
- child-lane reminder when the lane is linked to a parent

Direct payloads do not inspect the goal, infer category, set global state, or
add labels/prefixes.

### `context`

Generates a focused context-transfer prompt from the current conversation and
the requested goal, or uses a prebuilt prompt when supplied through the tool.

Generated context should include only:

- current objective when relevant
- decisions and constraints
- relevant files, commands, and artifacts
- repo/session state when relevant
- exact next task
- verification expectations
- concrete session guidance, such as parallel lane vs continuation, when useful

Generated context must not add or infer category, mode, lens, workflow, or
prefix lines.

## Topology behavior

- `child` preserves a parent/child session relationship for Pi runtime.
- `root` creates an unrelated root session.
- Cross-project `cwd` spawns default to `root` unless `targetSessionPath`
  explicitly supplies the parent for `child`.
- `new-session` is interactive `/spawn` only, because tools cannot replace the
  active Pi session.
- `new-window` opens a visible tmux window or zellij tab.
- `split-pane` opens a visible tmux pane or zellij pane.
- `hidden` opens a background lane:
  - tmux: detached tmux session
  - zellij: background zellij session/tab
  - `mux=pty` / `mux=no-mux`: compatibility aliases for a hidden zellij
    session; zellij is required
- `targetMuxWorkspace` lets a lane open in another tmux session or zellij
  session/workspace.
- `targetMuxSession` remains accepted as a legacy alias for
  `targetMuxWorkspace`.
- Non-Pi runtimes normalize to root relation because there is no Pi child
  session to link.

## Mux backend behavior

`mux=auto` chooses the best available lane backend:

1. current tmux session, when running inside tmux
2. current zellij session, when running inside zellij
3. tmux, when available
4. zellij, when available

Use `mux=tmux` or `mux=zellij` to require a specific multiplexer. Use `mux=pty`
or `mux=no-mux` as a compatibility spelling for `placement=hidden` backed by a
zellij background session. `mux=pty` requires zellij and does not start a local
node-pty process. Owned `mux=pty` sessions self-delete when their launched
process exits; explicit `targetMuxWorkspace` sessions are treated as
user-owned/shared and are not auto-deleted. `mux=none` is only valid for
`new-session`, because `new-window`, `split-pane`, and `hidden` need a placement
backend.

## Slash command

```text
/spawn help
/spawn shell --placement split-pane --split-direction horizontal
/spawn command --placement new-window -- npm run dev
/spawn command --placement hidden --mux pty -- npm test
/spawn direct child Inspect docs/spawn.md
/spawn context child Continue the current investigation
/spawn list
/spawn map
/spawn status
```

## Boundary for future agentic extensions

Higher-level agentic Pi extensions can compose on top of the same placement
core, but should keep their own policy outside `spawn/index.ts`.

Good division:

- agentic extension: choose strategy, specialists, sequencing, task policy, and
  prompt content
- spawn extension: open lanes, transfer context, record lane metadata, and show
  the lane tree

This keeps the primitive short, reusable, testable, and safe to call from tools.

## Verification

Compatibility smoke evidence is tracked in
[`docs/spawn-compatibility-smoke.md`](spawn-compatibility-smoke.md).

After changing spawn or its docs, run:

```bash
cd /path/to/agents
git diff --check
node --check pi/agent/extensions/spawn/index.ts
node --check pi/agent/extensions/shared/lane-placement.ts
bun run typecheck
```
