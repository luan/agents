---
name: plannotator-visual-explainer
description: Generate self-contained HTML visualizations with Plannotator theming. Use for implementation plans, PR explainers, architecture diagrams, data tables, slide decks, and any visual explanation of technical concepts.
---

# Plannotator Visual Explainer

Route by what is being explained, then follow that path's reference.

| Content | Path |
|---|---|
| Implementation plan, design doc, feature spec, migration guide, proposal | [`references/plan-path.md`](references/plan-path.md) — prescriptive structure |
| PR walkthrough, diff review, code change explainer, reviewer guide | [`references/pr-path.md`](references/pr-path.md) — prescriptive structure |
| Architecture diagram, data table, slide deck, project recap, comparison, anything else | `$visual-explainer`, with [`references/theme-override.md`](references/theme-override.md) for the color and typography layer |

The third path follows visual-explainer's one-shot workflow; the first two carry their own structure because a plan and a PR each have a known shape worth repeating.

## Delivery

Deliver through Plannotator's annotation UI so the page arrives where the user can mark it up:

```bash
plannotator annotate <file> --render-html --gate   # plans and proposals — the user approves or denies
plannotator annotate <file> --render-html          # everything else — informational
```

The `open` and `xdg-open` commands bypass the annotation UI, so the feedback loop is lost.

## Design philosophy

- **Whitespace is a feature.** Generous padding, large section gaps. Cramped means add space, not shrink text.
- **One idea per viewport.** Hero, then diagram, then detail grid — in sequence.
- **Show, don't describe.** A timeline shows sequencing. A diagram shows relationships. A code block shows the interface.
- **Phases, not hours.** Timelines carry sequence and dependencies; time estimates belong to the reader.
