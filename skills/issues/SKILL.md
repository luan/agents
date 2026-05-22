---
name: issues
description: "Turn an approved durable brief into a reviewed issue proposal and task records, optionally using visual review artifacts to validate task slicing. Use after `$brief` approval when implementation should be split into tracer-bullet tasks with structured bodies and clear acceptance criteria."
argument-hint: "<approved-brief-or-topic>"
user-invocable: true
---

# Issues

Create durable implementation issues from an approved brief. Task records are
created only after the issue proposal is approved.

## Workflow

1. **Load the approved brief**
   - Load/use `$vault` before running nontrivial `ct vault` workflows.
   - Read the brief artifact and any linked docs/plans.
   - Verify it contains scope, non-goals, acceptance model, risks, and
     verification strategy.
   - Verify or infer the brief's evidence model before creating tasks.
   - Stop if the brief is not approved or lacks implementation boundaries.

2. **Draft an issue proposal**
   - Create a `plan` vault artifact linked to the brief.
   - Propose one epic plus vertical tracer-bullet feature/bug/chore tasks.
   - Classify task slices by visibility: feature/bug for user-visible behavior,
     chore for non-visible setup. Do not force visual review onto pure chores.
   - Preserve dependency order with blockers instead of broad phase buckets.
   - Avoid AFK/HITL task taxonomy. Put human judgment on specific acceptance
     criteria.
   - Include a compact task matrix: type, visible surface, evidence class, blockers.
   - For visual dependency maps or task-slice review, use [visual-review.md](visual-review.md).

3. **Use the structured task body template**
   - Context / problem.
   - Links to brief and issue proposal.
   - Agent-verifiable acceptance criteria.
   - Human-judgment acceptance criteria, when needed.
   - Verification commands/checks.
   - Evidence class.
   - Out of scope.
   - Delivery evidence placeholder.

4. **Gate and create tasks**
   - Resolve the issue proposal to its exact absolute local filesystem path.
   - Run `plannotator annotate "<absolute-path>" --gate --json`.
   - If Plannotator is unavailable, denied, or times out without approval, stop.
     Do not commit the proposal and do not create tasks.
   - After approval, commit the proposal with `ct vault commit`.
   - Create task records with `ct task add` / `task_write`, including blockers,
     epic links, priorities, and the structured bodies.

## Output

Report the committed issue proposal path, created epic/task IDs, blockers, and
the recommended first `$implement` task.

## Guardrails

- No implementation edits.
- No task creation before approval.
- Do not migrate historical artifacts unless explicitly requested.
