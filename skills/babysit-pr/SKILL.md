---
name: babysit-pr
description: Watch or babysit a pull request or stack. Use when the user explicitly asks to watch PR checks, fix PR CI, address unresolved review comments, or babysit a PR through completion.
argument-hint: "[PR-or-stack] [--auto]"
---

Resolve repository, current branch, local HEAD, PR number, PR head SHA, base,
and Git-Spice graph. Support the selected PR or every existing PR in the current
stack. Reject CI runs and comments from another PR or head.

## Checks

```bash
gh pr checks <PR> --repo <REPO> --json name,state,bucket,link,workflow
gh run list --repo <REPO> --commit <HEAD_SHA> \
  --json databaseId,name,workflowName,status,conclusion,headSha,url --limit 50
gh run view <RUN_ID> --repo <REPO> --log-failed
```

Keep failed, pending, canceled, skipped, passed, and missing states distinct.
Fix actionable failures at their root and run relevant local checks.

## Review threads

Fetch complete unresolved review threads with the script. It paginates threads
and comments and returns reply and resolution permissions:

```bash
uv run ~/.agents/skills/babysit-pr/scripts/fetch_threads.py fetch \
  --pr <PR> --repo <REPO>
```

Read the full thread before drafting a reply. Identify the current GitHub user.
If that user already posted an equivalent reply and no meaningful state changed,
do not reply again. A follow-up after a new comment, relevant commit, or user
direction must acknowledge the earlier reply.

Reply only after the submitted PR head contains the fix. Write the full current
thread plus one new reply to
`pr://<owner>/<repo>/<pr>/threads/<THREAD_ID>`. This adds stale-content
protection, not lower request cost. Use the script when resource writes are
unavailable:

```bash
uv run ~/.agents/skills/babysit-pr/scripts/fetch_threads.py reply \
  --thread-id <THREAD_ID> --body "<BODY>"
```

Under `--auto`, resolve verified bot-authored threads by writing empty content
to the thread resource. Keep human threads open unless the user requests
resolution. Use the script when resource writes are unavailable:

```bash
uv run ~/.agents/skills/babysit-pr/scripts/fetch_threads.py resolve \
  --thread-id <THREAD_ID>
```

Commit with `$commit` when needed. Submit with `$submit` when `--auto` or the
initiating request authorizes remote updates. Re-resolve identity after every
push, then repeat checks and thread retrieval until complete or blocked.

Completion requires every selected PR and head reported, every check and thread
accounted for, no duplicate reply, and exact remaining blockers stated.
