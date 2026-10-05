# @luan.sh/pi-collapse-transcript&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-collapse-transcript)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-collapse-transcript)

`@luan.sh/pi-collapse-transcript` folds runs of tool calls and thinking blocks in Pi's fullscreen
transcript into collapsed activity rows, including while the agent is working.
Tool output, diffs, tool failures, and detailed thinking stay behind expansion.
Assistant prose and request-error notices stay visible. Previous turns keep their fold state. The row shows the latest
provider-supplied thinking summary (or tool action when no thinking is available), elapsed time,
and a step count. The entire row is muted with a dotted underline
that spans the terminal width, including the empty space after the chevron,
with the summary italicized: `  Worked for 6m 56s · Checking index baseline · 12 steps`.
Click it to expand the run back into the original tool renderers and
thinking Markdown. User messages, assistant prose, errors, and other entries stay
visible and separate one run from the next. Compaction draws a full-width,
muted horizontal divider with its own summary disclosure, not a padded card.
Compacting model context does not erase the visible conversation or reset its
activity folds. Resuming or reloading renders the full saved branch.

It is a Pi extension, not a model-facing tool. It changes only how existing
transcript components are laid out on screen. Session history, tool output, and
model-visible content are never rewritten.

## Preview

![@luan.sh/pi-collapse-transcript in Bootty](https://pi.luan.sh/media/previews/pi-collapse-transcript-d3924989e5a1.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-collapse-transcript-f4ea1478db8c.mp4).

## Install

```sh
pi install npm:@luan.sh/pi-collapse-transcript
```

That is the only step. The package ships its rendering library and mouse host
with it and registers both through `package.json`; nothing else needs to be
installed. It runs inside Pi (`@earendil-works/pi-coding-agent` with
`@earendil-works/pi-tui`); 0.87.1 is the tested version.

## Use it

There are no commands, tools, actions, or side-panel tabs. The extension does
its work on `session_start`:

- In interactive TUI mode it installs a hidden widget (`pi-collapse-transcript.host`)
  that mounts a transcript projection over Pi's chat container.
- In fullscreen mode, consecutive `thinking` and tool entries become one collapsed
  `ActivitySection` as they arrive. Its header shows `Working for <duration> · summary`,
  and a `N steps` count. Individual tool failures do not change the group's status.
- `agent_start` keeps the newest group marked `Working` between tool calls and model
  requests, including retries and automatic continuations. `agent_settled` changes
  it to `Worked`; neither event changes the user's expansion choice.
- A queued user request consumed after a final answer starts a fresh activity boundary,
  even when Pi continues without `agent_settled`. Steering stays compact too.
- Tool failures remain behind expansion while working and after completion.
  Expand the group for failure output, partial-edit diffs, and nested calls.
  Native request-error notices remain visible outside the fold.
  The header has no status dot or spinner.
- Clicking the row toggles between collapsed and expanded. Expanded content is
  the original components, so tool renderers, thinking Markdown, and libtui's
  scrolling and fold controls behave as they do natively.
- Compaction entries become `── Context compacted · N tokens before ── ▸`.
  Click to read the original summary; global tool expansion does not open it.
- Other entries that are not tools or thinking (`content` entries) are rendered
  unchanged and end the current run.
- Streaming updates and compaction keep the current fold state and refresh the
  header summary as new headings arrive. Loading a session rebuilds collapsed sections.
- On `session_shutdown`, or when the widget is disposed, the projection is
  released and Pi's native rendering returns.

Regular scrollback mode keeps native rendering: `mountTranscriptProjection`
projects entries only when `tui.mode === "fullscreen"`, because Pi's clickable
transcript controls need the fullscreen surface.

### Header summary

The group keeps its latest nonempty thinking summary while tools run and after
they finish. Groups without thinking use the latest tool action.
Elapsed time spans the group's earliest start to its latest completion, so
parallel tools are not added together. Saved message timestamps preserve it
across reloads and session resumes; active groups refresh once per second.
When timing is unavailable, the row omits the duration and the word `for`.
`activitySummary` picks the header text:

- Tool entries use structured action text with leading punctuation stripped.
  Reading a summary never renders the tool header or copies its animation,
  tree branches, or width-dependent truncation into the collapsed row.
- Thinking entries use the last `**bold**` or `#` heading in the final 8,000
  characters of the thought; without a heading they use the first line of the
  last paragraph, and finally the literal `Thinking`. No summary is invented.
- The result is passed through `sanitizeTuiFieldPreview`, which removes
  control sequences and caps the text at 240 characters.

## Settings and keybindings

The package registers no settings, no actions, and no keybindings. The only
input it handles is a mouse press on the activity row, provided by
the bundled `@luan.sh/pi-libtui` mouse host. There is nothing to add to
`~/.pi/agent/keybindings.json` for this package. Expanded tools keep their
own appearance settings.

## Library API

`import { ActivityTranscript } from "@luan.sh/pi-collapse-transcript"` gives a
`ComponentStack` that takes an entry reader, a Pi `Theme`, and a
`requestRender` callback. It groups `TranscriptEntry` values from
`@luan.sh/pi-libtui/tool` and owns the fold state of each section. Pass it to
`mountTranscriptProjection` to use it outside this extension. Call `beginTurn()`
when the agent starts and `finishTurn()` only once the run settles; repeated
`beginTurn()` calls preserve the boundary during automatic continuations. It has no native binary.

## Native boundary

`@luan.sh/pi-libtui/tool` supplies the versioned transcript bridge. It reads Pi 1.0
private transcript fields, guards each node's shape, and fails open: when the
document layout does not match, when a node is not a recognised assistant or
tool component, or when a projection is already installed, the transcript is
left untouched. Unknown nodes and native error notices render as they are.
Its separate `installTranscriptHistory` lease adapts Pi's private display-only
history methods: successful compaction appends a marker instead of rebuilding
the chat, and history rebuilds use the full active branch. Pi still owns model
context, compaction, status cleanup, queued input, cancellation, and retries.
The lease fails open on unsupported hosts and restores native methods on disposal.

## Layout

| Responsibility | Owner |
| --- | --- |
| Pi registration, widget lifecycle, session hooks | `src/extension.ts` |
| Grouping entries into sections and fold state | `src/activity-transcript.ts` (`ActivityTranscript`, `ActivitySection`) |
| Compaction divider and independent summary disclosure | `src/compaction-section.ts` |
| Header text for a run | `activitySummary` in `src/activity-transcript.ts` |
| Elapsed time from session history | `src/activity-timing.ts` |
| Public exports | `src/index.ts` |
| Native transcript bridge | `mountTranscriptProjection` in `@luan.sh/pi-libtui/tool` |
| Display history independent of model context | `installTranscriptHistory` in `@luan.sh/pi-libtui/tool` |
| Row rendering, motion, folding, mouse | `ToolActivity`, `ComponentStack`, and the mouse host in `@luan.sh/pi-libtui` |
| Tool execution | None; existing tools run unchanged |

## Develop

Source: https://github.com/luan/agents, directory
`harnesses/pi/agent/packages/pi-collapse-transcript`. Run `bun run typecheck` and
`bun test test` in that directory.

`test/transcript.test.ts` drives a real `TuiAltScreen` with native
`AssistantMessageComponent` and `ToolExecutionComponent` instances and checks
collapse, click expansion, streaming updates, folded tool failures, unmount
behaviour, and summary sanitisation.
`test/compaction.test.ts` runs native interactive Pi sessions with an immediate
in-process provider and terminal. It checks manual and boundary-hook compaction,
retained display history, chronological notices, resumed history, and unchanged
model-context compaction.
