# @luan.sh/pi-prompt-storage&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-prompt-storage)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-prompt-storage)

`@luan.sh/pi-prompt-storage` is a Pi extension that adds a per-directory prompt
stash and a searchable history of past user prompts to Pi's editor. It stores
both in a local SQLite database, indexes session files lazily, and merges the
current session's prompts live.

It is not a model-facing tool. It registers no tools and no side-panel tabs; it
wraps the editor's input handling, adds one slash command, and draws a one-line
widget above the editor.

## Preview

![@luan.sh/pi-prompt-storage in Bootty](https://pi.luan.sh/media/previews/pi-prompt-storage-5627a140e645.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-prompt-storage-8e5eab2e63de.mp4).

## Install

```sh
pi install npm:@luan.sh/pi-prompt-storage
```

That is the only step. The shared editor layer, picker panel, and theme helpers
the package needs ship inside it; Pi's own `@earendil-works/pi-coding-agent`
and `@earendil-works/pi-tui` come from the host Pi installation. No native
module is built or downloaded.

## Use it

### Stash

`ctrl+s` in the editor does one of two things, based on the editor content:

- Editor has text: the draft is stashed for the current working directory and
  the editor is cleared.
- Editor is empty: with one stash, it is popped straight into the editor. With
  more than one, the Prompt Stash picker opens.

Stashes are scoped to the directory Pi was started in; the picker only lists
stashes made from the same directory.

The Prompt Stash picker is a full-width panel anchored to the bottom of the
screen. Keys inside it:

| Key | Action |
| --- | --- |
| Enter | Pop: put the stash in the editor and delete it |
| `ctrl+a` | Apply: put the stash in the editor and keep it |
| `ctrl+x` | Drop: delete the stash; the picker reopens on the row above |
| `/` | Filter by stash text or directory |
| `j`/`k`, arrows | Move |
| Escape | Cancel |

### History

`/prompt-history` opens the Prompt History picker: a centred overlay that
fuzzy-filters every indexed user prompt for the current directory by prompt
text or session name, with matching characters highlighted. Enter applies the
selected prompt to the editor; `ctrl+p`/`ctrl+n`, arrows, and Page Up/Down
move; Escape or `ctrl+c` cancels. Rows show the session name (or `History`), a
timestamp, a preview, the directory, and an image marker when the original
message included an image. Results are ranked by relevance (exact phrase, then
substring, then fuzzy match) and by recency within the same score.

While the background index is still running, the panel shows an
`Indexing sessions N/M…` or `Indexing prompts N/M…` line that updates live.

### Applying over a draft

Applying or popping while the editor holds a different non-empty draft first
stashes that draft, then replaces it. The notification says
`current draft auto-stashed` when this happens.

### Editor history

When a session starts, the current session branch's user prompts are preloaded
into the editor's up-arrow history, so earlier prompts are reachable without
opening a picker.

### Stash widget

When at least one stash exists for the directory, a single muted row appears
above the editor: `Prompt stash (1)` for one stash, or
`Prompt stash (N) • <latest text>` for several. It disappears when the last
stash is popped or dropped.

## Storage and indexing

The database is `$XDG_STATE_HOME/pi/prompt-storage.sqlite`, or
`~/.local/state/pi/prompt-storage.sqlite` when `XDG_STATE_HOME` is unset. It
opens in WAL mode through `bun:sqlite` when Pi runs under Bun or `node:sqlite`
when it runs under Node.

Tables: `stashes` (text, cwd, created_at), `history_prompts` (one row per user
message per session file), and `session_index` (per-session modification time
so unchanged files are skipped). Indexing runs when a session starts, covers
Pi's session files for the current directory, and repeats at most once every 30
seconds per directory. Each session file is written in its own transaction so
one bad file does not block the rest. Prompts from the live session are merged
into history results without waiting for the index. Only user messages with
text content are indexed; prompts starting with `/` are included.

## Settings

There are no user-facing settings and the package does not use
`@luan.sh/pi-xsettings`. Configuration is hard-coded in `src/config.ts`:

| Key | Value | Effect |
| --- | --- | --- |
| `shortcuts.stash` | `ctrl+s` | Editor key for stash/pop |
| `history.includeSlashCommands` | `true` | Index prompts that start with `/` |
| `history.maxResults` | `120` | Cap on history picker results |
| `picker.maxVisible` | `10` | Rows shown at once in either picker |
| `picker.enterAction` | `pop` | What Enter does in the stash picker |

These values cannot be changed at runtime or through any settings file.

## Keybinding notes

This package registers no configurable actions, so nothing in it is bound
through Pi's `keybindings.json`. `ctrl+s` is intercepted directly in the editor
input path; any other extension or terminal binding on `ctrl+s` will conflict.
The picker keys (`ctrl+a`, `ctrl+x`, Enter, Escape) are fixed; in the history
picker Enter also honours Pi's `tui.select.confirm` keybinding.

Without a TUI (print mode), the editor layer and widget are not installed and
`/prompt-history` only reports "No prompt history found." style notifications.

## Layout

| Responsibility | File |
| --- | --- |
| Pi hooks, `ctrl+s` handling, `/prompt-history`, stash widget | `src/extension.ts` |
| Fixed configuration | `src/config.ts` |
| Types, search ranking, previews, widget text | `src/core/model.ts` |
| SQLite storage, session indexing, progress events | `src/runtime/store.ts` |
| Bun/Node SQLite driver selection | `src/native/sqlite.ts` |
| Stash and history pickers | `src/ui/picker.ts` |
| Public exports (`filterPrompts`, `queryMatchIndexes`, `PromptStorageStore`, types) | `src/index.ts` |

## Develop

Source: https://github.com/luan/agents, directory
`harnesses/pi/agent/packages/pi-prompt-storage`. Run `bun run typecheck` and
`bun test test` in that directory.

Tests cover search ranking and highlighting (`test/model.test.ts`), the stash
picker's keys and overlay placement (`test/picker.test.ts`), and the widget
line (`test/widget.test.ts`), and storage shutdown, prompt indexing, and stash
ordering (`test/store.test.ts`).
