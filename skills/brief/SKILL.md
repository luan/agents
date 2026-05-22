---
name: brief
description: "Create or revise a compact durable vault brief/PRD from settled intent, optionally using visual review artifacts for UX/workflow clarity. Use after `$grill` or equivalent context when the desired behavior, scope, non-goals, acceptance model, risks, and verification strategy are ready for user review."
argument-hint: "<topic-or-context>"
user-invocable: true
---

# Brief

Publish the product direction as a durable vault artifact. A brief is accepted
only after Plannotator approval.

## Workflow

1. **Load settled context**
   - Read the Grill Summary or equivalent conversation context.
   - Load/use `$vault` before running nontrivial `ct vault` workflows.
   - Read relevant vault docs/briefs/plans and repo docs/code.
   - Stop and ask if behavior, scope, non-goals, or acceptance boundaries are
     still unclear.

2. **Draft the vault brief**
   - Create or update a `doc` vault artifact with `ct vault create -t doc` or
     by editing the existing artifact path.
   - Keep repo paths inside the artifact repo-relative; only Plannotator command
     arguments use absolute local paths.
   - For visual workflows or UX-heavy briefs, use [visual-review.md](visual-review.md).
   - Include:
     - Problem and desired workflow/behavior.
     - Scope and non-goals.
     - Acceptance model split into agent-verifiable and human-judgment criteria.
     - Evidence model: user-visible surfaces, non-visible setup work, and
       required visual/manual evidence.
     - Verification strategy.
     - Risks, compatibility, migration, and known open questions.
     - Links to source context.

3. **Gate and publish**
   - Resolve the artifact to its exact absolute local filesystem path.
   - Run `plannotator annotate "<absolute-path>" --gate --json`.
   - If Plannotator is unavailable, denied, or times out without approval, stop.
     Do not commit and do not create tasks.
   - After approval, commit with `ct vault commit "<absolute-path>" --message "..."`
     and report the artifact path.

## Output

Return the committed brief path, approval status, and any blocking follow-up
needed to continue in this session.

## Guardrails

- Do not create task records.
- Do not skip Plannotator approval unless the user explicitly says this run is
  only a local draft.
- Keep the brief compact; do not split into QRDSPI research/design/structure
  artifacts by default.
