---
name: develop
description: 'Execute one approved persisted ct task and verify acceptance criteria. Use when the user asks to implement or develop a specific task ID or selected ct task.'
argument-hint: "<task-id-or-prefix> [--auto]"
user-invocable: true
allowed-tools:
  - Agent
  - Bash
  - Read
  - Glob
  - Grep
---

# Develop

Execute one approved persisted `ct` task. This skill answers **make this task true**. It does not plan, split, rescope, or invent adjacent work.

Use `/prepare` when a spec still needs executable tasks. If the user passes a `spec`, stop and ask to run `/prepare <spec-stem>` first.

## Arguments

- `<task-id-or-prefix>` — persisted task to execute
- `--auto` — skip optional confirmations, but still stop on scope ambiguity or broken acceptance criteria
- No argument → list open unblocked tasks and ask the user to pick one. Never silently pick the newest task.

## Rules

- Implement exactly the selected task's acceptance criteria.
- Immediately after loading the selected task and before editing files, claim it with `status=in_progress` and `assigned_to=current`. Do not defer claiming until after implementation starts.
- Read the linked source spec or parent task named in the task body.
- Read relevant vault domain and decision artifacts before changing code.
- If the task is ambiguous, too large, stale, or contradicts the spec, stop and ask. Do not silently rewrite scope.
- If the task needs to be split or corrected, suggest `/prepare` and explain the issue.
- Prefer direct implementation in the main thread. Use subagents only for focused research or review, not independent scope ownership.
- Use the `/tdd` discipline for implementation. TDD is mandatory for `/develop`, not an option.

## Step 1: Load context

Read the task with `task_show`. Capture:

- source spec and parent coordination task, if present
- related artifacts and task blockers
- acceptance criteria
- explicit out-of-scope items
- verification commands or expectations
- inline comments

Then read:

- the linked source spec
- parent task and blocking tasks, when present
- relevant vault domain docs
- relevant vault decision docs

If blockers are unresolved or the task lacks acceptance criteria, stop.

Then claim the task:

```text
task_update(<task-id>, status="in_progress", assigned_to="current")
```

If claiming fails, stop before editing files.

## Step 2: Confirm execution target

Summarize before coding unless `--auto` is set:

```text
Task: <id/title>
Parent spec: <stem/title or none>
Acceptance criteria: <N>
Out of scope: <summary>
Verification: <commands/checks>
```

Ask for confirmation only if there is ambiguity. Otherwise proceed.

## Step 3: Implement

Work vertically against the acceptance criteria:

1. Identify the public behavior seam for the first criterion.
2. Write or update one behavior test for that criterion.
3. Run it and confirm it fails for the expected reason.
4. Implement the minimum code needed to pass.
5. Run the focused test/check and confirm it passes.
6. Refactor only while green.
7. Repeat for the remaining criteria.

If no durable test seam exists for a criterion, stop and explain why the task cannot be developed safely. Do not silently skip the red-green loop.

Do not add speculative features. Do not broaden scope because nearby code looks related.

If using subagents, their prompts must include the task, parent spec, acceptance criteria, out-of-scope items, and relevant vault vocabulary. A subagent may research or review; the main thread remains responsible for edits and scope control unless the user explicitly asks for delegated implementation.

## Step 4: Verify

Run, in order:

1. Focused tests/checks for changed behavior.
2. Task-specified verification commands.
3. The project-level test/build command when discoverable and reasonable.

If verification fails:

- Fix failures caused by your changes.
- If failure reveals bad task assumptions, stop and explain the mismatch.
- After two failed repair attempts, stop with the exact failing command and blocker.

## Step 5: Scope review

Review the final diff against the task and linked spec:

- every acceptance criterion satisfied or explicitly blocked
- no out-of-scope behavior added
- no unrelated cleanup bundled in
- no debug artifacts or temporary files left behind

Use an advisory review subagent if the diff is large or touches unfamiliar code.

## Step 6: Finish

Do not create a report artifact. Output a concise handoff:

```text
Developed: <task title>
Verification: <commands and pass/fail>
Acceptance criteria: <satisfied/blocked summary>
Files changed: <paths>
Next: /crit, then /commit
```
