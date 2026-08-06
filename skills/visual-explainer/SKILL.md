---
name: visual-explainer
description: Create visual explanations of technical systems, code changes, plans, comparisons, and data when spatial structure communicates better than prose.
---

# Visual Explainer

Explain the requested subject with diagrams and code in one pass. Derive the document structure and visual geometry from relationships verified in the source.

## Workflow

### 1. Read the source

Read the relevant implementation. Infer reasonable audience and scope defaults instead of asking questions. Use exact names and paths where useful; label condensed behavior or code as simplified.

Identify:

- the core mechanism;
- ownership and mutable state;
- sequence and transitions;
- dependencies and execution boundaries;
- failure or cancellation behavior;
- reader-visible consequences.

Scale research and coverage to the wording of the request. Focused questions need only the relevant path. Requests using “all,” “every,” “complete,” “deep,” or equivalent language require repository-wide coverage of the requested domain.

For comprehensive requests:

- Read the project map, bootstrap and plugin registration, domain types, resources, messages/events, ordered schedules, persistence, external work, and projection boundaries.
- Build one private source inventory of major systems, resources, entities, and components before writing the artifact.
- Give every major subsystem a primary explanation or state a concrete exclusion.
- For each load-bearing mechanism, explain its trigger and order, state mutation, execution context, async boundary, durability, failure/cancellation behavior, reader-visible result, and source evidence.
- Include a filterable inventory with name, kind, owner/lifetime, writers/readers, interactions, removal or failure effect, and source location.
- Use exact code evidence across the major mechanisms rather than concentrating excerpts in one section.

### 2. Organize the document

Start with a title formed from the system name and the mechanism or domain being explained, followed by a one- or two-sentence summary and an overview diagram. Organize later sections by lifecycle, ownership, dependency flow, before/after behavior, chronology, or decision criteria.

Each substantial section answers one technical question with the clearest form:

| Question | Form |
| --- | --- |
| What happens in order? | Flow or sequence diagram |
| Who owns or changes state? | Ownership or data-flow diagram |
| What depends on what? | Topology or dependency diagram |
| What states and transitions exist? | State diagram |
| How do alternatives differ? | Comparison table |
| What changed? | Annotated before/after view |
| What are the measured values? | Table or chart |

Place explanation and exact or simplified code beside the mechanism they support. Reader-visible text uses source terminology rather than authoring or construction terminology.
Render every multi-line code excerpt with syntax highlighting. Prefer generation-time Shiki output embedded in the HTML; otherwise mark comments, keywords, types/functions, strings, and numbers with styled spans.

### 3. Build the artifact

Use self-contained HTML by default or the user's requested format.
For HTML documents with four or more major sections, read and reuse the mechanics in `./templates/architecture.html`.

- Draw relationships with spatial grouping, connectors, layers, sequence, and consistent visual semantics.
- Use an overview plus focused mechanism diagrams for complex systems.
- Use lightweight interaction only when selecting a phase, layer, state, or owner improves understanding.
- Keep inventories compact for focused explanations. For comprehensive requests, include the full source-derived inventory required by the requested scope.
- Prefer native HTML, CSS, and SVG. Add JavaScript or a library only when it materially improves the result.
- Define diagram colors with literal `fill` and `stroke` values in a scoped `<style>` inside each SVG. Prefix diagram classes to avoid collisions with page styles.

### 4. Compose the page

- For non-slide documents, reserve at least half of the first viewport for a diagram or other substantive technical content.
- Render the masthead as exactly one `<h1>` followed by one concise mechanism-summary paragraph. Keep it under one-third of the viewport with a restrained document-scale heading.
- Use one source-native `<h2>` per section. Keep ordering numbers in the table of contents rather than adding category labels above headings.
- Use a quiet neutral surface and one primary accent. Additional colors encode defined technical meaning.
- Let prose flow naturally. Give bounded regions only to independently meaningful mechanisms, ownership groups, states, or interactions.
- Use borders and containment to communicate grouping and authority.
- Use source-native mechanism names for headings and labels.
- Make every large visual region reveal topology, sequence, state, ownership, causality, scale, or comparison.
- Use clear hierarchy, accessible contrast, semantic markup, visible focus, and responsive overflow.
- Size the document shell to use the viewport: a roughly 180–220 px contents rail and a wide reading surface where primary diagrams fill the available width.
- End with substantive explanation or reference content; keep source evidence beside the claims it supports.

### 5. Add navigation and interaction when the document needs them

- For documents with four or more major sections, use a compact sticky top bar for document identity and a persistent table-of-contents rail for section links. On narrow screens, turn the rail into a sticky horizontal section bar.
- Highlight the current section while scrolling.
- For inventory tables with many rows, add a search field that filters rows and keep column headings visible while scrolling.
- For comprehensive system walkthroughs, make the longest ordered mechanism a keyboard-accessible phase selector or stepper with the stable diagram and adjacent explanation visible together.
- For three or more parallel ownership views or related contracts, use keyboard-accessible tabs with clear selected state.
- Keep controls beside the visual or table they affect. Each interaction reveals a relationship or makes dense reference material easier to navigate.

### 6. Check once and deliver

Spot-check load-bearing claims, diagram order, labels, and code against the source. Render once when practical and fix obvious factual, clipping, overflow, or interaction defects. Then deliver.

Write to the requested path; otherwise use `~/.agent/diagrams/` with a descriptive filename.

Do not create a plan, fingerprint, matrix, scout task, staged preview, independent review, lint gate, or repeated validation cycle unless the user explicitly asks for it.
