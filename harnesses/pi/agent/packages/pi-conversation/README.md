# pi-conversation

Asynchronous questions, user-facing messages, and interruptible clock tools for Pi.
The model can ask a question while continuing independent work.

## Install

```sh
pi install ./harnesses/pi/agent/packages/pi-conversation
```

Enable `request_user_input_async`, `send_message_to_user_async`, `clock__sleep`, and `clock__curr_time`
in Pi's tool selection. Keep these control tools direct. The managed harness
loads and selects them already. No Pi source changes are needed.

## Questions and messages

`request_user_input_async` accepts `{questions: [{title, options?}]}` and returns
`{"accepted":true}` immediately. The tool call ID identifies the group.
Questions appear inline above the chat editor. Click a suggested answer, or click
the text field and type your own. Enter or **Next/Send** submits the typed answer.
Groups show one question at a time; **Back** revisits an earlier answer. Escape
returns focus to chat and preserves the draft. No modal or opening button is needed;
preselection never submits an answer.

The whole group is submitted after every question has an answer. Answers arrive
through Pi's steering queue and wake a waiting model. The transcript shows the
answer once; its tool correlation envelope stays hidden. Click **Dismiss** to
dismiss the visible group; its response explicitly reports that dismissal is not
approval. Questions and submitted answers persist across resume and rollover.
If Pi stops before an answer leaves its steering queue, the next model request
recovers it from the transcript.

`send_message_to_user_async({message})` displays a durable user-facing message
without ending the turn and returns `{"accepted":true}`. Use it for an answer
or finding the user needs during ongoing work. Routine progress still belongs
in commentary.

Child agents use their parent's mailbox. These two tools reject root-user
interaction from all child agents, including interactive side sessions.

## Clock and persistence

`clock__curr_time({})` returns the current UTC time. `clock__sleep({duration_ms})`
waits for 1 ms through 12 hours and reports elapsed wall time and whether new
input interrupted the wait. Its presentation details retain `elapsed_ms` and
`reason` (`elapsed`, `input`, or `cancelled`). New input, submitted answers, and shutdown wake the wait.
Pi must remain running; this is an active-session wait, not an OS scheduler.

Questions, messages, and clock tools work in ordinary mode. This extension does
not select reasoning or own persistent mode. For Codex Persistent reasoning,
use Codex Native settings' **Reasoning mode (this session)** setting. Its
compiled default is **Use Pi thinking level**. The provider owns the Codex
instructions, backend effort mapping, and current-time reminder defaults.

With Codex Native installed, Astra exposes async questions and clock tools from
its catalog. Async messages require **Async messages** to be enabled; the managed
harness enables it. Sleep also follows the feature, model, and time-reminder
settings. The provider exposes `clock.curr_time` and `clock.sleep` on the wire and
routes them to Pi's local `clock__curr_time` and `clock__sleep` tools. Execution
checks the same availability policy as request construction.

## Actions and UI

Tool rows show readable actions and outcomes, including the checked time,
requested wait, and whether input resumed it. Expand a question row to inspect
its choices. Async messages appear once as formatted transcript text.

The visible controls are the normal workflow. The existing `/questions` command remains an optional keyboard alternative, not a setup step.
Notes, history, and context rollover are model tools; ask for normal work and
let the model use them when needed.

| Action ID | Behavior |
| --- | --- |
| `conversation.questions.open` | Focus the inline question card. |

Bind actions through `keybindings.json`; the extension owns no default keys.
The TUI uses `pi-libtui`'s inline input, selectable rows, and semantic colors. RPC clients use Pi's
standard select/input requests automatically when a question is created. Headless sessions persist
questions but need a user-capable client to answer them.

## Architecture

| Responsibility | Owner |
| --- | --- |
| Tool schemas and execution | `src/tools/request-user-input`, `send-user-message`, `sleep`, `current-time` |
| Persisted questions, answers, validation | `src/core/state.ts` |
| Delivery, restrictions, wake routing | `src/runtime/conversation.ts` |
| Interruptible timer | `src/runtime/sleep.ts` |
| Model instructions | `src/contributions` |
| Inline questions and widget | `src/ui/questions.ts`; `pi-libtui` |
| RPC question dialogs | `src/ui/rpc-questions.ts` |
| Tool presentation | `src/tools/presentation.ts`; shared `ToolActivity` rows and durable message/answer entries |
| Native boundary | None; Pi owns the run loop and transcript |
| Public library surface | `src/index.ts` exports validated state helpers |

See [Conversation and context recovery](../../../../../docs/pi-context-and-conversation.md).
