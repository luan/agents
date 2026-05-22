---
name: implement
description: 'Deliver one approved task through TDD, verification, Plannotator code review, commit, and in-review handoff. Use when the user asks to implement a specific task or selected issue; do not use for story acceptance.'
argument-hint: "<task-or-epic> [--auto]"
user-invocable: true
---

# Implement

Deliver one selected task. `$implement` owns reviewed commit delivery, not story
acceptance.

## Arguments

- `<task-or-epic>` — task to execute
- `--auto` — skip optional confirmations; do not skip TDD, verification,
  Plannotator code review, commit, or task-state handoff
- No argument — list open unblocked tasks and ask the user to choose

## Workflow

1. **Load and claim**
   - Read the selected task, parent task, blockers, acceptance criteria, verification, out-of-scope notes, and linked research/docs.
   - Stop if blockers are unresolved, criteria are missing, or the task is already in review/done.
   - Assign the selected task to the current session and move it to `in_progress`
     before editing.
   - When given no arguments or an epic, list open unblocked tasks and ask for a
     single task. Do not run autonomous multi-task loops.

2. **Confirm scope**
   - Unless `--auto`, briefly state the task, acceptance criteria count, out-of-scope summary, and verification.
   - Ask only when scope is ambiguous.

3. **TDD loop**
   - Follow `$tdd`: one failing behavior test, minimal implementation, refactor only when green.
   - Pick one criterion.
   - Write/update one behavior test through a public seam.
   - Run it and confirm it fails for the expected reason.
   - Implement the minimum code to pass.
   - Run the focused test and refactor only while green.
   - Repeat per criterion.

4. **Verify**
   - Run focused tests, task-specified checks, then the reasonable project-level check.
   - Review the diff for scope creep, debug artifacts, unrelated cleanup, and satisfied criteria.

5. **Required code review**
   - Run `plannotator review --git` before commit, including with `--auto`.
   - If reviewing a file-based note, resolve it to the exact absolute file path
     on the local filesystem first. Do not pass vault stems, wiki-link targets,
     repo-relative paths, or artifact-link paths to Plannotator.
   - If Plannotator is unavailable, denied, or returns no approval, stop with the
     task still `in_progress`.
   - On denial, fix the concrete feedback, re-run verification, and review again.

6. **Commit with `$commit`**
   - Load/use `$commit`; do not hand-roll commit mechanics when the skill is
     available.
   - Commit only the task-scoped files after review approval.
   - If hooks fail, fix and retry. If commit succeeds, capture the commit hash.

7. **Handoff to review**
   - Update the task body delivery evidence with commit hash, changed surface,
     verification, and any caveats.
   - Move the task to `in_review`.
   - Never accept/reject feature or bug tasks.
   - Never directly mark feature or bug tasks `done`; human `/accept` performs
     story acceptance.

## Completion

When finished, briefly state the commit hash, what changed, which checks passed,
and that the task is in `in_review` for human acceptance.
