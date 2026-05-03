---
name: split-commit
description: "Repackage a branch into clean, tested, vertical commits. For single commits use /commit."
argument-hint: "[base-branch] [--test='command'] [--auto]"
user-invocable: true
allowed-tools:
  - Bash
---

# Split Commit

Repackage branch changes into clean vertical commits. Each commit compiles + passes tests independently.

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `split-commit`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Repackage an existing branch into clean vertical commits while keeping behavior verified.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: Each commit should be coherent, reviewable, and buildable where practical.

## Phase 1: Analyze

Parse: `<base-branch>`, optional `--test='command'`. If no base-branch arg, resolve at runtime: `gh stack view --json 2>/dev/null | jq -r '.trunk // empty' || gt parent 2>/dev/null || gt trunk 2>/dev/null || git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/||'`.

**Noop check** — `git log --oneline <base>..HEAD | wc -l`. If ≤1 → stop: "Nothing to repackage — use /commit."

Dispatch analysis subagent (general-purpose):

```
Analyze changes for repackaging into clean vertical commits.
Base branch: <base-branch>

Steps:
1. `git log --oneline <base>..HEAD | wc -l` + `git diff --stat <base>..HEAD | tail -40`
2. Full diff: `git diff <base>..HEAD` — Explore subagent for large diffs
3. Trace cross-file deps, group vertically, order: foundational → features → cleanup
4. For shared files, note which hunks belong where

Auto-detect test commands from justfile/Makefile/package.json/Cargo.toml. Use --test if provided.

Cross-file dep rules:
- File A imports B → same commit or B earlier
- Config/lock files go with the feature introducing the dep
- New types/interfaces go with first consumer

Output:
TEST_COMMANDS: <detected or provided>
COMMIT_PLAN:
1. `type(scope): message` — Files: <list>, Partial: <hunks>, Deps: <justification>, Rationale: <why>
DEPENDENCY_NOTES: <hunk splitting, ordering constraints>
```

`--auto` → proceed directly. Otherwise → present plan via AskUserQuestion: commit count, test commands, each commit + key files. "Proceed?"

## Phase 2: Execute

Collapse into unstaged changes:

```bash
git reset --soft <base> && git reset HEAD
```

Dispatch a **single execution subagent** (model="sonnet") for ALL commits:

```
Create <total> commits from unstaged changes.
Commit plan: <full plan from analysis>
Test commands: <test-commands>

Per commit:
1. `git-surgeon hunks` — list available hunks
2. Stage target hunks: whole files → all hunks; partial → `git-surgeon show <id>`, stage matching
3. Run tests. FAIL → find missing dep, stage, retry once. Still failing → STOP with commit number + error.
4. `git commit -m "<message>"`

After last commit: `git diff --stat` — state remaining unstaged.
```

**On failure**: spawn fix subagent, then re-invoke execution subagent for remaining commits only.

Verify after all commits:

```bash
git status          # should be clean
git log --oneline <base>..HEAD   # N clean commits
```

Dirty tree → cleanup subagent: stage remaining, test, commit as `chore: clean up remaining`. Still fails → state the blocker.

## Key Rules

- **No tasks** — pure git operation, one-shot
- **Two subagents** — analysis + execution (fix subagent only on failure)
- **git-surgeon always** — hunk-level precision for partial file staging
- **Every commit compiles** — broken history is worse than plan deviation
- **Plan > rigidity** — test failures from missing deps override grouping
