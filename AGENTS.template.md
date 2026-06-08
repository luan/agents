# Agent Instructions

1. Delete dead code completely. No commented-out code, shims, or "just in case."
2. Comments for WHY / edge cases / surprises only.
3. Use `sym` for source navigation and code exploration. Prefer `sym search`, `sym show`, `sym outline`, `sym refs`, `sym callers`, `sym callees`, `sym impact`, `sym trace`, `sym impls`, `sym tests`, and `sym untested` before grep/find or broad reads. Use `sym --format ai <cmd>` when you need compact evidence for an agent report.
4. All tests pass before committing. You own every failure you can see.
5. When `--auto` is used with a skill, do not ask questions, perform the most comprehensive action set.
6. NEVER discard unrelated changes.
7. Task discipline: if you create or select a task and then execute it in the same session, immediately mark it `in_progress` and assign it to the current session before editing files. Leave tasks open/unassigned only when you are handing them off for future work.
8. Task labels are optional metadata, not a required field. Use labels only for useful cross-cutting filters that are not already obvious from the project, epic, title, type, or parent. Do not add redundant project-name labels.
9. When creating tasks you intend to work on immediately, create them already assigned to the current session and/or immediately update them to `in_progress` before editing.
10. Plannotator command discipline: never run `plannotator --help`, subcommand `--help`, or other discovery probes. For any Plannotator review, gate, HTML render, or setup-goal browser session, load/use `$plannotator` and run only the commands documented there.

## Shared Rules

The rules section below is generated from `rules/*.md`. Read the referenced rule file when the task matches its topic.

<!-- BEGIN GENERATED RULES -->
<!-- END GENERATED RULES -->
