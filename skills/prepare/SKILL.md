---
name: prepare
description: "Turn an approved vault spec into executable plan artifacts: slices, dependencies, criteria, verification."
argument-hint: "<spec-stem-or-topic> [--auto]"
user-invocable: true
---

# Prepare

Turn an approved blueprints vault `spec` into executable vault `plan` artifacts using vertical slices (tracer bullets). This skill answers **how should we break this into work?**

For small specs, create one plan per executable slice. For large specs, create a parent plan plus linked child plans: the parent plan is the roadmap, and each child plan is an independently executable vertical slice.

The blueprints vault is canonical. Use `ct vault`.

## Arguments

- `<spec-stem-or-topic>` — approved vault spec to prepare
- `--auto` — skip the approval checkpoint and publish the best vertical-slice breakdown you can infer; still stop if the spec is ambiguous or missing acceptance intent

## Vault conventions

- Product intent is captured in `spec` artifacts.
- Implementation roadmaps, issues, tickets, and vertical slices are `plan` artifacts.
- Draft plan artifacts start with the `stage/needs-triage` tag. Published child plans from an approved breakdown should use `stage/ready-for-agent` for AFK slices and `stage/ready-for-human` for HITL slices.
- Use `source: [[stem]]` when creating a plan artifact from an existing parent spec or plan.
- Use wiki-links to connect related vault artifacts.

## Process

### 1. Gather the spec

Work from the approved spec in the conversation, or find it by vault stem/title/topic with vault search/list/read operations. Read the full artifact body, inline comments, and directly linked related artifacts when needed.

If the spec is unapproved and `--auto` is not set, stop and send the user back to `/spec` refinement. With `--auto`, proceed only when the spec has enough user stories or acceptance intent to split safely. Always stop if the spec is ambiguous or missing core acceptance intent.

### 2. Explore implementation shape

Search/read relevant vault domain and decision artifacts so slice titles and descriptions use project vocabulary and respect recorded decisions. If no relevant vault docs exist, proceed silently.

Explore the codebase enough to identify natural vertical seams, likely public interfaces, test seams, migration needs, and sequencing constraints. This is planning research, not implementation.

### 3. Draft vertical slices

Break the spec into **tracer bullet** plan artifacts. Each artifact is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Choose artifact shape

Choose the smallest artifact hierarchy that keeps execution clear:

- **Small spec**: 1-3 slices, limited dependencies, one agent can hold the full plan in context → create only child slice plans sourced directly from the spec.
- **Large spec**: 4+ slices, multiple milestones, cross-cutting dependencies, or work that spans several subsystems → create a parent plan sourced from the spec, then create child slice plans sourced from the parent plan.

The parent plan is not directly implemented by `/develop`. It coordinates the work and links to child plans. Each child plan must remain independently executable by `/develop`.

### 5. Quiz the user

Present the proposed artifact shape and breakdown. For large specs, show the parent plan title plus child slices. For each child slice, show:

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

### 6. Publish the plan artifacts to the vault

For each approved slice, create a new `plan` artifact in the blueprints vault. Use the child plan template below as the artifact body. Apply the state tag that matches execution status: AFK child plans get `stage/ready-for-agent`, HITL child plans get `stage/ready-for-human`, and parent roadmaps get `stage/needs-triage`.

For large specs, create and commit the parent plan first, then create child plans with `source: [[parent-plan-stem]]`. Publish child artifacts in dependency order (blockers first) so you can reference real wiki-links in the "Blocked by" field.

Create with `ct vault create`, edit the returned path, then `ct vault commit <path>`.

<parent-plan-template>
## Parent

A wiki-link to the source spec.

## Implementation roadmap

A concise description of how the spec is decomposed and why this shape fits the work.

## Child plans

- [[child-plan-1]] — AFK/HITL — blocked by none
- [[child-plan-2]] — AFK/HITL — blocked by [[child-plan-1]]

## Dependency graph

A simple Mermaid graph or bullet list showing child plan ordering.

## Coordination notes

- Cross-slice constraints, shared vocabulary, migrations, or rollout order.
- What must remain consistent across child plans.

## Done when

- All child plans are complete and verified.
- Spec-level acceptance is satisfied end-to-end.

</parent-plan-template>

<child-plan-template>
## Parent

A wiki-link to the parent plan for large specs, or the source spec for small specs.

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

## Implementation notes

- Likely modules/interfaces involved, phrased as guidance rather than brittle line-by-line instructions.
- Important constraints from the spec and vault decision docs.
- Test seams or migration concerns.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- A wiki-link to the blocking plan artifact (if any)

Or "None - can start immediately" if no blockers.

## Verification

- Focused tests/checks this slice should pass.
- Broader build/test command if known.

## Out of scope

- Adjacent work from the spec that belongs to another plan artifact.

</child-plan-template>

Do NOT archive or modify any parent artifact unless the user explicitly asks.

## Output

Return:

```text
Prepared: <spec title>
Spec: <spec-stem>
Plans:
- <parent-plan-stem> — parent roadmap — child plans: <N>   # only for large specs
- <plan-stem> — <title> — <AFK/HITL> — blocked by <none/list>
Next: /develop <first-ready-afk-plan-stem>
```
