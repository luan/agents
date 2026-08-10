# AGENTS.md instructions for this repo

1. Delete dead code completely. No commented-out code, shims, or "just in case."
2. Comments for WHY / edge cases / surprises only.
3. All tests pass before committing. You own every failure you can see.
4. After changing `ct`, run `just install` so the live `ct` binary matches the repo.
5. Task discipline: if you create or select a task and then execute it in the same session, immediately mark it `in_progress` and assign it to the current session before editing files. Leave tasks open/unassigned only when you are handing them off for future work.
6. Review discipline: never leave a feature/bug task `in_progress` while waiting for human review, Plannotator feedback, code-review approval, or manual-verification approval. Move it to `in_review` before the wait; move it back to `in_progress` only while actively revising.
7. Plannotator discipline: never run `plannotator --help`, subcommand `--help`, or other discovery probes. For code review, load/use `$plannotator-review`; for annotation, artifact gates, or rendered HTML, load/use `$plannotator-annotate`; for latest assistant message annotation, load/use `$plannotator-last`; run only the commands documented in the loaded skill. Run Plannotator commands in the foreground without shell/tool timeout wrappers and without backgrounding so returned feedback is captured.
8. Process discipline: long-running services are managed sessions, not blocking foreground commands.
9. Tests are exceptional. Add one only for deterministic logic with a plausible regression that direct validation cannot cover more cheaply. Prefer no test for wiring, configuration, trivial adapters, wrappers, or pass-through behavior.
10. Test behavior, not presentation. Never assert rendered text, snapshots, labels, spacing, widths, colors, glyphs, animation frames, or other TUI output. Delete presentation-only tests instead of updating them.
11. Skill files are operator-authored instructions. Never test their wording or read them from tests to enforce process policy.

## Repo Purpose

This repo is the central hub for local agent configuration. The checked-in
root `AGENTS.md` is only for working on this repo. The global instruction file
linked into Claude, Codex, Pi, and OMP is `GLOBAL_AGENTS.md`: a static,
hand-edited file. Keep it minimal: it holds only what applies to every task.

Anything scoped to one language, tool, or kind of work becomes a **skill**
instead. A skill's `description` is its pointer; instruction files name no
paths.

Subagents inherit core Pi skill discovery. They can load available skills with
`read skill://<name>` and relative skill files with
`read skill://<name>/<relative-path>`. Do not assume parent-only skill content
is already loaded.

## Portability Rules

- Do not commit checkout-specific absolute paths in config, docs, rules, or
  scripts.
  Use `~`, `$HOME`, a Stow-managed path, or a stable command installed by
  `just setup`.
- `just setup` must be idempotent and converge the live machine state: install
  local Codex plugins, stow links, install `ct`, register MCP servers, and
  validate.
- Shared configuration is the default. Tool-specific files belong under
  `claude/`, `codex/`, or `pi/` only when the tool requires a
  different schema, filename, or runtime registration mechanism.
