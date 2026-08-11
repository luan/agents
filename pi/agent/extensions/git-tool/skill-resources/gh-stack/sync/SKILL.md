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
existing PRs with:

```bash
gs stack submit --update-only --no-web
```

`--update-only` skips a branch that has no PR. Confirm PR identity from
`gs log short` and `gh stack view --json` before submitting.

Verify the final local and native stack views. Do not use raw rebase, raw push,
or `gh stack sync`.
