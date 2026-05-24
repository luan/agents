---
name: issues
description: "Turn an approved durable brief into a reviewed issue proposal and task records, optionally using visual review artifacts to validate task slicing. Use after `$brief` approval when implementation should be split into tracer-bullet tasks with structured bodies and clear acceptance criteria."
argument-hint: "<approved-brief-or-topic>"
user-invocable: true
---

# Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be `feature`, `bug`, or `chore`. Feature and bug slices deliver user-visible behavior. Chore slices are for non-visible setup work. Do not force visual review onto pure chores. You should prefer features since those will have a tighter feedback loop, and will more often represent a true tracer-bullet.
Verification for `chore` must always be AFK, features and bugs default to HITL and can only be AFK if true end-to-end verification is agreed upon and documented in the issue body.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Request user feedback on the breakdown

Present the proposed breakdown using [visual-review.md](visual-review.md), be sure to conver:

- **Title**: short descriptive name
- **Type**: feature/bug/chore
- **Verification**: AFK/HITL
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)
- **Body**: use the structured template

Feedback you want to elict:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 5. Publish plan to the vault

After approval, create a normal typed `plan` artifact linked to the brief: `vlt create --type plan --topic "<implementation issue proposal>" --source <brief-stem> --json`. Preserve all of the details from the approved breakdown.

### 6. Create tasks

Create task records with `task_write` (ct task add if tool is unavailable), including blockers, epic links, priorities, and the structured bodies.

## Output

<issue-template>
## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## Related docs

Links to the brief, ADRs, or other vault artifacts that are relevant to this issue.

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Verification steps

For each user-story, a manual test plan, including:

1. Setup steps (data, environment, etc.)
2. Actions to take
3. Expected results

## Automated verification plan

When possible, include a plan for agents to automatically verify the implementation. This should include a detailed html report with screenshots of each user story verified. If this verification, an issue cannot be classified as AFK and must be marked HITL. You can load the `$implement` skill to see what kind of verification paths are possible.

</issue-template>

Do NOT close or modify any existing parent issues.
