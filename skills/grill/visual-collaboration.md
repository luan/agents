# Visual Collaboration

Use visuals only when they reduce ambiguity faster than more prose: UI choices,
workflow states, approval flows, diagrams, or information architecture.

## Options

- Ask a focused visual-choice question with 2-4 options.
- Generate a disposable image with `image_gen` when the user needs a quick mock,
  mood, layout direction, or visual metaphor.
- Generate a temporary self-contained HTML artifact when interaction states,
  data layout, or multi-step flows matter.
- Present HTML with `plannotator annotate <artifact.html> --render-html`.

## Rules

- Do not gate approval in `$grill`.
- Do not create durable files or tasks from the visual artifact.
- State which choices the visual is meant to settle.
- Capture the outcome in the Grill Summary as settled choices or blockers.
