---
name: start
description: "Create a new branch. Uses Graphite (gt) if available, falls back to git-spite."
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

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `start`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Create the requested branch with the repo-preferred stack tool and confirm the branch state.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: Do not switch/create branches ambiguously.

## Steps

1. Parse args: first = branch name
2. Normalize: prefix with !`echo "${GIT_USERNAME:-$(whoami)}"/` if not already present
3. Create branch (detect stack tool for current branch):
   - gt plugin loaded → `Skill(gt:gt, "create <branch-name>")`
   - Otherwise → `git-spice branch create <branch-name>` – git-spice automatically prepends the prefix, so use only the branch name here.
4. Output branch. If `--auto` was NOT passed, suggest `/spec` or `/develop`. If `--auto` was passed, output nothing — no handoff, no suggestions. The caller is an orchestrator that will handle next steps; any output text risks the model ending its turn prematurely.

## Error Handling

- **Branch exists** → check `git branch -a`, suggest alternate name
- **Wrong parent** → warn user, suggest checking out intended parent first
