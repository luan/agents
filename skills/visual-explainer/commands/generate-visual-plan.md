---
name: generate-visual-plan
description: Generate a visual implementation plan
---

Load the visual-explainer skill and generate a self-contained HTML implementation plan for: $@

## Research first

Read relevant repo files before planning. Identify entry points, existing patterns, affected modules, public APIs, tests, config/schema/data model, similar features, and constraints from README/CHANGELOG/docs.

## Document spine

Build the plan around:

1. the current behavior that creates the need;
2. the proposed behavioral change;
3. implementation order and dependencies;
4. observable completion criteria.

Add architecture, file maps, contracts, migration, risks, or test detail only when each changes an implementation decision. Use a visual only for relationships that prose would conceal.

Write to the requested path; otherwise use `~/.agent/diagrams/`. When visible review is permitted, inspect it in Dia; never launch Chrome or Chromium.
