---
name: commit
description: Create one commit with an intentional staged scope and a clear conventional message. Use when the user asks to commit or a completed workflow requires one new commit.
---

1. Inspect `git status --short`, `git diff --cached --stat`, and the staged diff.
2. If nothing is staged, stage the clearly intended files. Use `$git` when hunk
   selection or ownership is not obvious.
3. If staged changes contain unrelated concerns, stop and report the split
   instead of creating a mixed commit.
4. Write the message:
   - `type(scope): description`
   - imperative mood;
   - lowercase start;
   - no trailing period;
   - 72 characters maximum.
5. Add a body only for non-obvious intent, breaking changes, security changes,
   migrations, or reversions. Explain why and impact, not file mechanics.
6. Create one commit with `gs commit create -m <subject>` and repeated `-m` for
   body paragraphs.
7. Verify `git status --short` and `git log --oneline -3`.

Completion requires one coherent commit, its intended message, and every
remaining worktree change accounted for.
