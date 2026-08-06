---
name: restack
description: Restack Git-Spice branches while preserving native GitHub Stack identity.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(gh stack:*)"
  - "Bash(git status)"
  - "Bash(git add:*)"
  - Read
  - Edit
  - Skill
---

# Restack a native GitHub Stack

Reconcile before rewriting:

```bash
git status --short
gs log short
gh stack view --json
```

Use the narrowest command:

```bash
gs branch restack --branch <name>
gs upstack restack --branch <name>
gs stack restack --branch <name>
```

On conflict, resolve files, stage them, then run `gs rebase continue`. Abort
ambiguous work with `gs rebase abort`. Do not use raw `git rebase` or `gh stack
rebase`.

Restacking does not authorize a push. Update remote PRs only when requested,
using `gs stack submit --update-only --existing-only --no-web`.
