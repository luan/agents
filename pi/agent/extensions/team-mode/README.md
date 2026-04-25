# Team Mode

Team Mode is a durable named-worker orchestration extension for Pi. It wraps
background worker runs with a persistent task board, coordinator policy, custom
notifications, and a keyboard-driven TUI dashboard.

## Commands

```text
/team                       open the dashboard overlay
/team start <objective>      create a team run
/team status                 show compact status
/team tasks                  show task board
/team pause                  pause dispatch policy
/team resume                 resume dispatch policy
/team stop [worker]          stop the team or one worker
/team clear                  delete completed team state after confirmation
```

## Model tools

- `team_start` — create a durable team run
- `team_spawn_worker` — start a named background worker
- `team_send` — resume/message a worker with a self-contained prompt
- `team_task_create` — create a versioned team task
- `team_task_update` — update a task with `expectedVersion`
- `team_status` — inspect summary/workers/tasks/events
- `team_control` — pause/resume/stop team or worker

## Worker modes

| Mode | Behavior |
| --- | --- |
| `advisory` | read-only/research style work |
| `single-writer` | worker may mutate the shared checkout; coordinator stays read-only |
| `worktree` | creates an isolated git worktree from `HEAD` before launch |

Worktree mode refuses to start from a dirty parent checkout because worktrees do
not include uncommitted parent changes.

## TUI

While a team is active, a compact widget appears below the editor. `/team` opens
the full overlay.

Keys:

| Key | Action |
| --- | --- |
| `↑` / `↓` | move selection |
| `tab` / `shift+tab` | switch pane |
| `enter` / `m` | message selected worker |
| `p` | pause/resume team |
| `s` | stop selected worker or team |
| `r` | refresh |
| `o` | put selected path in editor |
| `esc` | close overlay |

## Storage

State lives under `~/.pi/agent/team-mode` by default. Set
`PI_TEAM_MODE_ROOT` for tests.

```text
~/.pi/agent/team-mode/
  teams/<team-id>/team.json
  teams/<team-id>/workers/<worker-id>.json
  teams/<team-id>/tasks/<task-id>.json
  teams/<team-id>/events.ndjson
  sessions/<worker-id>.jsonl
```

## Limitations

- Resume is checkpoint-based; Team Mode does not magically reattach to an
  arbitrary orphaned process after a crash.
- The first implementation uses Pi subprocess workers. The runtime is isolated
  behind an adapter so it can move to a deeper `pi-subagents` API later.
- Single-writer is the default for implementation work. Parallel writes require
  explicit worktree mode.
