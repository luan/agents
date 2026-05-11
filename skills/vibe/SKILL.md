---
name: vibe
description: "Runs the full QRDSPI delivery workflow as an orchestrator from intent to commit. Use when the user wants to vibe through a feature or delegate question, research, design, structure, implementation, critique, and commit with minimal interruption."
argument-hint: "<feature-or-task-intent> [--auto]"
user-invocable: true
---

# Vibe

## Quick start

Own the orchestration from intent to commit; let each phase own its local rules.

```text
$question (HITL) -> $research (AFK) -> $design (AFK) -> $structure (HITL, 10m timeout to AFK) -> repeat per open epic task: $implement (AFK) -> $crit (AFK) -> $commit
```

## Workflow

1. **Question / HITL** - run docs/code-grounded intake. Ask only questions that materially affect downstream work.
2. **Research / AFK** - gather and commit factual evidence. Pause only on contradiction or failed-closed review.
3. **Design / AFK** - choose a compact solution direction from the seeded context and research.
4. **Structure / HITL -> AFK** - draft a compact outline and gate it with a 10 minute timeout; continue from the draft if review times out without feedback.
5. **Claim the epic workset before implementation** - once the target epic is known and the plan/structure are accepted, list every open, non-canceled, non-epic task in that epic. Assign all of those relevant tasks to the current session before editing. This includes blocked and HITL/review-gated tasks so ownership is clear, but only mark the active task `in_progress`. If a relevant task is already assigned to another actor, stop and report the ownership conflict.
6. **Implementation loop / AFK** - select one open epic task at a time. Prefer the highest-priority unblocked AFK task that follows the plan sequence. For each task: mark only that task `in_progress`, implement with repo discipline and targeted verification, critique the local changes, fix concrete defects, re-run verification, commit with a clear conventional message, mark the task done, then continue with the next open epic task.

## Mandatory loop checkpoint

After every task commit, do not emit a final answer yet. First:

1. Re-list the target epic's open, non-canceled, non-epic tasks.
2. Treat blockers that point only at `done` tasks as satisfied; clear those stale blockers if the task system requires it to make the next task runnable.
3. Ensure every remaining relevant task is assigned to the current session unless an ownership conflict was already reported.
4. If an unblocked AFK task remains, immediately claim it as `in_progress` and continue the implementation loop.

Stop only when one of these conditions is true:

- No open tasks remain in the target epic.
- The next unblocked work is HITL/review-gated and needs user action.
- All remaining tasks are blocked by unresolved non-done blockers.
- Verification, critique, or commit fails and the blocker cannot be resolved inside the current turn.
