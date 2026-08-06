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
| Reorder stack | `gs stack reorder <bottom> ... <top>` |
| Absorb fixes | `gs commit absorb` |
| Restack | `gs stack restack --branch <name>` |
| Update existing PRs | `gs stack submit --update-only --existing-only --no-web` |
| Create requested PRs | `gs stack submit --fill --no-web` |
| Merge native Stack | `gh stack merge <stack-number> --yes --squash` |

Use `gh stack view`, `gh pr view`, and read-only `gh api` calls for inspection.
Do not substitute raw `git push`, raw rebase, `gh pr create`, or `gh stack
modify`.
