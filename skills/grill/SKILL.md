---
name: grill
description: "Ground product or engineering intent before planning by interviewing against repository code and vault context, optionally using visual artifacts for ambiguous UX or workflows. Use when a feature request, workflow change, or ambiguous implementation idea needs scope, tradeoffs, acceptance criteria, or non-goals clarified before brief/issues/implementation."
argument-hint: "[topic]"
user-invocable: true
---

# Grill

Resolve intent before side effects. Do not edit files, create tasks, write vault
artifacts, or continue into `$brief`, `$issues`, or `$implement` in the same turn.

## Workflow

1. **Ground first**
   - Read relevant repo docs, code, existing tasks, and vault docs/briefs/plans.
   - If code or docs answer a question, use that evidence instead of asking.
   - State any important inferred facts separately from user choices.

2. **Interview the decision tree**
   - Ask only questions that affect product behavior, scope, priority,
     migration, compatibility, failure handling, or acceptance boundaries.
   - Ask in small batches, normally 1-3 questions.
   - For every question, provide a recommended answer and why.
   - Prefer criteria-based human judgment over broad HITL/AFK labels.
   - For visual UX/workflow ambiguity, use [visual-collaboration.md](visual-collaboration.md).

3. **Stop with a Grill Summary**
   - Established facts, with source pointers where useful.
   - Resolved user choices.
   - Remaining blockers, if any.
   - Draft acceptance model: agent-verifiable criteria, human-judgment criteria,
     verification commands, and out-of-scope notes.
   - State whether enough intent is settled to continue to `$brief` in this
     session.

## Guardrails

- No Plannotator gates in this skill; visual artifacts are exploratory only.
- No task creation.
- No implementation planning beyond the minimal summary needed for `$brief`.
- Do not recreate QRDSPI phase handoffs; this is a short intake skill.
