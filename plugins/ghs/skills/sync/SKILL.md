---
name: sync
description: Sync a Git-Spice-managed GitHub Stack with trunk without implicit remote mutation.
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

# Sync a native GitHub Stack

```bash
git status --short
gs log short
gh stack view --json
gs repo sync --restack=upstack
```

Resolve conflicts, stage them, and continue with `gs rebase continue`; abort
with `gs rebase abort` when resolution is unclear.

Syncing local branches does not authorize remote updates. If requested, update
exact existing PRs with:

```bash
gs stack submit --update-only --existing-only --no-web
```

Verify the final local and native stack views. Do not use raw rebase, raw push,
or `gh stack sync`.
