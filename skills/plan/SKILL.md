---
name: plan
description: "Publishes a tactical QRDSPI plan artifact and executable task set from settled context. Use when research/design/structure are sufficient to create vertical implementation tasks, blockers, verification, and handoff without reopening solution direction."
argument-hint: "<topic-or-artifact> [--auto]"
user-invocable: true
---

# Plan

## Quick start

Publish tactical handoff when direction and structure are settled enough: a plan artifact plus executable task records.

## Arguments

- `<topic-or-artifact>`: research, design, structure, existing plan, task topic, or sufficient inline context
- `--auto`: skip the proposal gate only for straightforward breakdowns; still stop on ambiguity

## Workflow

1. **Load context**
   - Search/read vault artifacts: question context, research, design, structure, domain docs, decisions, prior plans, and related docs.
   - Recover enough prior context to act as an entrypoint, but do not bury unresolved direction here.
   - Stop and report missing prerequisite context when intent, evidence, or direction is unresolved.

2. **Confirm structure**
   - Use the structure artifact when one exists.
   - If context already contains enough shape, include a compact inline structure note and proceed.
   - If structure is missing or risky, create or update a structure artifact and gate it with `vault_review(op="gate", gateType="custom")`.

3. **Draft the plan artifact**
   - Create/update a vault plan artifact linked to source research and plan artifact paths plus design/structure paths when available.
   - Include the tactical publication: chosen direction, file/module references, sequencing, risks, verification strategy, inline structure note when used, and task-set pointers.
   - Use repo-relative paths only. Do not include checkout-specific absolute paths.

4. **Draft tasks**
   - Draft a temporary proposal before publishing task records.
   - Include epic title/id, task titles, AFK vs HITL/review-gated classification, blockers, acceptance criteria, verification, artifact links, and out-of-scope notes.
   - Shape tasks as vertical slices that each land a user- or reviewer-visible capability.
   - Avoid tiny file-by-file microtasks and broad phase buckets.
   - Add a final HITL/review-gated task when manual parity review, visual acceptance, migration signoff, or other human judgment is required.
   - Do not create tasks until the proposal is approved or `--auto` legitimately skips the gate.

5. **Gate when needed**
   - If not `--auto`, run `vault_review(op="gate")` with `gateType="plan"` on the proposal.
   - If denied, revise the plan/proposal and re-gate.
   - If closed, unavailable, timed out, or unapproved, stop before creating tasks.

6. **Publish**
   - Commit the plan artifact with `vault_write(op="commit")`.
   - Create one epic umbrella and independently executable vertical-slice tasks.
   - Use blockers only for real dependencies.
   - Link the plan artifact and task set.

## Task quality bar

- Each task is an end-to-end tracer bullet with independent verification.
- Prefer small AFK tasks over broad phase tasks.
- Mark HITL only for genuine human judgment or interaction.
- Visual/parity work needs a HITL acceptance task that opens the artifact, screenshot, or demo in Plannotator.

## Final response

Report only the local result: plan artifact, created tasks, verification, and review/commit status. Do not recommend follow-on QRDSPI phases.
