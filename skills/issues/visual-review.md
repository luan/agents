# Visual Review

Use a visual companion when task boundaries, dependencies, or acceptance
responsibility are easier to review visually.

## Options

- Use a temporary self-contained HTML artifact for epic/task maps, dependency
  graphs, scenario-to-task matrices, or rollout slices.
- Use `image_gen` only for conceptual diagrams or UI slice sketches; do not use
  generated images as the task source of truth.
- Present HTML with `plannotator annotate <artifact.html> --render-html`.
- Gate the durable issue proposal with the normal `$issues` Plannotator gate.

## Rules

- The issue proposal and task records remain the source of truth.
- Visuals should expose task boundaries, blockers, acceptance ownership, and the
  recommended first `$implement` task.
- If visual review changes slicing, update the issue proposal before gating it.
