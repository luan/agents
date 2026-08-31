# pi-prompt-storage

`pi-prompt-storage` adds a local prompt stash and searchable history picker.
`ctrl+s` stashes a non-empty draft, or pops/applies a stash when the editor is
empty. Prompt history is available through `/prompt-history`. Applying a
replacement automatically stashes a non-empty draft first. The above-editor
widget stays to one row: count only for one stash, or count plus the latest item
for multiple stashes.

The SQLite database lives at `$XDG_STATE_HOME/pi/prompt-storage.sqlite`, or
`~/.local/state/pi/prompt-storage.sqlite` when `XDG_STATE_HOME` is unset.
Session history is indexed lazily and current-session prompts are merged live.

The picker uses `pi-libtui`'s semantic input, selectable-list, editor-layer,
and overlay contracts. It can load independently; without a TUI it leaves
Pi's normal editor and command flow unchanged.

## Architecture

| Responsibility | Owner |
| --- | --- |
| Tool definition | None; this package adds no model-facing tool |
| Execution owner | `src/runtime/store.ts` |
| State owner | `PromptStorageStore` and session-scoped picker state |
| Native boundary | `src/native/sqlite.ts` and Pi `SessionManager` |
| Presentation owner | `src/ui/picker.ts` and the above-editor stash widget |
| Public capabilities | `src/index.ts` pure search and prompt contracts |

Run `bun run typecheck` and `bun test test` from this package directory.
