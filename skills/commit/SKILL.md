---
name: commit
description: 'Create conventional commits from current repository changes. Use when the user asks to commit, amend, fixup, squash, save changes, or write a commit message.'
user-invocable: true
context: fork
agent: general-purpose
model: haiku
allowed-tools:
  - "Bash(git status)"
  - "Bash(git diff:*)"
  - "Bash(git log:*)"
  - "Bash(git add:*)"
  - "Bash(git commit:*)"
  - "Bash(git notes:*)"
  - "Bash(git branch:*)"
  - "Bash(git rev-parse:*)"
  - "Bash(ct task show:*)"
  - "Bash(ct task update:*)"
  - Read
  - Glob
  - Grep
---

# Commit

Create conventional commits explaining WHY changes were made. Never ask for confirmation — analyze, compose, execute.

## Context

Status: !`git status -sb 2>/dev/null`
Staged diff: !`git diff --cached --stat 2>/dev/null`
Recent commits: !`git log --oneline -5 2>/dev/null`

Workers never commit — they lack branch context for meaningful messages.

## Flow

1. **Analyze**: review context above. Nothing staged → read `git diff`. Staged → read `git diff --cached`.

2. **Message**: `type(scope): description` — max 72 chars, lowercase, imperative, no period. Types: feat|fix|perf|docs|test|style|build|ci|chore|revert. Scope = primary area, omit if global. Body (after blank line, 72-char wrap) explains motivation, not mechanics. Active task → append `(task-<id>)`.

3. **Execute** via HEREDOC:
   ```bash
   git commit -m "$(cat <<'EOF'
   type(scope): description
   EOF
   )"
   ```

4. **Post-commit**: if the commit message references `(task-<id>)`, verify the task exists with `ct task show <id> --json` and mark it done with `ct task update <id> --status done` only when the committed diff satisfies that task's acceptance criteria. Skip silently if `ct` is unavailable.

## Hook Failures

- **Hooks modify files** (formatters): stage + amend (`git add -u && git commit --amend --no-edit`). Safe because the commit landed; amend just folds in formatter changes.
- **Hooks reject commit** (lint/test failures): show error, explain, suggest fix. Create a NEW commit after fix — the original never landed, so `--amend` would corrupt the previous commit.

## Special Ops

- **Amend**: analyze previous commit + new changes, update message if scope changed. `--no-edit` only when purpose unchanged.
- **Fixup** (`--fixup=<SHA>`): targets a specific earlier commit. User rebases later.
- **Squash**: unify message around primary purpose, not a changelog.

## Edge Cases

- Nothing staged + `--auto` → `git add -u`. Otherwise ask what to stage.
- Multiple unrelated changes → suggest `/split-commit`.
- Clean tree → "No changes to commit"
