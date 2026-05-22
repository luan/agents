# Visual Review

Use a visual companion only when it makes the brief easier to approve: UX
sketches, workflow diagrams, before/after states, information architecture, or
human-judgment acceptance examples.

## Options

- Use `image_gen` for disposable concept images or UI direction mocks.
- Use a temporary self-contained HTML artifact for workflows, state diagrams,
  acceptance examples, or side-by-side alternatives.
- Present HTML with `plannotator annotate <artifact.html> --render-html`.
- Gate the durable brief itself with the normal `$brief` Plannotator gate.

## Rules

- The vault brief remains the source of truth.
- Link or summarize visual decisions in the brief; do not require the visual
  artifact to persist unless the user asks.
- If the visual reveals unsettled behavior, stop and ask rather than publishing.
