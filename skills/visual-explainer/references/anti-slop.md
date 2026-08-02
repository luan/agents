# Source-Shaped Craft

Use this reference while choosing the artifact's visual grammar. The goal is **specific, recoverable understanding** that could only come from reading the source.

## Specific anchors

Ground the artifact in source-native material:

- named entities, types, functions, messages, constraints, and failure behavior;
- relationships recovered from actual execution and ownership paths;
- geometry chosen for the mechanism;
- concrete operational consequences.

The finished artifact should remain recognizably about this system even when project branding is hidden.

## Information gain

Give each section one teaching job. A section advances the reader with a distinct relationship, mechanism, exception, decision, or consequence.

A strong sequence lets the reader answer a new technical question after each section.

## Semantic visual space

Let every large visual region encode one of:

- topology;
- sequence;
- state;
- ownership;
- scale;
- causality;
- comparison;
- physical appearance.

Use position, containment, line style, color, and motion consistently. Give each encoding a defined meaning the reader can infer or read from a concise legend.

Choose the subject's native visual language:

- a scheduler as a trace or ordered lane;
- storage as records, checkpoints, and branches;
- ownership as containment and lifetime;
- a protocol as messages over time;
- a state machine as transitions and guards;
- measured behavior as a chart with real data.

## Reference register

Choose an opening that serves the teaching job. Substantial references may use a compact title and predictive summary. Focused diagrams and comparisons may begin directly with an accessible title, caption, or decision question.

The HTML document title mirrors the visible title. The masthead contains only that title, its explanatory summary, and navigation when needed. Omit a footer unless the user requires legal or source metadata.

Headings use source-native mechanism names. Conclusions and constraints appear beside their evidence.

The teaching spine is an authoring outline, not a second visible heading system. Reader-facing sections begin with their mechanism heading; they do not add question prompts, numbered labels, or category eyebrows before it.

Let the first visual establish the document's character. Keep its legend, controls, and explanatory detail together. Use a neutral page surface, restrained type scale, and one primary accent; additional colors carry defined technical meaning.

Write legends as concrete mappings between a visible mark and a source relationship. Color names and abstract nouns alone do not explain an encoding.

Use borders for ownership, containment, and grouping. Present prose as document flow unless an item has an independent identity that benefits from a bounded region.

Keep source terminology visible. Introduce shorthand only when the source relationship needs a stable name.

Template prose either teaches a real mechanism at final quality or appears as an explicit bracketed placeholder. Finished-sounding filler is not template content.

Represent each inventory once. Do not repeat the same entities, stages, paths, or claims in a lede, callout, diagram, and summary.

## Plain-text content gate

Run `bun ./scripts/lint-visible-copy.ts <artifact.html>` from the skill directory, then inspect the extracted reader-facing meaning. Accept it only when:

1. The title identifies the exact subject. The opening summary explains one governing mechanism and the behavior it causes.
2. Each heading is an indexable source-native mechanism, state, boundary, decision, or artifact name. Conclusions remain in the supporting paragraph.
3. Each explanatory paragraph contains a concrete source-specific actor, action, condition, relationship, or consequence. It could not be pasted unchanged into an unrelated system.
4. Lists expose order, alternatives, ownership, evidence, or consequences. They do not inventory the document's topic areas.
5. Reader-facing prose contains no construction commentary, audience metadata, scope metadata, quality claims, or explanation of what the visual is about to show.
6. Terminology comes from the source or ordinary domain language. New shorthand appears only when it names a recurring relationship more precisely than the source terms alone.
7. Repeated labels, summaries, and restatements have been removed. Each sentence adds information.

If the extracted text fails, rewrite it before evaluating styling.

## Editorial density

Synthesize before presenting. Give visual weight according to importance rather than source volume.

Reach substantive content quickly. Use compact headings, restrained typography, and enough whitespace to separate ideas without turning every paragraph into a panel.

Use code only as mechanism evidence. Use tables for genuine scanning and comparison. Use interaction for deliberate learning steps.

## Direct language

Write with source-native nouns and exact verbs: sends, validates, persists, despawns, projects, retries, rejects, restores.

Name mechanisms directly in headings. State consequences beside the behavior that causes them. Let claims earn adjectives through evidence rather than promotional language.

## Subject-specific composition

Compose each section from its teaching job instead of repeating one page shell. A sequence, ownership map, code mechanism, persistence branch, and comparison may each need different geometry.

Use the project's existing visual language when available. Otherwise choose a quiet base palette and assign accent colors only to technical semantics.

## Guided interaction

Make controls part of the explanation:

1. establish the stable frame;
2. introduce one relationship or stage;
3. update explanation beside the changed view;
4. preserve enough context to connect the steps;
5. finish with the important exception or teardown behavior.

A reader should know why each control exists before activating it.

## Construction questions

Before expanding the representative slice, answer:

1. What source-specific relationship does the main visual reveal?
2. What does each visual encoding mean?
3. What new question does each section answer?
4. Which details belong in the primary narrative, and which belong in reference?
5. Does the composition arise from this subject rather than a reusable landing-page pattern?

When these answers are concrete, the document grammar is ready to scale.
