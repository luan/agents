---
name: stack
description: >
  Use this skill for GitHub Stacked PRs (gh-stack) stack status, branch creation, stack
  navigation, restructuring a stack, or general gh-stack operations. Replaces raw git
  checkout -b, git rebase, git push, and gh pr create for stack workflows.
user-invocable: true
allowed-tools:
  - "Bash(gh stack:*)"
  - "Bash(git status)"
argument-hint: "[view|init|add|up|down|top|bottom|link|unstack|...] [flags]"
---

# GitHub Stacked PRs Stack

Use `gh stack` for stacked branch workflows in this repository.

Command contracts are based on the upstream CLI reference at <https://github.github.com/gh-stack/reference/cli/>.

## Quick Reference

```bash
# Create branches
gh stack init <name>                 # Start a stack; adopts existing branches, creates missing ones
gh stack init --base develop <name>  # Stack on a non-default trunk
gh stack add <name>                  # New branch on top of the stack; must be on the topmost branch

# Inspect
gh stack view --short                # Branch names only; use by default
gh stack view --json                 # Machine-readable stack data

# Navigate
gh stack up [n] / gh stack down [n]
gh stack top / gh stack bottom

# Remote
gh stack push                        # Push every branch (--force-with-lease --atomic); no PRs
gh stack submit --auto               # Push and create/update PRs and the stack on GitHub
gh stack sync                        # Fetch, rebase, push, sync PR state
gh stack rebase                      # Cascading rebase across the stack
gh stack link <branch-or-pr>...      # Link existing PRs into a stack without local tracking

# Teardown
gh stack unstack                     # Unstack on GitHub and drop local tracking
gh stack unstack --local             # Drop local tracking only
```

## Interactive Commands

These require a TTY and cannot be driven from a tool call. Ask the user to run them:

- `gh stack modify` — restructure the stack (drop, fold, insert, reorder, rename)
- `gh stack switch`, `gh stack checkout` with no arguments — branch/stack pickers
- `gh stack submit` without `--auto` — full-screen PR editor

Non-interactive alternative to `gh stack modify`: `gh stack unstack --local`, then `gh stack init <bottom> <...> <top>` to re-declare the structure; existing branches are adopted.

## Branch Creation Rules

`gh stack init` starts a stack and tracks its first branch. `gh stack add` adds each layer above, and must run while the topmost branch is checked out.

- Always pass a branch name.
- Never pass `-A`, `-u`, or `-m` to `gh stack add`; those stage and commit for you and auto-generate a date+slug branch name.
- Create the branch first, then commit separately with `git commit` or `/commit`.

```bash
# Correct
gh stack add luan/my-feature
git add -A && git commit -m "feat(scope): add feature"

# Wrong
gh stack add -Am "feat(scope): add feature"
```

## Stack Structure

```text
main (trunk)
  └── feature-1  ← bottom, toward trunk
        └── feature-2
              └── feature-3  ← top, away from trunk
```

- `up` means toward the top, away from trunk.
- `down` means toward trunk.

Every PR in the stack is evaluated against the bottom PR's base (usually `main`), so branch protection rules and CI apply to every layer.

## When to Stack

Split large or multi-concern changes into small, independently reviewable PRs. Good split candidates include utility code, new interfaces, tests before behavior changes, mechanical refactors, schema changes, and UI scaffolding.

Before splitting a non-trivial change, present a stack table with PR title and summary for each branch and get user feedback.

## Forbidden Replacements

Never use these raw commands for stack workflows:

| Forbidden | Use instead |
| --- | --- |
| `git checkout -b` | `gh stack init` / `gh stack add` |
| `git rebase` | `ghs:restack` skill / `gh stack rebase` |
| `git push` / `git push --force` | `ghs:submit` skill |
| `gh pr create` | `ghs:submit` skill |
