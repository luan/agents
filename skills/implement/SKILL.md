---
name: implement
description: 'Implement one approved agent task with TDD-first execution and verify acceptance criteria. Use when the user asks to implement specific task ID or selected task.'
argument-hint: "<task-or-epic> [--auto]"
user-invocable: true
---

# Implement

Make one selected task true. Do not plan, split, rescope, or pull in adjacent cleanup.

## Arguments

- `<task-or-epic>` — task to execute
- `--auto` — skip optional confirmations and optional Plannotator review gates; do not skip TDD or verification
- No argument — list open unblocked tasks and ask the user to choose

## Workflow

1. **Load and claim**
   - Read the selected task, parent task, blockers, acceptance criteria, verification, out-of-scope notes, and linked research/docs.
   - Stop if blockers are unresolved or criteria are missing.
   - When given no arguments, or if the argument is an epic. Assign all tasks created by this session or all tasks in the pic to the current session.

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

4. **Optional review gates**
   - For risky/ambiguous tests, optionally gate a short test-review markdown with `vault_review(op="gate", gateType="tests")` unless `--auto`.
   - For any `vault_review(op="gate")` call, first resolve the markdown under review to its real absolute local filesystem path and pass that as `targetPath`. Do not pass vault stems, wiki-link targets, repo-relative paths, or artifact-link paths as `targetPath`.
   - In the gate `instructions`, name the exact absolute file being reviewed and state the review purpose.
   - After verification, optionally run `vault_review(op="code", diffType="uncommitted")` unless `--auto`.
   - On denial, fix, re-run verification, and re-gate.

5. **Verify and finish**
   - Run focused tests, task-specified checks, then the reasonable project-level check.
   - Review the diff for scope creep, debug artifacts, unrelated cleanup, and satisfied criteria.
   - Mark completion only after verification passes or a blocker is explicit.

## Completion

When finished, briefly state what changed, which checks passed, any blocked criteria, and the sensible next step.
