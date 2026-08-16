# agents

Central configuration hub for Claude, Codex, Pi, and OMP.

## Philosophy

Shared configuration is the default. Tool-specific folders (`claude/`, `codex/`, `pi/`, `omp/`) exist only when a tool requires a different schema, filename, or runtime registration. See `docs/exceptions.md`.

## Layout

| Path | Purpose |
|---|---|
| `GLOBAL_AGENTS.md` | Global instructions — hand-edited, linked into Claude, Codex, and Pi |
| `AGENTS.md` | Repo-local guidance for working on this hub |
| `skills/` | Available as `~/.agents/skills`; also linked to `~/.claude/skills` |
| `crates/vlt/` | `vlt` Rust CLI — blueprints vault artifact management |
| `crates/xtask/` | Task automation invoked via `cargo xtask <cmd>` |
| `crates/apply-patch/` | `apply_patch` CLI — fork of `openai/codex`, see its `UPSTREAM.md` |
| `crates/code-mode*/` | `codex-code-mode-host` and its protocol — fork of `openai/codex`, see `crates/code-mode/UPSTREAM.md` |
| `docs/` | Permanent reference docs (architecture, exceptions) |

The `crates/apply-patch/` and `crates/code-mode*/` crates are forks, not vendored copies. Each
carries an `UPSTREAM.md` recording its pin and every local divergence. Update them by hand.


## `vlt` CLI

`vlt` is the standalone blueprints vault CLI for artifact management, project
context docs, local BM25 search, similarity, wiki-link graph traversal, review,
and body updates. Normal artifacts use monotonically increasing numeric stems
such as `0001-topic.md`; creation dates live in frontmatter.

## Setup

```sh
just setup          # idempotent: link, install tools, validate
just link-dry-run   # preview link targets before linking
just install        # rebuild the Rust Code Mode and apply-patch hosts, vlt, and Git-Spice
```

The repo is designed to be the agents home itself. Clone it directly to
`~/.agents`, or clone it elsewhere and let `just setup` link `~/.agents` to the
checkout.

Prerequisites: `just`, `cargo`, `go`, `bun`, `claude`, `codex`.

On Windows, `cargo xtask doctor` additionally verifies that symlinks work
(requires Developer Mode) and that the repo's tracked symlinks were
materialised by Git (requires `git config --global core.symlinks true` at
clone time, otherwise re-clone or re-materialise only symlink-mode files as
shown by `cargo xtask doctor`).
