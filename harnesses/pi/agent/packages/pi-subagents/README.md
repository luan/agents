# @luan.sh/pi-subagents&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-subagents)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-subagents)

`@luan.sh/pi-subagents` is a Pi extension that adds one root-scoped tree of
concurrent, nested agents. Each agent runs in its own Pi session and can
receive follow-up work, direct messages, or an interrupt without blocking
unrelated agents in the tree.

The extension registers six collaboration tools for the model:

- `spawn_agent` starts one bounded task under the caller.
- `followup_task` continues an existing agent.
- `send_message` delivers an explicit interim message without starting a turn.
- `interrupt_agent` stops the agent's current turn.
- `list_agents` returns the current tree snapshot.
- `wait_agent` waits for a useful tree update and returns only compact status.

## Preview

![@luan.sh/pi-subagents in Bootty](https://pi.luan.sh/media/previews/pi-subagents-f49966480d19.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-subagents-296d1d5cfa11.mp4).

## Install

```sh
pi install npm:@luan.sh/pi-subagents
```

Optional companions:

- `pi install npm:@luan.sh/pi-xsettings` adds a `/xsettings` UI for the
  settings below and binds keys from `keybindings.json`; without it the
  defaults apply and no key is bound.
- `pi install npm:@luan.sh/pi-panels` lets the Agent Hub open as a
  side-panel tab; without it the Agent Hub always opens as a fullscreen overlay.
- `pi install npm:@luan.sh/pi-developer-messages` makes the delegation
  instructions arrive as developer messages; without it they are appended to
  the system prompt.

## Use

Ask the model to delegate a concrete, bounded task. `spawn_agent` returns the
new canonical path, such as `/root/review` or `/root/review/tests`. A relative
target resolves from the calling agent; a canonical path can address an agent
anywhere in the same tree. The assigned work arrives as a hidden
`NEW_TASK` message rather than an end-user prompt.

A successful child response is delivered to its direct parent as a hidden
`FINAL_ANSWER` mailbox message. An active parent receives it in the current
turn; an idle parent receives it on the next turn without starting one. Failed
and interrupted turns only publish status. `send_message` is the separate
explicit `MESSAGE` path, and `wait_agent` never carries either payload.
`wait_agent` accepts `timeout_ms` from 10000 to 3600000 (default 30000).

`spawn_agent` parameters:

- `task_name`: lowercase letters, digits, and single dashes; at most 64 chars.
- `message`: the task text; at most 32768 chars (same limit for other tools).
- `fork_turns`: `all` (default), `none`, or a positive integer of recent parent
  turns to copy. Historical tool calls, tool results, and collaboration
  messages are never copied into the child context.
- `model`: a model id, unique alias, or exact `provider/model-id`; omit to inherit
  the parent model.
- `thinking_level`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
  `max`; omit to inherit. Unsupported explicit levels are rejected; inherited
  effort is clamped to the chosen model's supported levels. Resolved choices
  are kept when a child is retried or restored from a checkpoint.

Commands in Pi's interactive TUI:

```text
/subagents             open the Agent Hub
/retry                  retry the latest failed main-session request
/retry /root/review     retry one failed subagent
```

Inside the Agent Hub, `q`, `escape`, or `alt+a` closes it; `gg`, `G`, `home`,
`end`, `pageUp`/`ctrl+u`, and `pageDown`/`ctrl+d` scroll the transcript; the
mouse wheel scrolls too. The compact Agent Widget lists running agents and
clicking a row opens the Agent Hub with that agent selected.

Every agent gets a separate transcript beneath the root session directory. A
root started with `--no-session` keeps those transcripts under the system
temporary directory (`@luan.sh/pi-subagents/<session id>`). Root-session checkpoints
preserve the tree across reload, resume, fork, and clone. Session-tree
navigation is refused while subagents are queued or running. Shutting down an
agent does not delete its transcript.

Child sessions rediscover installed extensions, tools, and skills from the same
working directory and Pi agent directory, then keep only tool names active in
the parent (plus any tools lifted into a Code Mode `exec` cell). Session-only
inline tools or resource paths that were never installed are omitted. The
collaboration tools themselves stay direct Pi tools and are not lifted into
Code Mode.

## Settings

Settings use the `@luan.sh/pi-subagents` namespace. Edit them via `/xsettings` when
`@luan.sh/pi-xsettings` is installed; otherwise the defaults apply.

| Key | Default | Values |
| --- | --- | --- |
| `maxConcurrency` | `"4"` | `"2"`, `"4"`, `"8"`, `"16"`, `"32"` |
| `maxDepth` | `"2"` | `"1"`, `"2"`, `"3"`, `"4"` |
| `multiAgentMode` | `"explicit-requests"` | `"direct-requests-only"`, `"explicit-requests"`, `"proactive-read-only"`, `"proactive-mechanical"`, `"proactive"` |
| `agentWidgetIndicator` | `"inherit"` | `"inherit"` or any `@luan.sh/pi-libtui` activity indicator |
| `agentHubPresentation` | `"side-panel"` | `"side-panel"`, `"fullscreen"` |

`maxConcurrency` counts the root agent, so `4` provides three simultaneous
subagent slots; a spawn beyond the limit is queued. `maxDepth` counts levels
below `/root`. Changed limits apply when an idle root tree reloads; an active
tree keeps its original limits until its agents settle.

`multiAgentMode` is an ordered delegation spectrum. `direct-requests-only`
lets only the user's explicit request authorize delegation; `explicit-requests`
also accepts an applicable skill or AGENTS.md; `proactive-read-only` allows
proactive bounded investigation but no mutations; `proactive-mechanical` adds
bounded mechanical edits and verification; `proactive` delegates whenever it
could save time or improve quality. The two endpoints use Codex's explicit and
proactive instructions verbatim. Mode changes apply live.

`agentWidgetIndicator` overrides the spinner beside each running agent in the
widget; `inherit` uses the shared `pi-libtui.activityIndicator` setting. The
Agent Widget, Agent Hub, and running tool rows also follow
`pi-libtui.textEffect`. `agentHubPresentation` set to `side-panel` is only
honored when a side-panel host is present; it falls back to fullscreen.

## Keybindings

The package registers one action, `subagents.open` (Open the Agent Hub). It
has no default key. Bind it in Pi's agent directory, normally
`~/.pi/agent/keybindings.json`, as an action ID mapped to a key ID string or
array of key IDs:

```json
{
  "subagents.open": "alt+a"
}
```

Bindings take effect only when a shortcut host such as
`@luan.sh/pi-xsettings` is installed. The file is read on load; reload
extensions after editing. `/subagents` always works without a binding.

## Layout

| Responsibility | File |
| --- | --- |
| Pi registration, commands, lifecycle | `src/extension.ts` |
| Tool definitions | `src/tools/<tool-name>/definition.ts` |
| Tool results, scope, repeat protection, limits | `src/tools/result.ts`, `src/tools/scope.ts`, `src/tools/repeat-breaker.ts`, `src/tools/limits.ts` |
| Tree state, mailbox, checkpoints | `src/runtime/coordinator.ts` |
| Child session execution and prompt assembly | `src/runtime/agent-runner.ts`, `src/core/prompts.ts`, `src/core/types.ts` |
| Delegation instructions | `src/core/instructions.ts`, `src/contributions/developer-prompt.ts` |
| History forking and nested activity | `src/core/fork-history.ts`, `src/runtime/nested-tool-activity.ts` |
| Transcript location | `src/runtime/session-root.ts` |
| Typed settings | `src/config/settings.ts` |
| Keyboard action | `src/contributions/actions.ts` |
| Agent Hub, widget, tool renderers | `src/ui/*.ts`, `src/protocol/presentation.ts` |
| Public exports (tool names, result types) | `src/index.ts` |

## Troubleshooting

- **A spawn remains queued:** the tree is at `maxConcurrency`. Wait for a
  running agent to settle or interrupt work that is no longer needed.
- **The depth limit is reached:** continue in the current agent or spawn from
  a shallower ancestor.
- **The bound key does nothing:** check `subagents.open` in
  `keybindings.json`, confirm `@luan.sh/pi-xsettings` is installed, and reload.
- **A requested model is unavailable:** use a unique model id or alias, or the
  exact `provider/model-id`, and confirm the provider is configured in Pi.
- **A collaboration tool is missing inside `exec`:** call it directly; the
  package does not lift session-tree coordination into Code Mode.

## Develop

Source: https://github.com/luan/agents, directory
harnesses/pi/agent/packages/pi-subagents. Run `bun run typecheck` and
`bun test test` in that directory.

## Conversation and context integration

Child sessions persist a provider-independent `session.identity/v1` record with
the root session ID, root transcript path, canonical agent name, and interactive
status. Optional `pi-context-windows` uses it with recorded child transcript paths for
same-tree history and working notes, including resumed children in other working
directories. Optional `pi-conversation` uses it to route background clarification
through the parent mailbox while allowing interactive side sessions their own UI.
Neither integration adds a runtime dependency on the feature package.
