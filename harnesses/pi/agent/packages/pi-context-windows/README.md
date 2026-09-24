# pi-context-windows

Recoverable context windows, searchable history, and working notes for Pi.
Uses public Pi APIs; no Pi fork or remote history service is required.

## Install

From this repository:

```sh
pi install ./harnesses/pi/agent/packages/pi-context-windows
```

Enable the tools below in Pi's tool selection. With Code Mode installed,
history, notes, and `get_context_remaining` can run under `exec`. Keep
`new_context` direct. The managed harness already configures these choices.

## Context recovery

The model saves its goal, decisions, progress, remaining work, and evidence
references in a note, then calls `new_context({})`. All tools in that batch
finish and persist before the window changes. The next request contains a
recovery checkpoint and subsequent messages. Session identity, tool processes,
workspace, pending questions, and the full transcript survive.

The checkpoint contains recent user requests, prior recovery context, and note
excerpts, capped at 36,000 characters. Full notes and history remain available
through tools. Automatic compaction creates a recovery window too. Enable **Generated recovery summaries** in Context Windows settings to add a
cumulative model-written summary alongside notes. With Codex Native installed,
it also generates an encrypted Codex checkpoint and replays it in the new
window. Both are saved together, including in tree archives and resumed sessions.
The readable summary remains usable when switching providers. This adds one
isolated summary request and, on Codex, one native checkpoint request per rollover. With the default setting off, the bounded
checkpoint uses saved notes and recent requests without a model call. Token reporting returns `tokens_left: null` until provider
usage exists for the new window.

Window and item IDs are opaque and stable on resume and inherited branches.
History and notes follow the active branch. Switching to an earlier branch
restores its notes and window boundary. Invalid saved windows abort the request
instead of silently restoring old context.

## Summaries and tree archives

**Context archives → Tree** moves completed windows to Pi side branches. The
new active branch carries the checkpoint, latest notes, and durable extension
records, including pending questions. History tools follow explicit archive
links, so old windows remain searchable without exposing unrelated branches.
The default **Local** mode keeps the original transcript in the active branch
and projects only the current window into requests.

When navigating a branch with summarization enabled, a generated handoff is
saved as a note and the branch summary points the agent to that note. Summary
failures leave the outgoing window intact. Settings use namespace
`pi-context-windows`: `hybrid` defaults to false and `archiveMode` to `local`.

## Tools

Tool rows show note paths, result counts, and available context space. Notes
and history have bounded text previews; expand a row for more content and
history references. The same presentation is used for direct and Code Mode calls.

Pi flattens namespaces with two underscores: `history__read_item` corresponds
to `history.read_item`.

| Tool | Arguments and behavior |
| --- | --- |
| `new_context` | `{}`; queues rollover, returns `accepted: true`. |
| `get_context_remaining` | `{}`; remaining tokens or `null`. |
| `history__list_windows` | Optional `agent_name`, `recent_first`, `limit`. |
| `history__list_items` | Filter by agent, window, role, tool name or namespace; optional `recent_first`, `limit`, `max_chars_per_item`. |
| `history__read_item` | Required `window_id`, `item_id`; optional `agent_name`, `offset_chars`, `limit_chars`. Returns `next_offset`. |
| `history__search_contents` | Literal, case-sensitive `query`, with the same history filters. |
| `notes__write_file` | `path`, `text`; create or replace. |
| `notes__append_to_file` | `path`, `text`; append, creating when absent. |
| `notes__read_file` | `path`; optional inclusive `start_line`, `stop_line`. Lines start at 1; negative numbers count from the end. |
| `notes__list_files_by_prefix` | Optional `prefix`, `max_results`, `file_order_by` (`name`, `created_at`, `updated_at`), `file_order` (`ascending`, `descending`). |
| `notes__search_contents` | Literal `query`; optional `prefix`, `max_results`. Returns matching line numbers. |

Notes are virtual files stored in Pi's session log, not workspace files.
`checkpoint.md` belongs to the caller; `/root/notes/checkpoint.md` belongs to the
root; `/root/research/notes/findings.md` belongs to its research agent. Malformed
paths and parent traversal are rejected. Each note is limited to 1,000,000
UTF-8 bytes; use another file for additional material.

Agent names are relative to the caller unless they start with `/root`.
`pi-subagents` records versioned identities and transcript paths, allowing
same-tree history and note access, including closed children in other working
directories. Unrelated trees are excluded. Calls in one process see preceding
writes immediately. As with Pi session files, a transcript has one owning Pi
process; concurrent independent Pi processes must not edit the same session.

## Architecture

The package was renamed from `@luan.sh/pi-context`. Existing session records
and the `pi-context/window/v1` protocol retain their stable identifiers, so
saved notes and windows continue to work.

`pi-codex-native` detects the optional `pi-context/window/v1` capability. It
defers compaction, drops old transport continuation on rollover, and prevents
stale remote checkpoints from restoring discarded context. The optional
`pi-context/checkpoint/v1` capability prepares provider-owned checkpoints;
Context Windows stores their opaque strings with the matching window and
never interprets provider serialization. Without a checkpoint provider,
generated recovery uses readable summaries alone. Without this
extension, native compaction retains its existing behavior.

| Responsibility | Owner |
| --- | --- |
| Tool schemas and execution | `src/tools/history`, `notes`, `new-context` |
| Durable validation and history normalization | `src/core/state.ts`, `history.ts` |
| Projection and batch boundary | `src/runtime/windows.ts` |
| Generated summaries and tree navigation | `src/runtime/summary.ts`, `tree.ts` |
| Session-tree lookup | `src/runtime/sessions.ts` |
| Optional provider capability | `src/protocol/context-window.ts`, exported by `./sdk` |
| Model instructions | `src/contributions/prompt.ts` |
| Native boundary | None; Pi owns persistence |
| Presentation | `src/tools/presentation.ts`; shared `ToolActivity` previews and disclosure |

See [Conversation and context recovery](../../../../../docs/pi-context-and-conversation.md).
