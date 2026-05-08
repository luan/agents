---
name: plan
description: 'Turn approved research intent into a vault plan artifact plus executable agent tasks. Use when researched intent needs implementation direction and task breakdown.'
argument-hint: "<research-stem-or-topic> [--auto]"
user-invocable: true
---

# Plan

Turn approved research into an implementation plan and executable tasks. The plan artifact records direction and pointers; tasks carry detailed acceptance criteria and verification.

## Arguments

- `<research-stem-or-topic>` — approved vault research artifact or topic
- `--auto` — skip proposal gate only for straightforward breakdowns; still stop on ambiguity

## Workflow

1. **Load research**
   - Find/read the research artifact with `vault_*` tools.
   - Read related domain/decision docs.
   - Stop if the intent lacks user stories, acceptance intent, or non-goals.

2. **Explore implementation shape**
   - Inspect enough code to identify vertical seams, public interfaces, likely test seams, migrations, and sequencing constraints.
   - Keep this at planning depth; do not implement.

3. **Draft the plan artifact**
   - Create or update a vault plan artifact linked to the research.
   - Keep it concise: implementation direction, sequencing, major risks, and pointers to the task set.
   - Do not duplicate task-level details; each task owns its acceptance criteria, verification, and narrow implementation notes.

4. **Draft tasks**
   - Create a temporary proposal outside the repo before publishing tasks.
   - Include epic id/title, task titles, AFK vs HITL/review-gated classification, blockers, acceptance criteria, verification, and out-of-scope notes.
   - Do not create tasks until the proposal is approved or `--auto` legitimately skips the gate.

5. **Gate when needed**
   - If not `--auto`, run `vault_plannotator_gate` on the proposal with `gateType="plan"`.
   - If denied with feedback, revise the plan/proposal and re-gate.
   - If closed/unavailable/timed out/no approval, stop before creating tasks.

6. **Publish**
   - Commit the plan artifact with `vault_commit`.
   - Use task primitives to create one epic umbrella and independently executable vertical-slice tasks.
   - Use blockers only for real dependencies.
   - Add links between the plan artifact and the task set.

## Task quality bar

- Each task is a thin end-to-end tracer bullet.
- Each task is independently verifiable.
- Prefer many small AFK tasks over broad phase tasks.
- Mark HITL only when human judgment or interaction is genuinely required.

## Completion

Briefly state the plan artifact, created tasks, verification performed, and which task should start first.
