# AGENTS.md instructions for this repo

1. Delete dead code completely. No commented-out code, shims, or "just in case."
2. Comments for WHY / edge cases / surprises only.
3. Use `ct sym` for lookup and code exploration.
4. All tests pass before committing. You own every failure you can see.
5. Prefer `apply_patch` for file edits, renames, creates, deletes.

## Repo Purpose

This repo is the central hub for local agent configuration. The checked-in
root `AGENTS.md` is only for working on this repo. The global instruction file
linked into Claude, Codex, OpenCode, and Pi is generated as `GLOBAL_AGENTS.md`
and is intentionally gitignored.

## Portability Rules

- Do not commit checkout-specific absolute paths in config, hooks, docs,
  rules, or scripts.
  Use `~`, `$HOME`, a Stow-managed path, or a stable command installed by
  `just setup`.
- Hook commands should go through `ct hook <name>`. Keep hook behavior
  in Rust when practical so configs are cross-platform and independent of
  where this repo is cloned.
- `just setup` must be idempotent and converge the live machine state: render,
  install local Codex plugins, stow links, install `ct`, register MCP servers,
  and validate.
- Shared configuration is the default. Tool-specific files belong under
  `claude/`, `codex/`, `opencode/`, or `pi/` only when the tool requires a
  different schema, filename, or runtime registration mechanism.

## Hook Rules

- Keep hook registrations minimal; config files should reference stable `ct`
  commands rather than repo checkout paths.
- If a hook is shared conceptually but tool schemas differ, document that in
  `docs/exceptions.md` and keep the script body shared where practical.
