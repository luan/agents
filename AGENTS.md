# AGENTS.md instructions for this repo

1. Delete dead code completely. No commented-out code, shims, or "just in case."
2. Comments for WHY / edge cases / surprises only.
3. All tests pass before committing. You own every failure you can see.
4. After changing `ct`, run `just install` so the live `ct` binary matches the repo.
5. Task discipline: if you create or select a task and then execute it in the same session, immediately mark it `in_progress` and assign it to the current session before editing files. Leave tasks open/unassigned only when you are handing them off for future work.
6. Review discipline: never leave a feature/bug task `in_progress` while waiting for human review, Plannotator feedback, code-review approval, or manual-verification approval. Move it to `in_review` before the wait; move it back to `in_progress` only while actively revising.
7. Plannotator discipline: never run `plannotator --help`, subcommand `--help`, or other discovery probes. For code review, load/use `$plannotator-review`; for annotation, artifact gates, or rendered HTML, load/use `$plannotator-annotate`; for latest assistant message annotation, load/use `$plannotator-last`; run only the commands documented in the loaded skill. Run Plannotator commands in the foreground without shell/tool timeout wrappers and without backgrounding so returned feedback is captured.
8. Process discipline: long-running services are managed sessions, not blocking foreground commands.
9. Do not write tests that assert mutable skill instruction wording, read skill Markdown to enforce process policy, or otherwise make intentional skill edits fail tests. Skill files are operator-authored instructions, not executable contracts.
10. Do not add tests for Pi extensions unless they cover specific, non-visual logic. Do not test rendering, animation, spacing, colors, glyphs, or other subjective TUI presentation.

## Repo Purpose

This repo is the central hub for local agent configuration. The checked-in
root `AGENTS.md` is only for working on this repo. The global instruction file
linked into Claude, Codex, Pi, and OMP is generated as `GLOBAL_AGENTS.md`
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
