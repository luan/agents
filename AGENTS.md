# AGENTS.md instructions for this repo

1. Delete dead code completely. No commented-out code, shims, or "just in case."
2. Comments for WHY / edge cases / surprises only.
3. Use `ct source` for lookup and code exploration.
4. All tests pass before committing. You own every failure you can see.
5. After changing `ct`, run `just install` so the live `ct` binary matches the repo.
6. Task discipline: if you create or select a task and then execute it in the same session, immediately mark it `in_progress` and assign it to the current session before editing files. Leave tasks open/unassigned only when you are handing them off for future work.

## Repo Purpose

This repo is the central hub for local agent configuration. The checked-in
root `AGENTS.md` is only for working on this repo. The global instruction file
linked into Claude, Codex, and Pi is generated as `GLOBAL_AGENTS.md`
and is intentionally gitignored.

## Portability Rules

- Do not commit checkout-specific absolute paths in config, docs, rules, or
  scripts.
  Use `~`, `$HOME`, a Stow-managed path, or a stable command installed by
  `just setup`.
- `just setup` must be idempotent and converge the live machine state: render,
  install local Codex plugins, stow links, install `ct`, register MCP servers,
  and validate.
- Shared configuration is the default. Tool-specific files belong under
  `claude/`, `codex/`, or `pi/` only when the tool requires a
  different schema, filename, or runtime registration mechanism.
