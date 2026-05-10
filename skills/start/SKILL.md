---
name: start
description: 'Create a new branch using the repo-preferred stack tool. Use when the user asks to start work, create a branch, switch to a new task branch, or begin an issue.'
argument-hint: "<branch-name> [--auto]"
user-invocable: true
---

# Start

Create a branch with the repository's configured Git strategy.

## Steps

1. Parse args: first = branch name.
2. Read strategy: `git config --get agents.git-tool 2>/dev/null || true`.
3. Normalize branch name: prefix with !`echo "${GIT_USERNAME:-$(whoami)}"/` if not already present, except when the selected tool's configured branch prefix will add it.
4. Create branch based on `agents.git-tool`:
   - `graphite` → `gt create <branch-name>`
   - `git-spice` → `gs branch create <branch-name>`; `gs bc <branch-name>` is the matching shorthand and may be used when brevity matters.
   - `main`, `none`, unset, or invalid → `git checkout -b <branch-name>`
5. State the branch when `--auto` was NOT passed. If `--auto` was passed, output nothing — no handoff, no suggestions.

## Boundary

Branch creation command selection only; does not decide whether editing is allowed. Trunk edit and shell gating belongs to the git-tool extension, and users may also create branches manually outside Pi.

## Error Handling

- **Branch exists** → check `git branch -a`, suggest alternate name
- **Wrong parent** → warn user, suggest checking out intended parent first
