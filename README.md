# agents

Central configuration hub for Claude, Codex, Pi, and OMP.

## Philosophy

Shared configuration is the default. Tool-specific folders (`claude/`, `codex/`, `pi/`, `omp/`) exist only when a tool requires a different schema, filename, or runtime registration. See `docs/exceptions.md`.

## Layout

| Path | Purpose |
|---|---|
| `AGENTS.template.md` | Hand-edited instruction source |
| `GLOBAL_AGENTS.md` | Generated — template + `rules/*.md` (gitignored) |
| `AGENTS.md` | Repo-local guidance for working on this hub |
| `rules/` | Available as `~/.agents/rules` when this repo is cloned or linked to `~/.agents` |
| `skills/` | Available as `~/.agents/skills`; also linked to `~/.claude/skills` |

| `plugins/` | Shared plugin sources; tool folders link here |
| `crates/ct/` | `ct` Rust CLI — repo, MCP, apply-patch, and TUI helpers |
| `crates/vlt/` | `vlt` Rust CLI — blueprints vault artifact management |
| `crates/xtask/` | Task automation invoked via `cargo xtask <cmd>` |
| `docs/` | Permanent reference docs (architecture, exceptions) |


## `ct` CLI

`ct` is the primary tool installed from `crates/ct/`. It provides:

- `ct apply-patch` — raw patch apply
- `ct shell completion` — shell completions
- `ct tui usage-bar` / `ct tui usage-bars` — terminal UI helpers

Use `ct tui usage-bars --sidebar --watch` for a live sidebar.

## `vlt` CLI

`vlt` is the standalone blueprints vault CLI for artifact management, project
context docs, local BM25 search, similarity, wiki-link graph traversal, review,
and body updates. Normal artifacts use monotonically increasing numeric stems
such as `0001-topic.md`; creation dates live in frontmatter.

## Setup

```sh
just setup          # idempotent: render, link, install ct, register MCP servers, validate
just link-dry-run   # preview link targets before linking
just ct-install     # rebuild and reinstall ct + register MCP servers
```

The repo is designed to be the agents home itself. Clone it directly to
`~/.agents`, or clone it elsewhere and let `just setup` link `~/.agents` to the
checkout.

Prerequisites: `just`, `cargo`, `npm`, `claude`, `codex`.

On Windows, `cargo xtask doctor` additionally verifies that symlinks work
(requires Developer Mode) and that the repo's tracked symlinks were
materialised by Git (requires `git config --global core.symlinks true` at
clone time, otherwise re-clone or re-materialise only symlink-mode files as
shown by `cargo xtask doctor`).
