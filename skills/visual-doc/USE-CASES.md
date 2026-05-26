# Visual Doc Use Cases

## Brief

Use visual docs for workflows, state choices, UX alternatives, before/after
states, information architecture, or human-judgment acceptance examples.

- Keep the vault brief as the source of truth.
- Summarize visual decisions in the brief before gating it.
- Pause for clarification when the visual review reveals unsettled behavior.

## Issues

Use visual docs for epic/task maps, dependency graphs, scenario-to-task
matrices, rollout slices, or review of task boundaries.

Recommended review order:

1. Header with brief link, proposal goal, and recommended first `$implement`
   task.
2. Summary strip with slice count, AFK/HITL count, and open review decisions.
3. One card per slice with title, type, verification, readable blockers, story
   summaries, structured body, acceptance criteria, verification evidence, and
   implementation handoff notes.
4. Relationship section when blockers or sequencing materially affect review.

Keep the issue proposal and task records as the source of truth. If visual
review changes slicing, update the issue proposal before gating it.

## Implement

Use visual docs for manual-verification gates and user-visible evidence.

Recommended review order:

1. Header with task title, commit hash, and changed surface.
2. Summary cards for acceptance status, evidence count, checks, and caveats.
3. One scenario card per acceptance path with embedded visual evidence.
4. Manual scenario checklist with exact user actions and expected outcomes.
5. Caveats and final approval callout.

Map each acceptance criterion to evidence. Use screenshots, terminal frames,
recordings, rendered GIFs, or equivalent visual evidence as the primary review
surface.
