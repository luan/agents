# Plan path

For implementation plans, design docs, feature specs, migration guides, and proposals.

Read [`design-system.md`](design-system.md) for theme tokens, typography, and component patterns, and [`svg-patterns.md`](svg-patterns.md) for the inline SVG building blocks used in architecture diagrams, flowcharts, and data flow.

## Document structure

In order, picking what fits:

1. **Header** — eyebrow label (mono, uppercase), title (serif, large), prompt box (the original brief)
2. **Summary strip** — 3-5 stat cards showing key numbers at a glance (components, endpoints, tables, etc.)
3. **Milestones / timeline** — vertical timeline showing phases without time estimates. Phases show sequence and dependencies, not duration.
4. **Architecture / data flow** — inline SVG diagram. Use for 3+ interacting components. Highlighted boxes for new components, dashed arrows for async paths.
5. **Mockups** — build UI mockups in HTML/CSS directly, not as descriptions
6. **Key code** — dark-theme code blocks with syntax highlighting. Only architecturally significant interfaces/schemas — not every function.
7. **Risks & mitigations** — table with severity badges (HIGH/MED/LOW)
8. **Open questions** — callout cards with decision owner ("Decide with: backend team")

Skip sections that do not serve the content. Leave out time estimates, boilerplate sections, and exhaustive file lists.

## Adapt to the task

Backend → lead with data flow. Frontend → lead with mockups. Refactoring → lead with before/after diagrams. Infrastructure → lead with architecture.

## Quality bar

The plan answers "what, why, and how" within 30 seconds of reading. Whitespace is a feature — one idea per viewport.
