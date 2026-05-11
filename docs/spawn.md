# Spawn extension direction

`spawn` is the neutral execution-lane primitive. It owns runtime selection,
session topology, tmux placement, and prompt transfer only. It must not own
product workflow, task classification, lens selection, or agent behavior policy.

## Active surfaces

- Extension: `pi/agent/extensions/spawn.ts`
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
- `placement`: `new-session`, `new-window`, or `split-pane`
- `mux`: `tmux`, `none`, or `auto`
- `cwd`
- `name`
- `goal`
- `prompt`
- `command`
- optional split controls: `splitDirection`, `splitSizePercent`
- optional targets: `targetSessionPath`, `targetMuxSession`

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

Opens a fresh login shell in the requested tmux placement and working directory.
Shell lanes do not create Pi session files, prompt artifacts, or Pi child
relationships.

Examples:

```text
/spawn shell --placement split-pane --split-direction horizontal
/spawn bash --placement new-window --cwd ../other-project
```

### `command`

Runs a command in the requested tmux placement and working directory. Command
lanes do not create Pi session files, prompt artifacts, or Pi child
relationships. The pane stays open after the command exits so the output remains
inspectable.

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
- `new-window` and `split-pane` are tmux-backed placements.
- `targetMuxSession` lets a lane open in another tmux session/workspace.
- Non-Pi runtimes normalize to root relation because there is no Pi child
  session to link.

## Boundary for future agentic extensions

A higher-level agentic Pi extension can compose on top of spawn, but should keep
its own policy outside `spawn.ts`.

Good division:

- agentic extension: choose strategy, specialists, sequencing, task policy, and
  prompt content
- spawn extension: open lanes, transfer context, record lane metadata, and show
  the lane tree

This keeps the primitive short, reusable, testable, and safe to call from tools.

## Verification

After changing spawn or its docs, run:

```bash
cd /path/to/agents
git diff --check
node --check pi/agent/extensions/spawn.ts
node --check pi/agent/extensions/cockpit-nav.ts
bun run typecheck
```
