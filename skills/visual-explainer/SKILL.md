---
name: visual-explainer
description: Explain technical systems visually. Use when a diagram, architecture walkthrough, code-change explanation, comparison, data view, or slide deck would communicate relationships better than prose alone.
license: MIT
---

# Visual Explainer

Create a **source-shaped teaching artifact**: its narrative, geometry, interaction, and styling arise from the subject's actual mechanisms.

Three ideas govern the work:

- **Teaching spine** — an ordered sequence of questions the reader can follow.
- **Source-shaped grammar** — visual structure derived from topology, sequence, state, ownership, scale, or comparison in the source.
- **Earned visual** — every large visual region adds recoverable understanding.

## Process

### 1. Establish the contract

Determine:

- the reader and the question they need answered;
- scope, exclusions, and required concepts;
- the appropriate form: walkthrough, reference, comparison, plan, data view, or slides;
- delivery path and review workflow.

HTML is the default branch. Slides use self-contained HTML. When the user explicitly requests standalone SVG, Markdown with Mermaid, or raster output, deliver that format directly and load only references relevant to it; HTML templates and renderer steps do not apply. Verify SVG bounds and labels, Mermaid source plus text alternatives, or raster legibility as appropriate.

### 2. Recover the source model

Read the relevant source before designing. Trace the actual modules, types, state, inputs, outputs, ordered behavior, and ownership boundaries.

Capture a source fingerprint before modeling: Git commit plus working-tree diff hash, or checksums for the relevant files. Recheck it before delivery. If the source changed, re-read affected material or continue against an explicitly fixed snapshot.

Scope every claim to the behavior the source proves. For concurrent systems, distinguish ownership, execution context, scheduling, and mutation authority.

For every asynchronous boundary, build a private contract row by tracing public request/reply handles, waiter APIs, spawned tasks, `spawn_blocking` calls, deadline resources, timeout result types, and error variants. Record caller, accepted operation, caller wait bound, work bound, outer-task cancellation, underlying side-effect cancellation, every delivery outcome, whether an error becomes data or terminal failure, whether the operation continues, and whether retry is safe. A boundary is incomplete until those fields are verified or explicitly inapplicable.

Prove execution location from the called function, not from the message used to return its result. For registries, catalogs, and authentication, trace capability registration, configuration precedence, unavailable or missing-credential behavior, and post-configuration refresh.

Name temporal anchors from the exact write or assignment that creates them. Do not replace “after durable prompt commit and before provider work” with an ambiguous label such as “pre-turn.”

Verify planned source paths. Copy source-exact excerpts directly; label compressed teaching excerpts as simplified.

For each ordered mechanism, create a private hierarchical ledger containing stages, nested order, triggers, state changes, transitions, and branches. Copy the sequence from one verified source span and generate every displayed order, count, label, and textual alternative from that single ledger; never hand-type parallel copies.

Keep a private coverage matrix. Rows are the major mechanisms required by the reader; columns are:

- ownership and mutable state;
- trigger, exact order, and state transition;
- execution context, waits, deadlines, and retry safety;
- failure, cancellation, staleness, and terminal outcomes;
- durability, recovery, and restart behavior;
- projection or other reader-observable consequence;
- source evidence.

Breadth means every required subsystem has a primary explanation. Depth means each load-bearing subsystem explains the governing mechanism, at least one important branch or boundary, and its consequence. Mark irrelevant cells explicitly instead of silently omitting them.

Use a source path only beside the mechanism or excerpt it substantiates. Do not add a detached “source locations,” file map, provenance, or repository tour section unless the user explicitly requests source navigation or an audit. Keep research process, confidence labels, and construction metadata private.

**Complete when:** the source fingerprint is stable; the coverage matrix has no unexplained gap; every required concept has source support or an approved exclusion; every asynchronous boundary distinguishes wait timeout from operation timeout, continuation, retry safety, and terminal outcomes; and every excerpt is copied exactly or marked simplified. Begin visual design only after this state exists.

### 3. Set the teaching spine

Order the document by the reader's reasoning path:

- lifecycle for behavioral systems;
- ownership and dependency flow for architecture;
- before/after behavior for changes;
- decision criteria for comparisons;
- chronology for timelines;
- concrete reader questions for exploratory material.

Lead with the stable mental model, then mechanism, then important exceptions. Place code beside the mechanism it demonstrates. Keep inventories as compact reference rather than narrative.

Keep the teaching spine private by default. Render a reader question only when the artifact is explicitly exploratory and the question itself is the navigation mechanism; otherwise use the source-native mechanism heading directly.
Choose the opening from the artifact's teaching job:

- a substantial reference may begin with the exact subject and a summary that explains the governing mechanism and predicts a behavior;
- a focused diagram may begin with its accessible title and explanatory caption;
- a compact comparison may begin with the decision question and table caption.

Headings use mechanism names from the source. Legends sit beside the visual they decode. Audience guidance appears only when it changes how the artifact is read.

Reader-facing examples in templates model final-quality explanation. Structural examples use explicit bracketed placeholders rather than finished-sounding generic copy.

For substantial multi-section HTML, use a persistent top bar for document-level navigation and a page-local table of contents for section navigation. Load `./references/responsive-nav.md`. Preserve the reading surface by moving navigation out of the masthead and progressively disclosing secondary detail.

### 4. Choose source-shaped grammar

Each visual answers one named technical question with the simplest exact representation:

| Question | Representation |
| --- | --- |
| What happens, and in what order? | Flow or sequence diagram |
| Who owns state or authority? | Ownership or data-flow diagram |
| What depends on what? | Dependency or topology diagram |
| What states and transitions exist? | State diagram |
| How do alternatives differ? | Semantic table |
| What changed? | Annotated before/after or diff |
| What are the measured values? | Table or chart |

A diagram earns space by making a relationship visible that prose would conceal. Text, code, and semantic tables remain first-class when they are clearer.

For layered or staged mechanisms, load `./references/guided-exploration.md`. Build interactions as lessons: establish context, add one relationship, update adjacent explanation, and preserve prior understanding.

A generated image qualifies only when a concrete scene, physical subject, or tightly bounded metaphor teaches something exact diagrams cannot. When it qualifies, load `./references/generated-visuals.md` and `$imagegen`. Otherwise use code-native visuals.

### 5. Prove one representative slice

For a substantial artifact, build one real section before expanding. Include final navigation, one source-shaped visualization, direct mechanism explanation, and a Shiki-highlighted excerpt when code evidence is useful.

When browser review is permitted, inspect the slice in Chrome through `$computer-use`; otherwise run the static layout and interaction checks.

When staged review is part of the contract, present this slice before expansion.

**Complete when:** the slice teaches its mechanism cleanly and establishes a reusable document grammar.

### 6. Build the artifact

Build the contracted form. For HTML, write the document to the requested path or `~/.agent/diagrams/` with embedded CSS, JavaScript, and rendered assets.

Construct from the source model:

- use the reference register for the title, summary, and headings;
- choose geometry from the relationship being taught;
- render ordered behavior from the hierarchical ledger with explicit branch labels;
- keep code exact or visibly simplified and place it beside the mechanism it demonstrates;
- use semantic tables only for genuine comparison;
- load `./references/guided-exploration.md` when interaction teaches staged or selectable relationships;
- load `./references/generated-visuals.md` only when imagery qualifies;
- load `./references/css-patterns.md` for HTML accessibility, responsive behavior, code, tables, and diagram mechanics;
- derive typography and color from the project or platform, assigning additional visual treatments only to defined technical semantics;
- keep research process and construction metadata out of the reader-facing artifact.

For substantial documents, load `./references/anti-slop.md` while choosing the document grammar.

Before delivery, use a fresh read-only reviewer when subagents are available. Give it the raw artifact, fixed source fingerprint, and source path only—not the intended answer or prior diagnosis. Require a claim-by-claim factual review and plain-text editorial review; resolve every material finding. Without subagents, perform a cold second pass from an extracted claim list.

### 7. Verify delivery

Verify in this order:

1. **Plain-text content:** run `bun ./scripts/lint-visible-copy.ts <artifact.html>`, then apply the semantic content gate in `./references/anti-slop.md`.
2. **Truth and coverage:** required concepts are covered or explicitly excluded; claims, paths, excerpts, and source-shaped visuals agree with the source.
3. **Cold claim review:** complete the independent or cold source-claim review and resolve every material finding.
4. **Structure and behavior:** ordered visuals match their source ledgers; interactions earn their place; branch-specific reference checks pass.
5. **Rendered delivery:** after the earlier gates pass, use Chrome through `$computer-use` and follow `./references/rendered-review.md` at desktop width, a narrow viewport when available, and 200% zoom.

**Complete when:** the content, truth, cold review, structure, and applicable rendered checks pass in that order.

## Reference routing

Load only the branch-specific material needed:

| Need | Read |
| --- | --- |
| Source-shaped craft for substantial documents | `./references/anti-slop.md` |
| Guided architecture interaction | `./references/guided-exploration.md` |
| Generated illustration qualification and art direction | `./references/generated-visuals.md` |
| Technical document layout mechanics | `./templates/architecture.html` |
| Mermaid implementation and interaction | `./templates/mermaid-flowchart.html`, Mermaid sections in `./references/libraries.md` |
| Tables and comparisons | `./templates/data-table.html` |
| CSS, overflow, and code patterns | `./references/css-patterns.md` |
| Multi-section navigation | `./references/responsive-nav.md` |
| Chrome presentation review | `./references/rendered-review.md` |
| Slides | `./templates/slide-deck.html`, `./references/slide-patterns.md` |

Templates are mechanics, not page prescriptions. Reuse the working behavior and derive the composition from the source.

## Mermaid branch

Use Mermaid when automatic graph layout is the simplest exact representation. Follow `templates/mermaid-flowchart.html` and the Mermaid sections of `references/libraries.md`.

Keep each graph focused. Interactive diagrams provide semantic controls, visible focus, keyboard equivalents, a textual alternative, and Ctrl/Cmd-gated wheel zoom that preserves normal page scrolling.

## Slide branch

Use slides only when explicitly requested. Build a decision-focused sequence from the teaching spine, with one point per `100dvh` slide and visible keyboard and pointer navigation.

Map required claims to the main sequence or a compact appendix. Let evidence support the narrative rather than reproduce the source document.
