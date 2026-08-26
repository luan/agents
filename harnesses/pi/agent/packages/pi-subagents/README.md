# pi-subagents

`pi-subagents` adds one root-scoped tree of concurrent, nested Pi agents. Each
agent has its own session and can receive follow-up work, direct messages, or an
interrupt without blocking unrelated agents in the tree.

The package exposes six collaboration tools:

- `spawn_agent` starts one bounded task under the caller.
- `followup_task` continues an existing agent.
- `send_message` delivers an explicit interim message without starting a turn.
- `interrupt_agent` stops the agent's current turn.
- `list_agents` returns the current tree snapshot.
- `wait_agent` waits for a useful tree update and returns only compact status.

## Install and load

From the repository root:

```sh
just setup
pi install ./harnesses/pi/agent/packages/pi-subagents
```

The package bundles its workspace dependencies so the installed copy remains
independently loadable. `pi-libtui` supplies its generic TUI host bridge;
`pi-model-roles` resolves the selected subagent role, and its `pi-libcontext`
dependency is bundled at the package root for standalone installation.
Collaboration tools stay direct Pi tools because their session-tree state must
not be hidden inside a Code Mode cell.

## Use

Ask the model to delegate a concrete, bounded task. `spawn_agent` returns the
new canonical path, such as `/root/review` or `/root/review/tests`. A relative
target resolves from the calling agent; a canonical path can address an agent
anywhere in the same tree.

A successful child response is delivered independently to its direct parent as
a hidden `FINAL_ANSWER` mailbox message. An active parent receives it in the
current turn; an idle parent receives it on the next turn without starting one.
Nested completion goes to the immediate parent. Failed and interrupted turns
only publish status. `send_message` remains the separate explicit `MESSAGE`
path, while `wait_agent` never carries either message payload.

In Pi's interactive TUI:

```text
/subagents             open the Agent Hub
/retry                  retry the latest failed main-session request
/retry /root/review     retry one failed subagent
```

The package registers the `subagents.open` action. It does not register a
shortcut directly. This repository binds the action to `alt+a` in the managed
`keybindings.json`; reload Pi after changing that file.

Every agent gets a separate transcript beneath the root session directory.
Root-session checkpoints preserve the tree across reload, resume, fork, clone,
and tree navigation. Shutting down an agent does not delete its transcript.

Child sessions rediscover installed extensions, tools, and skills from the same
working directory and Pi agent directory, then keep only names active in the
parent. Session-only inline tools or resource paths that were never installed
are not transferable through Pi's public extension API and are omitted.

## Configure

Open `/xsettings` and edit **Subagents** in the Behavior category. The settings
namespace is `pi-subagents` in `~/.pi/agent/xsettings.toml`:

```toml
[behavior]
pi-subagents.maxConcurrency = "8"
pi-subagents.maxDepth = "2"
```

`maxConcurrency` counts the root agent, so `8` provides seven simultaneous
subagent slots. The available values are `2`, `4`, `8`, `16`, and `32`.
`maxDepth` counts levels below `/root`; its available values are `1` through
`4`. The compiled defaults are concurrency `8` and depth `2`, including when
the xsettings host is absent. Changed limits apply when an idle root tree
reloads; an active tree keeps its original limits until its agents settle.

Model choice comes from `pi-model-roles`. A spawn can select a role explicitly;
otherwise it uses that package's configured subagent default role. Forking can
copy all parent history, no history, or a positive number of recent turns.

## Architecture map

| Concern | Owner |
| --- | --- |
| Pi registration and lifecycle composition | `src/extension.ts` |
| Tool definitions | `src/tools/spawn-agent/`, `src/tools/followup-task/`, `src/tools/send-message/`, `src/tools/interrupt-agent/`, `src/tools/list-agents/`, and `src/tools/wait-agent/` |
| Shared tool results, scope resolution, and repeat protection | `src/tools/result.ts`, `src/tools/scope.ts`, and `src/tools/repeat-breaker.ts` |
| Execution owner | Named tool `definition.ts` modules delegate stateful work to `src/runtime/coordinator.ts` |
| State and mailbox owner | `src/runtime/coordinator.ts`; each child Pi session owns its transcript |
| Agent execution and prompt assembly | `src/runtime/agent-runner.ts`, `src/core/prompts.ts`, and `src/core/types.ts` |
| History forking and nested activity | `src/core/fork-history.ts` and `src/runtime/nested-tool-activity.ts` |
| Native boundary | None; the package uses Pi's session, model, and tool APIs directly |
| Typed settings | `src/config/settings.ts` via `pi-xsettings/sdk` |
| Keyboard action | `src/contributions/actions.ts` via `pi-libactions/sdk` |
| Presentation owner | `src/ui/agent-browser.ts`, `src/ui/agent-summary.ts`, `src/ui/agent-tree.ts`, `src/ui/agent-widget.ts`, and `src/ui/tool-presentations.ts` using `pi-libtui`; `src/protocol/presentation.ts` bridges child renderer capabilities |
| Public capabilities | Export-only `src/index.ts` exposes stable tool names and versioned result-detail contracts |

Tool execution does not import TUI modules. The coordinator publishes immutable
snapshots; the Agent Hub, widget, and tool renderers consume those snapshots.
Tool results carry bounded, serializable, versioned details. Direct calls use
the package's semantic `pi-libtui` presentations. Transcript browsing resolves
the child session's public Pi tool and custom-message renderers, then delegates
to Pi's own message and `ToolExecutionComponent` implementations. The Agent Hub
adds shared `pi-libtui` selection, wheel scrolling, and scrollbar behavior.

## Validate

For a focused package check:

```sh
bun run lint:pi
bun run --cwd=harnesses/pi/agent/packages/pi-subagents typecheck
bun test --cwd=harnesses/pi/agent/packages/pi-subagents
just pi-install-check harnesses/pi/agent/packages/pi-subagents
```

Run `just setup` after dependency or package-manifest changes and `just check`
before handoff. Live validation should exercise the Agent Hub, `alt+a`, nested
spawns through the configured depth, queueing at the concurrency limit,
follow-up delivery, interruption, waiting, retry, reload, and session resume.

## Troubleshooting

- **A spawn remains queued:** the tree is at its concurrency limit. Wait for a
  running agent to become idle or interrupt work that is no longer needed.
- **The depth limit is reached:** continue the task in the current agent or
  spawn from a shallower ancestor.
- **`alt+a` does nothing:** verify `subagents.open` in
  `~/.pi/agent/keybindings.json` and reload Pi. `/subagents` remains available.
- **A requested role is unavailable:** check `/xsettings` under Model Roles and
  verify that its model and thinking level are available in the current Pi
  session.
- **A collaboration tool is missing inside `exec`:** call it directly. The
  package deliberately does not lift session-tree coordination into Code Mode.
