---
name: submit
description: Push or submit branches and create or update pull requests when the user asks to push, publish, submit, create a PR, or update PRs. Includes PR title and description updates. Does not merge or close pull requests.
argument-hint: "[--auto]"
---

Resolve identity before remote mutation:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
gh repo view --json nameWithOwner,url
gh pr view --json number,title,body,headRefName,headRefOid,baseRefName,url \
  2>/dev/null || true
gs log short --json
```
A missing current-branch PR is expected when creation was requested. Treat it as
the creation path, not an identity failure.

The worktree branch must match the selected PR head. Classify a head-SHA
mismatch as unsubmitted local work or unexpected remote movement.

Update existing pull requests in the current stack with:

```bash
gs stack submit --update-only
```

This skips branches without pull requests. Use creation-capable
`gs stack submit --fill` only when user input requests new pull requests.
Normal submission is lease-safe after amend or restack. Use `--force` only after
default submission identifies conflicting remote state and the user approves
overwriting that exact state.

## Title and description

For every submitted PR, read its current title and body. Preserve intentional
context, links, reviewer guidance, checklists, and non-stale notes. Resolve the
branch base from `down.name` in the Git-Spice JSON graph, then inspect
`git diff <base>...<branch>`.

Use `type(scope): description` for the title, at most 72 characters. Write the
body at motivation, behavior, reviewer impact, and verification altitude.
Preserve repository template headings. Report tests and manual verification as
distinct evidence. Do not invent either.

Without `--auto`, preview metadata changes before `gh pr edit`. With `--auto`,
update directly.

After submission, re-read the graph. Every selected submitted branch must have
`change.id` and `change.url`, `push.needsPush` absent or false, and zero
`push.ahead` and `push.behind` when push data is present. Report skipped branches
separately from failures.
