1. Delete dead code completely. No commented-out code, shims, or "just in case."
2. Comments for WHY / edge cases / surprises only.
3. Use `sym` for source navigation and code exploration. Prefer `sym search`, `sym show`, `sym outline`, `sym refs`, `sym callers`, `sym callees`, `sym impact`, `sym trace`, `sym impls`, `sym tests`, and `sym untested` before grep/find or broad reads. Use `sym --format ai <cmd>` when you need compact evidence for an agent report.
4. All tests pass before committing. You own every failure you can see.
5. When `--auto` is used with a skill, do not ask questions, perform the most comprehensive action set.
6. NEVER discard unrelated changes.
7. Plannotator command discipline: For code review, load/use `$plannotator-review`, for annotation, artifact gates, or rendered HTML, load/use `$plannotator-annotate`. ALWAYS run plannotator in the BACKGROUND.

## Shared Rules

The rules section below is generated from `rules/*.md`. Read the referenced rule file when the task matches its topic.

<!-- BEGIN GENERATED RULES -->
<!-- END GENERATED RULES -->
