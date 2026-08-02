# Slide Deck Patterns

Use slides only when the user requests a deck. A deck is a paced technical argument, not a decorated document reflow.

## Build the sequence

1. Identify the audience decision or understanding target.
2. Write the teaching spine as ordered questions.
3. Map each decision-changing claim and its evidence to the spine.
4. Place secondary inventories in a compact appendix when they support later reference.
5. Give each slide one teaching job.

A source section does not automatically become a slide. Several source sections may support one claim; one complex mechanism may require several slides.

## Reference register

The deck title identifies the exact subject. Its opening sentence states the mechanism or decision the deck will establish and gives the audience enough information to predict one relevant behavior.

Slide headings name the mechanism, comparison, decision, or evidence shown on that slide. Put the conclusion in body copy beside the evidence.

Use the project's typography when available. Otherwise use system sans and mono fonts. Keep title, heading, and body scales close enough that content—not display type—controls hierarchy.

## Source-shaped slide types

### Mechanism

Pair one diagram, trace, state view, or code excerpt with a short adjacent explanation. The visual and explanation must fit the viewport together.

### Sequence

Use one stage per source event. Show nested order in a scoped expansion and explicit branches for differing outcomes.

### Comparison

Use a semantic table or aligned before/after view. Give rows decision-relevant criteria from the source.

### Evidence

Use exact code, measured data, or a source-grounded example. Label simplified excerpts clearly.

### Decision

State the decision, the constraint that drives it, and the consequence. Use a diagram or table when the decision depends on relationships rather than prose.

### Appendix

Keep source maps, exhaustive inventories, and supporting tables compact. Appendix slides remain readable and navigable but do not interrupt the main teaching spine.

## Composition

- Each slide fits within `100dvh` without clipping.
- Use a neutral base surface and one primary accent.
- Additional colors encode defined technical semantics.
- Use position and containment for relationships, not decoration.
- Preserve whitespace around the main evidence.
- Vary layout only when the teaching job changes.
- Keep source labels and code readable at presentation distance.

## Generated imagery

Generated imagery is optional. Load `./generated-visuals.md` and `$imagegen` only when a concrete scene, physical subject, or bounded metaphor adds information that code-native visuals cannot.

A qualifying image remains subordinate to the technical claim and uses external HTML/SVG labels. A deck with no qualifying image remains complete.

## Navigation

Provide visible Previous and Next controls plus keyboard navigation:

- Right Arrow, Page Down, or Space: next slide;
- Left Arrow or Page Up: previous slide;
- Home: first slide;
- End: last slide.

Use scroll snap or direct slide activation. Respect `prefers-reduced-motion`.

## Responsive fit

At the target presentation viewport and a shorter fallback viewport:

- every slide remains within one viewport;
- diagrams and text remain legible without browser zoom;
- code keeps indentation and scrolls locally when needed;
- tables scroll locally or split into multiple slides;
- controls remain reachable;
- focus indicators remain visible.

## Completion

The deck is complete when:

1. the teaching spine answers the audience's questions in order;
2. every slide adds a mechanism, decision, comparison, or evidence;
3. every visual agrees with the source;
4. titles and headings use the reference register;
5. the main sequence contains no source inventory or decorative interlude;
6. every slide fits `100dvh` and remains operable by keyboard;
7. the deck still reads clearly with generated imagery absent.
