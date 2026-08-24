# pi-annotations

`pi-annotations` turns a transcript selection into a comment attached to your
next request. It keeps the selected text and the comment together, then sends
them in the `response-annotations` envelope that Codex understands.

It is a Pi extension and a small library. It does not add a model-facing tool
or a shortcut of its own. `pi-copy-mode` supplies the usual selection actions;
other extensions can use the same `pi-libtui/selection` capability.

## Install

This repository loads the package from `packages/pi-annotations` in Pi's
`settings.json`. To load it in another local Pi installation, install the
package directory:

```sh
pi install ./harnesses/pi/agent/packages/pi-annotations
```

The package depends on the sibling `pi-libtui` and `pi-xsettings` packages.
Keep those packages available when installing it outside this repository.

## Use it

With `pi-copy-mode` loaded:

1. Enter copy mode (`alt+z` with this repository's keybindings) and select
   text in the transcript.
2. Press `c` to write a comment or `r` to choose a reaction.
3. Enter saves the draft. Escape cancels it.
4. Submit the prompt normally. The draft becomes part of the request.

The action bar also supports mouse clicks. A draft appears as a numbered pill
in the editor. Hover it to see the selected text and comment; open it to edit
or delete the draft. Deleting a draft removes only its editor token and keeps
the surrounding prompt unchanged.

Reactions are just preset comment text. The default choices are:

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

## Settings and keybindings

Open `/xsettings` (bound to `ctrl+,` in this repository) and edit
`Interaction → Annotations → Reactions`. This is an ordered string list, so
you can add, edit, delete, and reorder choices. An empty list disables the
reaction picker until at least one choice is configured.

Keys belong to `keybindings.json`, not this package. The relevant copy-mode
actions are:

| Action | Repository default | What it does |
| --- | --- | --- |
| `copy-mode.annotate` | `c` | Open a comment draft for the selection |
| `copy-mode.react` | `r` | Open the reaction picker |

Change those bindings in the managed `harnesses/pi/agent/keybindings.json`
file. `/reload` refreshes the keybinding snapshot.

## Library API

The package export surface is intentionally pure and does not start Pi:

- Envelope helpers: `serializeEnvelope`, `parseEnvelope`,
  `projectEnvelope`, `responseAnnotations`, and `annotationText`.
- Directive projection: `projectAnnotationDirectives`.
- Draft state: `AnnotationStore`, `tokenInsertion`, `tokenPreview`,
  `removeTokenAtom`.
- Presentation helpers and types: `plainPill`, `composerPillLabel`,
  `responsePillLabel`, `transcriptPillLabel`, `AnnotationPresentationGroups`,
  and the annotation types.

For example:

```ts
import { parseEnvelope, projectEnvelope } from "pi-annotations";

const parsed = parseEnvelope(messageText);
const readable = parsed ? projectEnvelope(messageText) : messageText;
```

The extension itself composes Pi's editor, session, and Markdown hooks. It
uses `pi-libtui` for overlays and selection actions, `pi-xsettings` for the
reaction list, and contributes to the `pi-developer-prompt` capability when
that optional host is present. It does not import or require `pi-copy-mode`.

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

Reactions are serialized as ordinary annotation text. Older envelopes that
used the previous reaction spelling are still read when Pi redraws a session.

## Architecture

| Responsibility | Owner |
| --- | --- |
| Tool definition | None; this package adds no model-facing tool |
| Execution owner | `src/runtime/annotations.ts` |
| State owner | Session-scoped `AnnotationStore` |
| Native boundary | Pi's selection, editor, session, and Markdown APIs |
| Presentation owner | `src/ui/` overlays, editor projection, and transcript markers |
| Public capabilities | `src/index.ts` envelope, directive, store, presentation, and type exports |

## Troubleshooting and limits

- `c` and `r` do nothing unless a loaded extension has published a completed
  selection. In the default setup, load `pi-copy-mode` and use its action bar.
- If the reaction picker says to configure a reaction, add one under
  `/xsettings → Interaction → Annotations`.
- A selection without a stable message ID can use a best-effort screen anchor.
  A unique match in the preceding assistant text gets a stable source offset.
- On Pi 0.84.2, the package installs its custom editor only when another
  custom editor is not already configured. Pi has no composable editor
  middleware API.
- The package requires an interactive TUI for its overlays. It leaves Pi's
  normal tool execution unchanged.

Run package checks from the package directory:

```sh
bun run typecheck
bun test test
```
