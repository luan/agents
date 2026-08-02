---
name: generate-slides
description: Generate a slide deck as a self-contained HTML page
---

Load the visual-explainer skill and generate a slide deck for: $@

Before writing HTML, read `./templates/slide-deck.html`, `./references/slide-patterns.md`, and only the shared CSS/library sections needed for the source.

Plan the deck from the audience's decision or understanding target. Build a teaching spine, map decision-changing claims and evidence, and give each slide one teaching job.

Use source-shaped diagrams, comparisons, code, and measured data. Generated imagery qualifies through `./references/generated-visuals.md`; a deck with no qualifying image remains complete. Keep each slide within `100dvh` and provide visible pointer and keyboard navigation.

Write to the requested path; otherwise use `~/.agent/diagrams/`. When visible review is permitted, inspect it in Dia; never launch Chrome or Chromium.
