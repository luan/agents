---
name: absorb
description: Absorb staged fixes into matching commits on the current Git-Spice layer.
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
```

Git-Spice limits matching to the current tracked layer and restacks dependent
branches. Use `--dry-run` to preview and `--no-restack` only when explicitly
requested. Resolve conflicts, stage files, and rerun the same command.
