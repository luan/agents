# agents

Central configuration hub for Claude, Codex, OpenCode, and Pi.

## Philosophy

Shared configuration is the default. Tool-specific folders (`claude/`, `codex/`, `opencode/`, `pi/`) exist only when a tool requires a different schema, filename, or runtime registration. See `docs/exceptions.md`.

## Layout

| Path | Purpose |
|---|---|
| `AGENTS.template.md` | Hand-edited instruction source |
| `GLOBAL_AGENTS.md` | Generated — template + `rules/*.md` (gitignored) |
| `AGENTS.md` | Repo-local guidance for working on this hub |
| `rules/` | Available as `~/.agents/rules` when this repo is cloned or linked to `~/.agents` |
| `skills/` | Available as `~/.agents/skills`; also linked to `~/.claude/skills` |
| `hooks/` | Python hook integrations (tool-specific formats) |
| `plugins/` | Shared plugin sources; tool folders link here |
| `crates/ct/` | `ct` Rust CLI — source, lens, vault, repo, hooks, MCP, apply-patch |
| `crates/sym/` | Tree-sitter symbol indexer (library + `sym` binary) |
| `crates/xtask/` | Task automation invoked via `cargo xtask <cmd>` |
| `docs/` | Permanent reference docs (architecture, exceptions) |

## `ct` CLI

`ct` is the primary tool installed from `crates/ct/`. It provides:

- `ct source` — read-only source search, navigation, graph, and scoped diff
- `ct lens` — hook-driven diagnostics, session health, and local inspection commands
- `ct vault` — blueprint artifact management (create, read, list, archive, commit)
- `ct repo` — repository identity, branch context, references, cochanges, and churn
- `ct apply-patch` — raw patch apply plus apply_patch telemetry and drafts
- `ct hook` — run harness hooks, including notifications and Lens lifecycle hooks
- `ct shell completion` — shell completions
- `ct tui usage-bar` — terminal UI helpers
- `ct dev` — developer/internal helpers; raw backends live under `ct dev debug`

## Setup

```sh
just setup          # idempotent: render, link, install ct, register MCP servers, validate
just link-dry-run   # preview link targets before linking
just ct-install     # rebuild and reinstall ct + register MCP servers
```

The repo is designed to be the agents home itself. Clone it directly to
`~/.agents`, or clone it elsewhere and let `just setup` link `~/.agents` to the
checkout. The setup task migrates the old managed `~/.agents/rules` and
`~/.agents/skills` symlinks when they are still owned by this repo.

Prerequisites: `just`, `cargo`, `npm`, `claude`, `codex`, `opencode`.

On Windows, `cargo xtask doctor` additionally verifies that symlinks work
(requires Developer Mode) and that the repo's tracked symlinks were
materialised by Git (requires `git config --global core.symlinks true` at
clone time, otherwise re-clone or re-materialise only symlink-mode files as
shown by `cargo xtask doctor`).
