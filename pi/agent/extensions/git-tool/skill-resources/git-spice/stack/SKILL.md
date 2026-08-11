---
name: stack
description: Create, inspect, navigate, reorder, and merge Git-Spice stacks.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(git status)"
  - Skill
---

# Git-Spice stacks

Use `gs` for stack operations. Do not substitute raw branch creation, rebase,
or push commands.

```bash
git status --short
gs log short
```

| Goal | Command |
| --- | --- |
| Create layer | `gs branch create <name> --message <message>` |
| Navigate | `gs up`, `gs down`, `gs top`, `gs bottom`, `gs trunk` |
| Move layer | `gs branch onto <base> --branch <name> --restack=upstack` |
| Reorder stack | one `gs branch onto` per layer, from the new bottom upward |
| Restack | `gs stack restack --branch <name>` |
| Merge | `gs stack merge --branch <top> --method squash --fail-fast` |

There is no noninteractive reorder command. `gs stack edit` reorders a stack,
but it opens an editor. Reorder with one `gs branch onto <base> --branch <name>`
per layer instead, from the new bottom upward. Stop on ambiguous membership or
identity errors.
