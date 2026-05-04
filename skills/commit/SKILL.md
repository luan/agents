---
name: commit
description: Use when changes should be committed with a clear conventional message, including standard commits, amend, fixup, or squash flows
---

# Commit

Create high-signal, conventional commits that explain intent.

## Preconditions

- You are on the intended branch.
- Files to include are staged, or you explicitly decide how to stage.

## Commit Message Rules

- Format: `type(scope): description`
- Types: `feat`, `fix`, `perf`, `docs`, `test`, `style`, `build`, `ci`, `chore`, `revert`
- Description: imperative mood, lowercase start, no trailing period, <= 72 chars
- Scope: optional, but include when it clarifies ownership
- Body (optional): explain why and impact, not line-by-line mechanics

## Core Flow

1. Inspect state:
   - `git status -sb`
   - `git diff --cached --stat`
   - If nothing staged, inspect `git diff --stat`
2. If nothing is staged:
   - Ask whether to stage all, tracked-only, or selective hunks.
   - Stage with `git add -A`, `git add -u`, or `git add -p`.
3. Build message from staged diff and recent branch context.
4. Commit:

```bash
git commit -m "$(cat <<'EOF'
type(scope): description

Optional body wrapping near 72 characters.
EOF
)"
```

5. Verify:
   - `git status -sb`
   - `git log --oneline -3`

## Hook Failure Handling

If commit fails because hooks reject (`lint/test/typecheck` failure):
- Show the failure.
- Fix issue.
- Create a new commit (do not amend, because commit did not land).

If commit succeeds but hooks mutate files (auto-formatters):
- Stage changes: `git add -u`
- Amend safely: `git commit --amend --no-edit`

## Special Operations

- Amend: `git commit --amend` (or `--no-edit` when intent unchanged)
- Fixup: `git commit --fixup=<sha>` for later autosquash
- Squash: use interactive rebase and rewrite one coherent message

## Escalate to Split Commit

If staged changes contain unrelated concerns, stop and use `split-commit` instead of forcing one mixed commit.
