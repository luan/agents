---
name: implement
description: "Deliver one approved task through claim, TDD, verification, Plannotator review, commit, and gated manual acceptance. Use when the user asks to implement a specific task or selected issue."
argument-hint: "<task-or-epic> [--auto]"
user-invocable: true
---

# Implement

Deliver exactly one selected task. `$implement` owns reviewed commit delivery
and review handoff, not story acceptance.

`in_progress` means the agent is actively editing or verifying. Never leave a
feature/bug task `in_progress` while waiting for human review, Plannotator
feedback, code-review approval, or manual-verification approval. Move it to
`in_review` before any review wait; if feedback requires changes, move it back
to `in_progress` before editing.

## Quick start

```bash
$implement <task-id>
$implement <task-id> --auto
```

- No argument or an epic: list open unblocked tasks and ask for one task.
- `--auto`: skip all interrupts until final manual verification.

## Workflow

1. **Load and claim**
   - Read task, parent, blockers, acceptance criteria, verification, non-goals,
     and linked docs.
   - Stop if blocked, missing criteria, or already in review/done.
   - Assign the selected task to the current session and move it to `in_progress` before editing.

2. **Confirm scope**
   - Unless `--auto`, briefly state task, acceptance criteria, non-goals, and verification.
   - Ask only when scope is ambiguous.

3. **Implement with TDD**
   - Follow `$tdd`: failing behavior test, minimal implementation, green test,
     refactor only while green.
   - Repeat until acceptance criteria are covered.

4. **Verify**
   - Run tests, task-specified checks, then project checks.
   - Review the diff for scope creep, debug artifacts, unrelated cleanup, and
     satisfied criteria.
   - Match verification to the task evidence class; do not invent visual gates
     for non-visible chores.

5. **Plannotator code review**
   - Before starting review, move feature/bug tasks to `in_review` with a short
     note that implementation and verification are complete and code review is
     pending. Do not leave the task `in_progress` while review is open.
   - Run `plannotator review --git` before commit, unless `--auto` is specified.
   - Plannotator must run as a blocking foreground command: one command, normal
     long human-review timeout, no background terminal, no `write_stdin` polling,
     and no other work while it is open. If it cannot be kept foreground, stop
     and report that review is unavailable instead of continuing.
   - For file notes, resolve to the exact absolute file path on the local filesystem first. Do not pass vault stems, wiki-link targets, repo-relative paths, or artifact-link paths to Plannotator.
   - If unavailable or denied, keep the task `in_review` with captured feedback.
     Move it back to `in_progress` only when actively applying that feedback,
     then re-verify and return it to `in_review` before rerunning review.

6. **Commit**
   - Load/use `$commit`; do not hand-roll commit mechanics when available.
   - Commit only the task-scoped files after review approval.
   - Fix hook failures and retry. Capture the commit hash.

7. **Manual-verification gate**
   - Attempt screenshots or equivalent visual evidence for user-facing changes.
   - For web apps, use [web-development-verification.md](web-development-verification.md).
   - For desktop apps, use [desktop-app-verification.md](desktop-app-verification.md).
   - For TUI apps, use [tui-verification.md](tui-verification.md).
   - Generate the temporary HTML artifact using
     [manual-verification-gate.md](manual-verification-gate.md).
   - Before presenting the gate, validate that screenshots are nonzero, viewed,
     renderable in Plannotator, and mapped to acceptance criteria.
   - Ensure feature/bug tasks are `in_review` before presenting the gate.
   - Present it with `plannotator annotate <artifact.html> --render-html --gate`
     as a blocking foreground command with a normal long human-review timeout.
     Do not run it in a background terminal and do not continue other work while
     the gate is open.

8. **Handoff**
   - Record commit, checks, artifact path, visual evidence, and caveats.
   - If the manual-verification gate is approved, leave the task `in_review` for
     human `/accept`.
   - If denied/unavailable, keep the task `in_review` with feedback. Move it to
     `in_progress` only when actively revising.
   - Never accept/reject feature or bug tasks.
   - Never directly mark feature or bug tasks `done`; human `/accept` performs
     story acceptance.

## Completion

Report commit hash, checks passed, artifact path, and that the task is in
`in_review` for human acceptance.
