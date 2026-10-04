# @luan.sh/pi-copy-mode&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-copy-mode)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-copy-mode)

`@luan.sh/pi-copy-mode` adds Vim-style transcript selection, copying,
annotations, and reactions to Pi. Select characters, lines, or columns, copy
them, or attach feedback to your next request directly from the selection.

It is a Pi extension, not a model-facing tool. It adds no tools and no slash
commands.

## Preview

![@luan.sh/pi-copy-mode in Bootty](https://pi.luan.sh/media/previews/pi-copy-mode-9b8c74e7ea97.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-copy-mode-7a4bd7d42c6a.mp4).

## Install

```sh
pi install npm:@luan.sh/pi-copy-mode
```

Optional companions:

- `pi install npm:@luan.sh/pi-xsettings` adds the `/xsettings` UI for the
  settings below and binds the `copy-mode.enter` action to a global key from
  `keybindings.json`; without it the default setting applies and copy mode can
  only be entered from a mouse selection (see below).
- `pi install npm:@luan.sh/pi-developer-messages` routes annotation guidance
  through developer messages. Without it, the same guidance is appended to
  the system prompt only when a request contains annotations.

## Use it

Copy mode works only in Pi's interactive fullscreen TUI; elsewhere the entry
action shows a warning. There are two ways in:

- Run the `copy-mode.enter` action from a key you bound to it. The cursor
  starts on the bottom visible transcript row.
- Select text with the mouse. The selection stays a normal Pi selection, and
  an action bar (comment, react, copy) appears next to it. Clicking a bar
  action, or pressing any key bound to a copy-mode motion or selection action,
  adopts the range as a character selection and enters copy mode. A key bound
  to `copy-mode.halfPageDown` that is literally `ctrl+d` does not adopt.

Inside copy mode the status line shows `COPY MODE` plus the selection kind, a
pending count, or a pending find motion. Unbound keys are swallowed. A focused
overlay (dialog, picker) receives keys as usual; copy mode stays active behind
it.

Behaviour of the actions:

- Motions move the cursor and keep it on screen. Digits typed before a motion
  form a count (capped at 9999); a bare `0` is not a count, so it can be bound
  to `copy-mode.lineStart`. Find/till motions wait for the next printable
  character; a non-printable key cancels them.
- `toggleSelection`, `lineSelection`, and `columnSelection` start a selection
  of that kind anchored at the cursor, switch kind if one is active, or return
  to a bare cursor when pressed again in the same kind. `swapEnds` moves the
  cursor to the other end. `clearSelection` first cancels a pending count or
  find, then collapses the selection and stays in copy mode. `ctrl+[` is
  treated as the same key as `escape`.
- `copy` copies the selection (or the character under the cursor) and leaves
  copy mode. Character selections trim trailing whitespace per row; line
  selections keep trailing spaces and end with a newline; column selections
  copy the exact rectangle, padding short rows with spaces. Copy uses Pi's
  clipboard when Pi provides one and falls back to an OSC 52 escape sequence
  otherwise. A "Copied!" or "Copy failed" pill appears at the cursor.
- `annotate` and `react` publish `selection.comment` and `selection.reaction`
  requests through the `@luan.sh/pi-libtui/selection` registry. The built-in annotation feature handles both requests.
  While the handler runs, copy-mode input is suspended. A confirmed request
  collapses the selection to the cursor and keeps copy mode active; a
  cancelled one keeps the range. When the request was started from a mouse
  selection, copy mode exits afterwards.
- `cancel` clears the selection and leaves copy mode.
- Folds: `foldPrefix` arms a prefix; the next key is matched against
  `foldOpen`, `foldClose`, `foldOpenAll`, and `foldCloseAll`. The suffix keys
  do nothing without the prefix. Open/close apply to the fold under the
  cursor, provided by other extensions through the `@luan.sh/pi-libtui/folding`
  registry.

A left click inside copy mode moves the cursor to that cell and drops the
selection; a drag after it is a normal mouse selection.

## Annotate a response

1. Trigger `copy-mode.enter` and select text with `copy-mode.toggleSelection`
   plus motions, or select transcript text with the mouse. Either way a small
   action bar with comment, react, and copy appears next to the selection.
2. Press your `copy-mode.annotate` key (or click "comment") to write a
   comment, or press `copy-mode.react` (or click "react") to pick a reaction.
3. Enter saves the draft. Escape cancels. The comment dialog also has
   Save/Cancel buttons; when editing an existing draft it adds Delete
   (`ctrl+d`).
4. Submit the prompt normally. The drafts become part of the request.

A draft appears as a numbered pill in the editor and as a handle in the
transcript, and the status line shows how many annotations are pending. Hover
a pill to see the selected text and comment; click it to edit or delete the
draft. Deleting a draft removes only its editor token and keeps the
surrounding prompt unchanged. If you remove a pill's token from the editor
text, the draft is dropped. Drafts are cleared once the message is sent.

Reactions are preset comment text. The defaults are:

- `👍 Looks good`
- `🚫 Rejected`
- `✅ Approved`
- `❓ Clarify`
- `🧬 Match existing patterns`
- `🔄 Consider alternatives`
- `🔍 Verify`

The transcript renders a submitted envelope as readable annotation blocks.
Assistant text containing `:pi-annotation{index="N"}` or the imported
`:codex-annotation{index="N"}` directive renders the corresponding annotation
as a hoverable pill. Directives inside inline or fenced code remain text.

## Keybindings

No action in this package has a default key. Actions are registered through
`@luan.sh/pi-libactions`, and keys come from `keybindings.json` in Pi's agent
directory, normally `~/.pi/agent/keybindings.json`. The file is a JSON object
mapping action ID to one key ID or an array of key IDs. Key IDs are lowercase:
write `shift+v` rather than `V`, `escape` rather than `Escape`. Invalid key IDs
are ignored. The file is read when a session starts; run `/reload` after
editing it.

Global entry (exposed as a shortcut only when `@luan.sh/pi-xsettings` is
installed):

```json
{ "copy-mode.enter": "alt+z" }
```

Modal actions, active only inside copy mode or on a completed mouse selection.
One example per group; the full ID list follows.

```json
{
  "copy-mode.up": ["k", "up"],
  "copy-mode.wordForward": "w",
  "copy-mode.findForward": "f",
  "copy-mode.paragraphForward": "}",
  "copy-mode.toggleSelection": ["v", "space"],
  "copy-mode.lineSelection": "shift+v",
  "copy-mode.columnSelection": "ctrl+v",
  "copy-mode.swapEnds": "o",
  "copy-mode.clearSelection": "escape",
  "copy-mode.copy": "y",
  "copy-mode.annotate": "c",
  "copy-mode.react": "r",
  "copy-mode.cancel": "q",
  "copy-mode.foldPrefix": "z",
  "copy-mode.foldOpen": "o",
  "copy-mode.foldClose": "c",
  "copy-mode.foldOpenAll": "shift+r",
  "copy-mode.foldCloseAll": "shift+m"
}
```

| Group | Action IDs (`copy-mode.` prefix) |
| --- | --- |
| Basic motion | `up`, `down`, `left`, `right`, `lineStart`, `lineEnd`, `top`, `bottom`, `halfPageUp`, `halfPageDown`, `pageUp`, `pageDown` |
| Word motion | `wordForward`, `wordEnd`, `wordBackward`, `bigWordForward`, `bigWordEnd`, `bigWordBackward` |
| Character find | `findForward`, `findBackward`, `tillForward`, `tillBackward`, `repeatFind`, `reverseFind` |
| Line/paragraph | `paragraphForward`, `paragraphBackward`, `firstNonblank`, `firstNonblankDown` |
| Selection | `toggleSelection`, `lineSelection`, `columnSelection`, `swapEnds`, `clearSelection` |
| Actions | `copy`, `annotate`, `react`, `cancel` |
| Folds | `foldPrefix`, `foldOpen`, `foldClose`, `foldOpenAll`, `foldCloseAll` |

## Settings

Settings use the `@luan.sh/pi-copy-mode` namespace:

| Key | Default | Meaning |
| --- | --- | --- |
| `reactions` | Seven reactions listed above | Ordered choices in the reaction picker. An empty list disables it until a choice is configured. |
| `copyOnSelect` | `true` | Copy text immediately when a mouse selection is completed. When off, the selection stays available for the action bar and keyboard adoption. |

Edit them under Interaction → Copy mode via `/xsettings` when
`@luan.sh/pi-xsettings` is installed; otherwise the compiled defaults apply.

## Library API

Importing `@luan.sh/pi-copy-mode` does not start the extension. It exports:

- Keybinding contracts: `COPY_MODE_ACTIONS`, `loadCopyModeKeybindings`, and
  `matchCopyModeAction`, with the `CopyModeAction` and `CopyModeKeybindings`
  types.
- Cursor and motion helpers: `clampCursor`, `moveCursor`,
  `moveVirtualCursor`, `graphemeEnd`, and `scrollTopForCursor`, plus their
  document and point types.

`@luan.sh/pi-copy-mode/annotations` exposes annotation helpers without starting Pi:

- Envelope: `serializeEnvelope`, `parseEnvelope`, `projectEnvelope`,
  `responseAnnotations`, `annotationText`.
- Directives: `projectAnnotationDirectives`.
- Draft state: `AnnotationStore`, `tokenInsertion`, `tokenPreview`,
  `removeTokenAtom`.
- Presentation: `plainPill`, `composerPillContent`, `responsePillContent`,
  `transcriptPillContent`, `AnnotationPresentationGroups`.
- Types: `AnnotationSelection`, `DraftAnnotation`, `ResponseAnnotation`,
  `ParsedResponseAnnotations`, `ResolvedAnnotationLink`.

```ts
import { parseEnvelope, projectEnvelope } from "@luan.sh/pi-copy-mode/annotations";

const parsed = parseEnvelope(messageText);
const readable = parsed ? projectEnvelope(messageText) : messageText;
```

## Wire format

When a prompt contains drafts, the editor submits this shape (with the real
JSON array in place of the example):

```text
# Response annotations:
Each item contains text selected from an earlier response and may include a user comment.
<response-annotations>
[
  { "text": "selected text", "annotation": "comment" }
]
</response-annotations>

## My request:
ordinary prompt text
```

Reactions are serialized as ordinary annotation text.

## Architecture

The extension registers the `copy-mode.enter` action and the setting at load
time, and mounts one session-scoped host widget per TUI session. The host
reads the fullscreen transcript through a validated private Pi surface, draws
the cursor and selection as screen decorations, and talks to other extensions
only through the shared `@luan.sh/pi-libtui` selection, folding, and mouse registries.
Annotations live in their own feature directory and register alongside copy
mode under the same ownership claim. If two copies load, only the owner
registers features; it releases ownership on reload or quit. The annotation
store owns drafts; the annotation composition root owns prompt transforms,
rendering, and optional developer-message contributions. No model-facing tool
or native executable is registered.

## Layout

| Responsibility | File |
| --- | --- |
| Extension entry, ownership claim, session lifecycle | `src/extension.ts` |
| `copy-mode.enter` action registration | `src/contributions/actions.ts` |
| Action IDs, keybinding loading and matching | `src/config/keybindings.ts` |
| Copy and reaction settings | `src/config/settings.ts` |
| Modal host: input, selection kinds, copy, selection requests, folds | `src/runtime/copy-mode.ts` |
| Validated fullscreen surface and clipboard fallback | `src/runtime/fullscreen-surface.ts` |
| Cursor clamping and basic motions | `src/core/cursor.ts` |
| Word, find, paragraph motions | `src/core/vim-motions.ts` |
| Cursor and selection painting | `src/ui/screen-decoration.ts` |
| Public exports | `src/index.ts` |
| Annotation hooks, decorators, editor installation | `src/annotations/extension.ts` |
| Draft store, envelopes, directives, presentation | `src/annotations/core/` |
| Selection resolution, compose and edit flows | `src/annotations/runtime/annotations.ts` |
| Comment/reaction dialogs, editor pills, transcript markers | `src/annotations/ui/` |
| Reaction definitions and developer-message contribution | `src/config/settings.ts`, `src/annotations/contributions/developer-prompt.ts` |

## Troubleshooting

- A key does nothing: there are no built-in keys. Check the action ID and key
  ID in `keybindings.json` and run `/reload`. For `copy-mode.enter`,
  `@luan.sh/pi-xsettings` must be installed.
- Comment or react requires a completed selection. Both are built in; no
  separate annotations package is needed. An empty reaction list shows a
  warning until at least one choice is configured.
- Annotation drafts install a custom editor only when none is already
  configured. Selection anchors use stable message offsets when uniquely
  resolvable and best-effort screen positions otherwise.
- "Copy mode requires Pi's fullscreen TUI": the package targets Pi 0.84.2's
  private fullscreen surface and fails closed when the layout does not match.

## Develop

Source: https://github.com/luan/agents, directory
harnesses/pi/agent/packages/pi-copy-mode. Run `bun run typecheck` and
`bun test test` in that directory.

The combined gallery video includes selection/copying and annotation workflows.
[Selection and copying](https://pi.luan.sh/media/previews/pi-copy-mode-selection-d6c073fbd593.mp4) · [Comments and reactions](https://pi.luan.sh/media/previews/pi-copy-mode-annotations-34a491d60fd7.mp4).
