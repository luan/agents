# pi-copy-mode

`pi-copy-mode` is a keyboard-driven copy mode for Pi's fullscreen transcript.
It provides a Vim-like cursor, character/line/column selection, native
clipboard copy, and actions for annotating the selected text.

It is a Pi extension, not a model-facing tool. It owns the modal selection
state and asks other extensions for comment or reaction actions through the
generic `pi-libtui/selection` registry.

## Install

This repository loads the package from `packages/pi-copy-mode` in Pi's
`settings.json`. To load it in another local Pi installation:

```sh
pi install ./harnesses/pi/agent/packages/pi-copy-mode
```

The package depends on the sibling `pi-libtui`, `pi-libactions`, and
`pi-xsettings` packages. Keep those packages available when installing it
outside this repository.

## Use it

The repository's managed `keybindings.json` uses these defaults:

| Key | Action |
| --- | --- |
| `alt+z` | Enter copy mode |
| `h`/`j`/`k`/`l`, arrows | Move the copy cursor |
| `v` or Space | Toggle character selection |
| `V` | Select complete lines |
| `ctrl+v` | Select a rectangle of terminal columns |
| `o` | Swap the active end of the selection |
| `y` | Copy and clear the selection |
| `c` | Ask the selection registry for a comment action |
| `r` | Ask the selection registry for a reaction action |
| Escape | Clear a selection or cancel a pending motion |
| `q` | Leave copy mode |
| `z` then `o` | Open the focused fold (`zo`) |
| `z` then `c` | Close the focused fold (`zc`) |
| `z` then `R` | Open all folds (`zR`) |
| `z` then `M` | Close all folds (`zM`) |

`g`/`G`, `ctrl+u`/`ctrl+d`, and `ctrl+b`/`ctrl+f` move to document and page
positions. Vim motions include `w`, `e`, `b`, `W`, `E`, `B`, `f`, `F`, `t`,
`T`, `;`, `,`, `{`, `}`, `^`, and `_`; a numeric prefix works with the bounded
motion grammar.

Mouse selection stays in Pi's native selection mode until a motion or action
adopts it. After selection, the action bar appears beside the range. Its
Comment, React, and Copy actions are clickable as well as keyboard-driven.
Confirming a comment or reaction collapses the selection to the copy cursor
and keeps copy mode active. Cancelling preserves the range.

`y` uses Pi's native clipboard path. If Pi does not provide one, the package
falls back to OSC 52 and keeps Pi's copy feedback. Column selection copies the
exact rectangle, including padding on short rows; line selection preserves
trailing spaces and its final newline.

## Settings and keybindings

Open `/xsettings` (bound to `ctrl+,` in this repository) and edit
`Interaction → Copy mode → Copy on select`. It is off by default. When it is
on, completing a mouse selection copies it immediately; when it is off, the
selection remains available for the action bar.

Every key shown above is owned by the managed
`harnesses/pi/agent/keybindings.json` file. The package supplies action IDs and
the modal matcher but does not choose global shortcuts. The main entry action
is `copy-mode.enter`; the modal actions use the `copy-mode.*` IDs shown in the
file. `/reload` rereads the managed keybinding snapshot and updates both input
handling and the footer hints.

## Integrations

- `pi-libtui/selection` publishes completed native selections and receives
  domain actions such as `selection.comment` and `selection.reaction`.
- `pi-libtui` mounts the selection action bar through the shared screen-decoration
  and pointer registries. `pi-libtui/mouse` provides viewport input and the optional
  versioned fullscreen-layout capability. Copy mode fails closed when the host
  capability is absent or incompatible.
- `pi-libactions` registers `copy-mode.enter` without registering a default
  key.
- `pi-xsettings` publishes `copyOnSelect` and appearance/cursor settings.
- `pi-annotations` consumes the comment and reaction actions when it is
  installed. Copy mode still works without it; those actions simply have no
  consumer.

## Library API

The package export surface is pure and does not start the Pi extension. It
contains:

- Keybinding contracts: `COPY_MODE_ACTIONS`, `loadCopyModeKeybindings`, and
  `matchCopyModeAction`.
- Cursor and motion helpers: `clampCursor`, `moveCursor`,
  `moveVirtualCursor`, `graphemeEnd`, and `scrollTopForCursor`, plus their
  document and point types.

Use the package export for tests or another Pi extension. The modal host and
Pi private fullscreen boundary stay behind `src/extension.ts` and
`src/runtime/`.

## Architecture

| Responsibility | Owner |
| --- | --- |
| Tool definition | None; this package adds no model-facing tool |
| Execution owner | `src/runtime/copy-mode.ts` |
| State owner | Session-scoped `CopyModeHost` |
| Native boundary | `src/runtime/fullscreen-surface.ts` consumes the optional `pi-libtui/mouse` fullscreen-layout capability for validated transcript geometry; clipboard and copy-mode semantics remain local |
| Cursor and Vim logic | `src/core/cursor.ts`, `src/core/vim-motions.ts` |
| Presentation owner | Pi's native selection plus `src/ui/screen-decoration.ts`; `pi-libtui` owns action-bar placement, compositing, pointer geometry, and lifecycle |
| Public capabilities | `src/index.ts` keybinding and cursor exports |

## Troubleshooting and limits

- Copy mode requires Pi's interactive fullscreen TUI. The entry action warns
  instead of doing anything in print or non-TUI mode.
- If `alt+z` is not available, bind `copy-mode.enter` in `keybindings.json`.
  Vim fold bindings retain their `z`-prefix defaults when they are omitted
  from a user keybinding file.
- If `c` or `r` has no effect, install an extension that consumes the
  `pi-libtui/selection` action (the repository uses `pi-annotations`).
- Pi 0.84.2 does not expose public keyboard-selection controls. The package
  validates its private fullscreen surface and fails closed outside the
  supported layout. Remove that boundary when Pi exposes the needed API.
- A custom editor or another fullscreen integration can own the same Pi
  surface. Check extension load order and reload after changing packages.

Run package checks from the package directory:

```sh
bun run typecheck
bun test test
```
