---
name: implement
description: "Deliver one approved task through claim, TDD, verification, Plannotator review, commit, and gated manual acceptance. Use when the user asks to implement a specific task or selected issue."
argument-hint: "<task-or-epic> [--auto]"
user-invocable: true
---

# Implement one task

Deliver exactly one selected task. `$implement` owns reviewed commit delivery and review handoff, not story acceptance.

`in_progress` means the agent is actively editing or verifying. Never leave a feature/bug task `in_progress` while waiting for human review, Plannotator feedback, code-review approval, or manual-verification approval. Move it to `in_review` before any review wait; if feedback requires changes, move it back to `in_progress` before editing.

## Non-code short-circuit

If the task at hand does not involve code changes, skip all steps except load/claim and manual-verification gate. For example, if the task is to update documentation, implement the change directly in the source file, then generate the manual-verification artifact with the updated content for review and acceptance.

## Workflow

1. **Load and claim**
   - Read task, parent, blockers, acceptance criteria, verification, non-goals, and linked docs.
   - Resolve linked vault artifacts with `vlt read <stem-or-path>`.
   - Load project language with `vlt context list`, `vlt context check`, and `vlt context show [name]`; do not parse or guess context files by hand.
   - Stop if blocked, missing criteria, or already in review/done.
   - Assign the selected task to the current session and move it to `in_progress` before editing.

2. **Implement with TDD**
   - Follow `$tdd`: failing behavior test, minimal implementation, green test, refactor only while green.
   - Repeat until acceptance criteria are covered.

3. **Quality checks**
   - Run linters, formatters, and static analysis. Fix all issues before review. Do not bypass or ignore quality checks.
   - Run the `$simplify` on the diff generated in the previous step.

4. **Verify**
   - Run tests, task-specified checks, then project checks.
   - Review the diff for scope creep, debug artifacts, unrelated cleanup, and satisfied criteria.
   - Match verification to the task evidence class; do not invent visual gates for non-visible chores.

5. **User code review**
   - [skip-if: --auto] Run `plannotator review` before commit. This will let the user review the code changes. Do not stage files before review; the user will stage approved hunks. Right before running `plannotator review`, say, concisely: a. what you have changed; b. areas you explicitly want feedback on; c. anything you haven't addressed (trick question, you should not have any of these if you followed the process well).
   - `plannotator` must run as a blocking foreground command, no background terminal, no `write_stdin` polling.
   - When the review comes back with a question, this is the user starting a conversation. Do not treat it as directional feeedback. Instead, continue the conversation until the gap in understanding is resolved and only then make code changes and re-run the review.
   - For file notes, resolve to the exact absolute file path on the local filesystem first. Do not pass vault stems, wiki-link targets, repo-relative paths, or artifact-link paths to Plannotator.
   - Only after code-approval, move feature/bug tasks to `in_review` with a short note that code has been approved.

6. **Manual-verification gate**
   - Record screenshots or video of user-facing changes.
   - For web apps, use [web-development-verification.md](web-development-verification.md).
   - For desktop apps, use [desktop-app-verification.md](desktop-app-verification.md).
   - For TUI apps, use [tui-verification.md](tui-verification.md).
   - Generate the temporary HTML artifact using [manual-verification-gate.md](manual-verification-gate.md) and `$visual-doc`.
   - Before presenting the gate, validate that artifacts are valid, viewed, renderable in Plannotator, and mapped to acceptance criteria.
   - Ensure feature/bug tasks are `in_review` before presenting the gate.
   - Present it with `plannotator annotate <artifact.html> --render-html --gate` as a blocking foreground command with a normal long human-review timeout. Keep Plannotator in the foreground and wait for the gate result before continuing.

7. **Commit**
   - Load/use `$commit`; do not hand-roll commit mechanics when available.
   - If the whole diff is approved, you are allowed to stage for commit.
   - Commit only the task-scoped files after review approval.
   - Fix hook failures and retry. Capture the commit hash.

8. **Handoff**
   - Record commit, checks, linked `vlt` artifact stems/paths, visual evidence, and caveats.
   - If denied, keep the task reject task with notes from the feedback. Then resume working on it by restarting $implement.
   - ONLY mark feature or bug tasks `done` after manual verification gate is approved.
