---
name: absorb
description: Absorb staged fixes into the current Git-Spice layer and restack dependents.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(git status)"
  - "Bash(git add:*)"
  - Skill
---

# Absorb staged fixes

```bash
gs log short
git status --short
git add <paths>
gs commit absorb
gs log short
```

Git-Spice limits matching to commits on the current tracked layer and restacks
upstack branches. Use `--dry-run` to preview or `--no-restack` only when
explicitly deferring dependent restacks.

On conflict, resolve and stage files, then rerun the same command. Do not use
raw rebase or `gh stack modify` as a substitute.
