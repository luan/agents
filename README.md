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
| `rules/` | Linked to `~/.agents/rules`; sourced by generated instructions |
| `skills/` | Linked to `~/.agents/skills` and `~/.claude/skills` |
| `hooks/` | Python hook integrations (tool-specific formats) |
| `plugins/` | Shared plugin sources; tool folders link here |
| `crates/ct/` | `ct` Rust CLI — vault, sym, hooks, MCP, apply-patch |
| `crates/sym/` | Tree-sitter symbol indexer (library + `sym` binary) |
| `crates/xtask/` | Task automation invoked via `cargo xtask <cmd>` |
| `docs/` | Permanent reference docs (architecture, exceptions) |

## `ct` CLI

`ct` is the primary tool installed from `crates/ct/`. It provides:

- `ct vault` — blueprint artifact management (create, read, list, archive, commit)
- `ct sym` — code indexing and symbol discovery
- `ct hook` — run harness hooks
- `ct mcp vault` — MCP server for vault operations
- `ct mcp apply-patch` — MCP server for deferred file patching
- `ct mcp sym` — MCP server for agent-native code navigation
- `ct notify` — notification hooks
- `ct tool` — utilities (completions, etc.)

## Setup

```sh
just setup          # idempotent: render, link, install ct, register MCP servers, validate
just link-dry-run   # preview stow targets before linking
just ct-install     # rebuild and reinstall ct + register MCP servers
```

Prerequisites: `stow`, `just`, `cargo`, `claude`, `codex`, `opencode`.
