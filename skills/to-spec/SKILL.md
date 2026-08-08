---
name: to-spec
description: Turn settled conversation and codebase context into an implementation-ready vault spec that can be implemented directly or optionally split into tickets.
disable-model-invocation: true
---

# To Spec

Produce one implementation-ready source of truth from settled decisions. Load `$vault` before reading or publishing artifacts.

## Process

1. Read relevant vault context, decisions, and research. Explore current code and tests until the spec can name the existing behavior, affected boundaries, and verification seams with evidence.

2. Resolve material uncertainty before publishing. Use the conversation as settled input; ask only about a decision whose answer changes scope, behavior, architecture, or acceptance criteria.

3. Write the spec using the template below. Every acceptance criterion must be observable, and the implementation approach must be concrete enough to execute without redesigning the feature. When work spans multiple coherent sessions, include a delivery plan with ordered phases, phase-specific verification, and completion criteria. Include required reading, rollout or cutover steps, and scenario matrices only when the settled discussion made them material.

4. Publish with `vlt create --type spec --topic "<topic>" --json` and `vlt update <stem> --stdin --json`. Link source research and decisions with typed `vlt link` relationships.

5. Report the spec stem, scope, and any remaining risk, then stop.

## Spec Template

```markdown
## Problem

The user-visible or operational problem, including current behavior and why it matters.

## Outcome

The behavior that will exist when the work is complete.

## Scope

- Included behavior and boundaries.
- Affected components, interfaces, data, or workflows.

## Out of Scope

- Adjacent behavior intentionally excluded.

## Current System

Evidence-backed description of relevant code paths, existing conventions, constraints, and reusable test seams. Include file paths when they help implementation locate current behavior.

## Implementation Approach

Ordered, implementation-ready changes. Name affected modules and interfaces, compatibility or migration requirements, and important failure behavior. Include a small prototype-derived state machine, schema, reducer, or type shape when it records a settled decision more precisely than prose.

## Acceptance Criteria

- [ ] Observable behavior or externally verifiable result.

## Verification

- Tests and checks that prove each acceptance criterion.
- Existing test seams and prior art to reuse.
- Any required manual verification.

## Risks and Constraints

- Known edge cases, operational constraints, compatibility limits, or rollout concerns.

## Delivery Plan

Include this section only when the work spans multiple coherent sessions.

- Required reading needed before changing the system.
- Ordered phases or delivery increments, each with a goal, bounded scope, verification, and completion criteria.
- Rollout, migration, cutover, or cleanup ordering when partial deployment changes behavior.
- Scenario matrix when many edge cases must remain visible during implementation.

## Implementation Notes

Pending implementation.
```
