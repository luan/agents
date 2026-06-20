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

## Default delivery workflow

The intended default product-feature workflow is `$grill -> $brief -> $issues -> $implement`.
QRDSPI skills remain available in source for expert/manual use, but are hidden from
default model invocation. `$vibe` is intentionally deleted rather than kept as a stub.
| `plugins/` | Shared plugin sources; tool folders link here |
| `crates/ct/` | `ct` Rust CLI — repo, MCP, apply-patch, and TUI helpers |
| `crates/vlt/` | `vlt` Rust CLI — blueprints vault artifact management |
| `crates/sym/` | Canonical source-navigation CLI and Tree-sitter symbol indexer |
| `crates/xtask/` | Task automation invoked via `cargo xtask <cmd>` |
| `docs/` | Permanent reference docs (architecture, exceptions) |

## Source navigation

`sym` is the canonical read-only source-navigation CLI. It stores its index in
the central platform cache, not in the working tree, and supports compact AI
output for agent context.

Use one coherent source-navigation loop: **Orient → locate → inspect → relate → assess**.

```sh
sym stats                         # orient: repo size and languages
sym map --level 2                 # orient: files with symbol counts
sym query Parser                  # locate: friendly symbol lookup
sym search --text "TODO"          # locate: text search
sym inspect crates/ct/src/main.rs # inspect: file-local symbols
sym callers run_source            # relate: direct callers
sym callees run_source            # relate: direct callees
sym types source_types_value      # assess: signature type definitions
sym schema SourceTypesRequest     # assess: data fields
sym tests run_source              # assess: tests referencing a symbol
sym test-deps test_run_source     # assess: production callees from a test
sym untested --lang rust          # assess: symbols without indexed test refs
sym diff run_source main          # assess: symbol-scoped diff
```

Use `sym --format ai <cmd>` when an agent report needs compact structured
evidence.

## `ct` CLI

`ct` is the primary tool installed from `crates/ct/`. It provides:

- `ct repo` — repository identity, branch context, references, cochanges, and churn
- `ct apply-patch` — raw patch apply plus apply_patch telemetry and drafts
- `ct shell completion` — shell completions
- `ct tui usage-bar` / `ct tui usage-bars` — terminal UI helpers
- `ct dev` — developer/internal helpers; raw backends live under `ct dev debug`

Configure `ct tui usage-bars` provider visibility and order in `~/.config/ct/config.toml`:

```toml
[usage_bars]
providers = ["claude", "codex"]
```

Use `ct tui usage-bars --sidebar --watch` for a live sidebar; it rereads the config on every redraw.

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
