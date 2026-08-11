---
name: stack
description: Manage native GitHub Stacks through Git-Spice without interactive or raw Git mutations.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(gh stack:*)"
  - "Bash(gh pr view:*)"
  - "Bash(gh api:*)"
  - "Bash(git status)"
  - Skill
---

# GitHub Stacks through Git-Spice

Use `gs` for local graph mutations and submission. `gs log short` automatically
reconciles the active `.git/gh-stack`; never run an import command.

Before mutation:

```bash
git status --short
gs log short
gh stack view --json
```

Stop if branch order or PR identity cannot be reconciled exactly.

| Goal | Command |
| --- | --- |
| Create layer | `gs branch create <name> --message <message>` |
| Navigate | `gs up`, `gs down`, `gs top`, `gs bottom`, `gs trunk` |
| Move layer | `gs branch onto <base> --branch <name> --restack=upstack` |
| Reorder stack | one `gs branch onto` per layer, from the new bottom upward |
| Absorb fixes | `gs commit absorb` |
| Restack | `gs stack restack --branch <name>` |
| Update existing PRs | `gs stack submit --update-only --no-web` |
| Create requested PRs | `gs stack submit --fill --no-web` |
| Merge native Stack | `gh stack merge <stack-number> --yes --squash` |

There is no noninteractive reorder command. `gs stack edit` reorders a stack,
but it opens an editor. Reorder with one `gs branch onto <base> --branch <name>`
per layer instead, from the new bottom upward.

`--update-only` skips a branch that has no PR. It does not stop the run, and it
does not verify the remote head or base. Confirm PR identity from `gs log short`
and `gh stack view --json` before submitting.

Use `gh stack view`, `gh pr view`, and read-only `gh api` calls for inspection.
Do not substitute raw `git push`, raw rebase, `gh pr create`, or `gh stack
modify`.
