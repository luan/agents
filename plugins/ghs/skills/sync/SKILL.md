---
name: sync
description: >
  Use this skill to sync a gh-stack stack with its remote and trunk. Triggers: sync, update
  from main, update from trunk, pull trunk, refresh stack.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gh stack:*)"
  - "Bash(git status)"
  - Skill
---

# Sync gh-stack Stack

Use `gh stack sync` to fetch, rebase, push, and refresh PR state in one pass. Do not use raw `git pull` plus `git rebase` for stack synchronization.

Command contracts are based on the upstream CLI reference at <https://github.github.com/gh-stack/reference/cli/>.

## Steps

1. Check current stack state: `gh stack view --short 2>&1`.
2. Run sync:

   ```bash
   gh stack sync 2>&1
   ```

   Add `--prune` when the user asks to clean up local branches for merged PRs:

   ```bash
   gh stack sync --prune 2>&1
   ```

3. If sync reports a rebase conflict, it restores every branch to its original state — use the `ghs:restack` skill to resolve the conflicts interactively.
4. If sync reports that the local and remote stacks have diverged, it aborts without pushing anything. Report the divergence and let the user choose: adopt the remote stack, delete the stack on GitHub and recreate it with `ghs:submit`, or restructure locally first.
5. Report the trunk update, branches rebased or pushed, PR statuses, and any pruned branches.

`gh stack sync` never opens new PRs — use the `ghs:submit` skill for that.
