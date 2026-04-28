# Agent Instructions

1. Delete dead code completely. No commented-out code, shims, or "just in case."
2. Comments for WHY / edge cases / surprises only.
3. Use `ct source` for lookup and code exploration.
4. All tests pass before committing. You own every failure you can see.
5. For any file search or grep in the current git-indexed directory, use fff tools.
   When constraining `fffgrep`/`ffffind` to a directory, include the trailing
   slash (`src/`, not `src`) so the constraint is treated as a directory.

## Shared Rules

The rules section below is generated from `rules/*.md`. Read the referenced rule file when the task matches its topic.

<!-- BEGIN GENERATED RULES -->
<!-- END GENERATED RULES -->
