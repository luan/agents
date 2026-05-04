---
name: prepare
description: 'Turn an approved vault spec into executable persisted ct tasks with slices, dependencies, criteria, and verification. Use when a spec needs task breakdown for agents or humans.'
argument-hint: "<spec-stem-or-topic> [--auto]"
user-invocable: true
---

# Prepare

Turn an approved blueprints vault `spec` into executable persisted `ct` tasks using vertical slices (tracer bullets). This skill answers **how should we break this into work?**

For every spec, publish all generated tasks under one epic umbrella. Use a stable `epic_id` derived from the spec stem/topic and a human-readable `epic_title` from the spec title. For small specs, create one task per executable slice under that epic. For large specs, create a parent coordination task plus linked child tasks under the same epic: the parent task is the roadmap, and each child task is an independently executable vertical slice.

The blueprints vault remains canonical for product intent. Use `ct vault` to read specs and related docs. Use `ct task` / task tools to publish executable work. Do not write plan artifacts into the repo or vault unless explicitly asked.

## Arguments

- `<spec-stem-or-topic>` — approved vault spec to prepare
- `--auto` — skip the approval checkpoint and publish the best vertical-slice breakdown you can infer; still stop if the spec is ambiguous or missing acceptance intent

## Vault conventions

- Product intent is captured in `spec` artifacts.
- Execution structure is captured in persisted tasks, not vault `plan` artifacts.
- Spec-level umbrella grouping is captured with task epic metadata (`epic_id`, `epic_title`), not blockers.
- Use task blockers to encode dependencies.
- Include the source spec stem/title in every task body.
- Use wiki-links to connect tasks back to relevant vault artifacts.

## Process

### 1. Gather the spec

Work from the approved spec in the conversation, or find it by vault stem/title/topic with vault search/list/read operations. Read the full artifact body, inline comments, and directly linked related artifacts when needed.

If the spec is unapproved and `--auto` is not set, stop and send the user back to `$spec` refinement. With `--auto`, proceed only when the spec has enough user stories or acceptance intent to split safely. Always stop if the spec is ambiguous or missing core acceptance intent.

### 2. Explore implementation shape

Search/read relevant vault domain and decision artifacts so slice titles and descriptions use project vocabulary and respect recorded decisions. If no relevant vault docs exist, proceed silently.

Explore the codebase enough to identify natural vertical seams, likely public interfaces, test seams, migration needs, and sequencing constraints. This is planning research, not implementation.

### 3. Draft vertical tasks

Break the spec into **tracer bullet** tasks. Each task is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Choose task shape

Choose the smallest task hierarchy that keeps execution clear:

- **Small spec**: 1-3 slices, limited dependencies, one agent can hold the full structure in context → create only child slice tasks sourced directly from the spec.
- **Large spec**: 4+ slices, multiple milestones, cross-cutting dependencies, or work that spans several subsystems → create a parent coordination task sourced from the spec, then create child slice tasks blocked by other child tasks as needed.

The parent task is not directly implemented by `$develop`. It coordinates the work and links to child tasks. Each child task must remain independently executable by `$develop`.

### 5. Quiz the user

Present the proposed task shape and breakdown. For large specs, show the parent task title plus child slices. For each child slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown. If `--auto` is set, skip this checkpoint only when the breakdown is straightforward and all slices can be made AFK or clearly labeled HITL.

### 6. Publish tasks

For each approved slice, create a persisted task. Use the child task template below as the task body.

Task statuses:

- Parent coordination tasks: `open`
- AFK child tasks: `open`
- HITL child tasks: `open` and explicitly labeled `Type: HITL` in the body

Task priority:

- Parent coordination task: slightly lower than ready child work unless it is the only task.
- First unblocked AFK slice: highest priority.
- Later or blocked slices: descending priority.

For large specs, create the parent task first, then create child tasks. Publish child tasks in dependency order (blockers first) so blocker IDs are available. Use task blockers (`blocked_by`) for child dependencies. Do not use blockers merely to point every child at the parent task; parent-child linkage belongs in the body.

Use `task_add` or `ct task add`. Every task you create for the spec MUST include the same `epic_id` and `epic_title`. Do not create vault plan artifacts.

<parent-task-template>
Source spec: [[spec-stem]]

Type: Parent coordination

A concise description of how the spec is decomposed and why this shape fits the work.

Child tasks

- TASK-ID — AFK/HITL — blocked by none
- TASK-ID — AFK/HITL — blocked by TASK-ID

Dependency graph

A simple Mermaid graph or bullet list showing child task ordering.

Coordination notes

- Cross-slice constraints, shared vocabulary, migrations, or rollout order.
- What must remain consistent across child tasks.

Done when

- All child tasks are complete and verified.
- Spec-level acceptance is satisfied end-to-end.

</parent-task-template>

<child-task-template>
Source spec: [[spec-stem]]

Parent task: TASK-ID for large specs, or None for small specs.

Type: AFK/HITL

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Implementation notes

- Likely modules/interfaces involved, phrased as guidance rather than brittle line-by-line instructions.
- Important constraints from the spec and vault decision docs.
- Test seams or migration concerns.

Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

Blocked by

- Blocking task IDs/titles, if any.

Or "None - can start immediately" if no blockers.

Verification

- Focused tests/checks this slice should pass.
- Broader build/test command if known.

Out of scope

- Adjacent work from the spec that belongs to another task.

</child-task-template>

Do NOT archive or modify any vault artifact unless the user explicitly asks.

## Output

Return:

```text
Prepared: <spec title>
Spec: <spec-stem>
Tasks:
- <parent-task-id> — parent coordination — child tasks: <N>   # only for large specs
- <task-id> — <title> — <AFK/HITL> — blocked by <none/list>
Next: $develop <first-ready-afk-task-id>
```
