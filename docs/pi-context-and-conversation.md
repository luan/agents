# Conversation and context recovery

Two independently installable extensions supply the conversation and context
features in the managed Astra setup. Pi itself remains unchanged. Approval
review is outside this feature set.

```text
Pi public run loop, session log, context hooks, UI
  ├─ pi-conversation
  │    questions → pending widget → answer → steering queue
  │    async messages → durable transcript entries
  │    interruptible sleep + current time
  └─ pi-context-windows
       notes/history → durable session entries
       new_context → tool batch ends → next request projection
       overflow/compaction → checkpoint → retry

pi-developer-messages ← session-scoped prompt contributions
pi-code-mode          ← ordinary history/notes tool adapters
pi-codex-native       ← context-window capability + configured Persistent reasoning
pi-subagents          → versioned identities and transcript paths
pi-xsettings/libactions/libtui ← settings, actions, presentation
```

## Ownership

The extensions own feature records. Pi owns the session tree, tool execution,
steering queue, cancellation, and persistence. No private Pi fields are patched.
Rollover changes model-visible messages without deleting the transcript or
creating another session. The entire tool batch persists before a rollover.
Processes, questions, notes, agent identity, and workspace state survive.

`pi-context/window/v1` is an optional structural capability. The provider checks
its version and methods without importing `pi-context-windows`. `pi-subagents` persists
`session.identity/v1`, including the root, agent name, interactive status, and
root transcript path. Context recovery follows recorded child transcripts and
validates identity before exposing contents. Live sessions own separate state
and prompt contributions; disposing a child preserves its parent's registrations.

## Model-facing shape

The async tools use Codex's current names: `request_user_input_async` and
`send_message_to_user_async`, both returning `accepted: true`. Questions have
`title` and optional string `options`; their tool call ID is their identity.
Fresh windows use `new_context`; remaining tokens use `get_context_remaining`.

Pi flattens the history and notes namespaces to `history__*` and `notes__*`.
The managed setup moves these ordinary operations under Code Mode. Questions,
messages, sleep, and rollover stay direct. Notes contain plaintext and history
comes from Pi session entries; Codex's remote encrypted backend is not required.

Async questions, async messages, and clock tools are independent of Persistent.
Codex Native applies the model catalog, feature settings, and root-agent restriction
when constructing requests. Conversation tools enforce that policy when executed.
Without a native provider policy, the conversation extension works independently.

**Reasoning mode (this session) → Persistent** applies immediately and persists in
Pi's session branch. Astra receives its catalog instructions to continue useful
authorized follow-up while delivering answers asynchronously. Other models receive
Codex's fallback instructions. **Use Pi thinking level** restores ordinary operation.

The provider records instruction changes and due UTC reminders at their original
request boundaries. Reminder settings select the interval and either any inference
or only inference following new user input or tool output. Context resets establish
a fresh baseline. Pi owns execution, cancellation, and the end of the turn.

## Configuration

The managed harness loads both packages. `settings.json` selects the five
direct control tools, including `clock__curr_time`. `xsettings.toml` places history, notes, and token reporting
under Code Mode. Codex Native defaults to Pi's normal thinking level. Tool-specific instructions
stay with their extensions; `SYSTEM.md` supplies communication and continuation
rules. The managed harness loads these tools automatically when Pi starts.
Questions show inline choices and a free-text field above the editor, with Next/Send and Dismiss controls. Users do not need slash
commands, tool names, or a setup ritual during normal work.

Tool rows summarize the action and outcome. Expanded rows show question choices,
note text, or history results. Answers appear once in the transcript, and wait
rows distinguish completion, cancellation, and interruption by new input.

Package READMEs describe all tool arguments, settings, action IDs, storage
limits, and standalone installation.

## Verification

Context tests use real Pi SDK sessions with a deterministic local provider:
tool-batch rollover, searchable old evidence, notes, pending questions, reversed
load order, disk resume, and overflow retry. State tests cover inherited window
IDs, active-branch notes, paths, and malformed records. Conversation tests cover
answer recovery, dismissal, branches, agent restrictions, and immediate wake
or cancellation without waiting for a clock timeout.

Run `just check` for repository validation and `just pi-install-check` for each
changed package to verify independently packaged loading without changing live
settings. Inspect inline selection, typing, and return to chat in live Pi separately from unit tests.

## Try the additional features

The managed harness also loads Voice, Notebook, and Imagegen. No shell commands
are needed to use them. Each feature keeps its own package and settings.

| Feature | Try it in Pi |
| --- | --- |
| Astra effort | Enable **Auto reasoning** in Codex Native settings, then ask Astra to use low effort for exploration and high for the difficult step. Your starting level remains the floor. |
| Account usage | Press **Alt+U** to open the usage overlay. Refresh is read-only; credit redemption has its own explicit confirmation. |
| Voice and dictation | Press **Alt+V**, then select **Start voice** or **Dictate a draft**. The footer shows recording and transcription. Reopen the menu to finish dictation and review the draft before sending. |
| Phone | In the Voice menu, select **Connect phone**, open its private link on the same network, then start voice or use the text field. |
| Generated checkpoints | Enable **Generated recovery summaries** in Context Windows settings and ask the agent to save notes and start a fresh context window. Codex keeps an encrypted checkpoint alongside the readable summary. |
| Tree archives | Set **Context archives** to **Tree**. After rollover, inspect the completed window in Pi's tree or ask the agent to search its history. |
| Notebook | Ask: “Create a notebook variable, read it in another cell, restart the notebook, and read it again.” |
| Text-only vision | On a text-only model, ask it to inspect a local image with `view_image`. The configured vision model returns a description. |
| Image generation | Ask Pi to generate an image, or edit an image already attached or on disk. |

These are independently installable extensions. The notebook uses Deno and
restores serializable values; it does not preserve live functions or external
resources across restart. Voice uses a separate Codex realtime connection and
readable context summaries. Image generation uses the standalone
`@howaboua/pi-codex-imagegen` dependency, without the conversion extension.
Native tools build during repository setup; Deno downloads on its first use.
