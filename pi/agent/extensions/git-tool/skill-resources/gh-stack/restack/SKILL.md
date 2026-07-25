---
name: restack
description: >
  Use this skill to rebase gh-stack branches and resolve conflicts. Replaces raw git rebase
  for stack workflows. Triggers: restack, rebase, rebase on main, branches out of date,
  resolve conflicts.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gh stack:*)"
  - "Bash(git add:*)"
  - "Bash(git status)"
  - Read
  - Edit
  - Glob
  - Grep
---

# Rebase gh-stack Stack

Cascade-rebase every branch in the stack onto its parent and resolve conflicts.

Command contracts are based on the upstream CLI reference at <https://github.github.com/gh-stack/reference/cli/>.

## Steps

1. Run `gh stack rebase 2>&1`.
   - `--downstack` rebases only from trunk up to the current branch.
   - `--upstack` rebases only from the current branch to the top.
   - `--no-trunk` rebases stack branches onto each other without fetching or touching trunk.
2. If clean, report which branches were rebased.
3. If conflicts occur, loop until resolved:
   - Read each conflicted file in full before editing; the CLI prints the conflicted files with line numbers.
   - Identify all conflict markers: `<<<<<<<`, `=======`, `>>>>>>>`.
   - Resolve every conflict region in a single edit; never leave partial markers.
   - Run `rg -c '<<<<<<<' <file>` to verify no conflict markers remain.
   - `git add <file>` each resolved file.
   - Continue with `gh stack rebase --continue 2>&1`.
   - If new conflicts appear on another branch, repeat.
4. Report branches rebased, conflicts resolved, and any issues.

If conflict resolution is ambiguous, run `gh stack rebase --abort` to restore all branches to their pre-rebase state and report the blocker to the user.
