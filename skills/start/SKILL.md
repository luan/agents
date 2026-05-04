---
name: start
description: 'Create a new branch using the repo-preferred stack tool. Use when the user asks to start work, create a branch, switch to a new task branch, or begin an issue.'
argument-hint: "<branch-name> [--auto]"
user-invocable: true
allowed-tools:
  - "Bash(git checkout:*)"
  - "Bash(git branch:*)"
  - "Bash(git rev-parse:*)"
  - TaskUpdate
  - TaskGet
  - Skill
---

# Start

Create branch.

## Steps

1. Parse args: first = branch name
2. Normalize: prefix with !`echo "${GIT_USERNAME:-$(whoami)}"/` if not already present
3. Create branch (detect stack tool for current branch):
   - gt plugin loaded → `Skill(gt:gt, "create <branch-name>")`
   - Otherwise → `git-spice branch create <branch-name>` – git-spice automatically prepends the prefix, so use only the branch name here.
4. Output branch. If `--auto` was NOT passed, suggest `$spec` or `$develop`. If `--auto` was passed, output nothing — no handoff, no suggestions. The caller is an orchestrator that will handle next steps; any output text risks the model ending its turn prematurely.

## Error Handling

- **Branch exists** → check `git branch -a`, suggest alternate name
- **Wrong parent** → warn user, suggest checking out intended parent first
