---
name: generate-web-diagram
description: Generate a standalone HTML visual explainer and inspect it in Dia
---

Load the visual-explainer skill and generate an HTML visual explainer for: $@

Use the skill's anti-slop review, reference routing, and final checklist. Choose geometry from the subject: connected flows/topologies, sequence, state, ownership, comparison, or measured data. Do not default text-heavy material into cards.

Write to the requested path; otherwise use `~/.agent/diagrams/` with a descriptive filename. When visible review is permitted, inspect it in Dia; never launch Chrome or Chromium. In Pi package installs, call `visual_explainer` with `action: "prepare"` when planning/context scouting helps, then call `visual_explainer` with `action: "render"` and the complete HTML.
