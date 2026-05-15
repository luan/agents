---
name: gt:submit
description: >
  Use this skill to push code to remote and create or update PRs. REPLACES git push and gh pr
  create — never use those directly. Triggers: 'push', 'push my changes', 'ship it', 'send
  this up', 'submit', 'update PRs', 'create PR', 'push stack', 'send PRs'.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gt:*)"
  - "Bash(git status)"
  - "Bash(git branch:*)"
  - "Bash(gh pr view:*)"
  - Skill
---

# Submit

Push Graphite stack and create/update PRs.

## Modes

| Mode        | Command     | When                                                     |
| ----------- | ----------- | -------------------------------------------------------- |
| **Default** | `gt ss -u`  | Always, unless user specifies otherwise                  |
| Single PR   | `gt submit` | User explicitly says "submit this PR" / "update this PR" |
| Create new  | `gt ss`     | User explicitly says "create PR" / "create PRs"          |

Default is `gt ss -u` (stack, update-only) — avoids accidentally creating PRs for WIP branches.

## Steps

1. **Check stack health**: `gt log --stack 2>&1`
   - If restack needed (diverged parents, conflicts), run `Skill(gt:restack)` first.

2. **Submit**:

   ```bash
   gt ss -u 2>&1    # default
   # or gt submit / gt ss depending on mode
   ```

3. **PR descriptions**:
   - After Graphite has created or updated PRs, fetch and read the current title/body for each affected PR with `gh pr view <PR> --json number,title,body,headRefName,url`. This current description is mandatory grounding.
   - Then run `Skill(pr-descr)` for each affected PR so the title and body match the final branch diff without blindly discarding existing PR context.
   - This applies to `gt ss -u`, `gt submit`, and `gt ss`; update-only PRs may still have stale descriptions.

4. **Report**: list Graphite URLs (`app.graphite.com/...`) for updated PRs. Never report GitHub URLs.
