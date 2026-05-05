---
name: submit
description: >
  Use this skill to push Graphite stack changes and create or update PRs. Replaces git push
  and gh pr create for stack workflows. Triggers: push, ship it, send this up, submit,
  update PRs, create PR, push stack, send PRs.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gt:*)"
  - "Bash(git status)"
  - "Bash(git branch:*)"
  - Skill
---

# Submit Graphite Stack

Push the Graphite stack and create or update PRs.

## Modes

| Mode | Command | When |
| --- | --- | --- |
| **Default** | `gt ss -u` | Always, unless user explicitly asks otherwise |
| Single PR | `gt submit` | User explicitly says "submit this PR" or "update this PR" |
| Create new | `gt ss` | User explicitly says "create PR" or "create PRs" |

Default is `gt ss -u` (stack, update-only). This avoids accidentally creating PRs for WIP branches.

## Steps

1. Check stack health: `gt log --stack 2>&1`.
   - If restack is needed, use the `restack` skill first.
2. Submit with the selected mode:

   ```bash
   gt ss -u 2>&1
   # or gt submit / gt ss when explicitly requested
   ```

3. PR descriptions for create modes only:
   - When using `gt ss` or creating a new single PR with `gt submit`, run `Skill(pr-descr)` for each newly created PR.
   - Skip PR description work for `gt ss -u` because existing PRs already have descriptions.
4. Report Graphite URLs (`app.graphite.com/...`) for updated PRs. Do not report GitHub URLs as the primary result.
