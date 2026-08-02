# Technical Visual Patterns

Use these mechanics when plain semantic HTML is insufficient. The page should resemble an engineering reference: flat surfaces, compact headings, exact labels, and visuals whose geometry carries information.

## Base document

```css
:root {
  --bg: Canvas;
  --surface: Canvas;
  --surface-2: ButtonFace;
  --border: GrayText;
  --text: CanvasText;
  --text-dim: GrayText;
  --accent: LinkText;
  --code: #0d1117;
  --code-text: #e6edf3;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 var(--sans); }
main { min-width: 0; max-width: 1320px; padding: 24px 32px 80px; }
h1 { margin: 0 0 8px; font-size: 25px; line-height: 1.2; }
h2 { margin: 0 0 6px; font-size: 20px; }
```

Keep the title, scope, and navigation below 25% of the first `1440x900` viewport. Begin substantive content with a topology, sequence, state, ownership, data, or comparison visual.

## Technical split

Place the explanation and supporting code in the same viewport.

```css
.technical-split {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 850px) { .technical-split { grid-template-columns: 1fr; } }
```

## Diagram surface

```css
.diagram {
  border: 1px solid var(--border);
  background: var(--surface);
  overflow: auto;
  min-height: 320px;
}
.diagram svg { display: block; width: 100%; height: auto; }
.diagram text { fill: var(--text); font-family: var(--sans); }
.diagram .source-label { fill: var(--text-dim); font: 12.5px var(--mono); }
.diagram .edge { fill: none; stroke: var(--text-dim); stroke-width: 1.5; }
```

A diagram must encode relationships through position, grouping, direction, edge style, state, scale, or filtering. A grid of prose boxes is not a diagram.

### Connector integrity

Draw one connector per relationship. Its visible line begins at the source boundary and its arrowhead touches the destination boundary. Do not draw one arrowed path behind several nodes; occlusion leaves detached arrowheads and ambiguous direction.

In progressive SVG, group each edge, arrowhead, edge label, and step-specific endpoint:

```html
<g data-enter-step="2" data-relationship="request-to-provider">
  <path class="edge" d="[source boundary to destination boundary]" marker-end="url(#arrow)" />
  <text class="edge-label">[Relationship]</text>
</g>
```

Apply visibility to the group. Never reveal or hide the path independently from the relationship it explains.

### Text containment

Every text-bearing grid child and card needs `min-width: 0`. Identifiers and unbroken labels need an explicit breaking policy.

```css
.flow-node,
.diagram-card,
.technical-split > *,
.guided-layout > * {
  min-width: 0;
}
.flow-node,
.diagram-card {
  overflow-wrap: anywhere;
}
```

For SVG, use deliberate `tspan` lines and measure the longest rendered line against the node width plus padding. Use HTML layout or `foreignObject` for variable text. A `viewBox` and `overflow: auto` do not prevent text from leaking out of its own node.

## Guided interaction

Use `./guided-exploration.md` for staged diagrams and linked detail views. Keep the control, changed visual, and explanation in one viewport.

Composite widgets use complete relationships and keyboard behavior:

```html
<div role="tablist" aria-label="Ownership details">
  <button id="tab-agent" role="tab" aria-selected="true"
          aria-controls="panel-agent" tabindex="0">Agent</button>
  <button id="tab-turn" role="tab" aria-selected="false"
          aria-controls="panel-turn" tabindex="-1">Turn</button>
</div>
<section id="panel-agent" role="tabpanel" aria-labelledby="tab-agent">...</section>
<section id="panel-turn" role="tabpanel" aria-labelledby="tab-turn" hidden>...</section>
```

Selection updates `aria-selected`, panel visibility, and roving `tabindex`. Arrow keys activate adjacent tabs; Home and End activate the first and last tab. Native buttons provide Enter and Space activation.

Use native list, heading, article, table, and region semantics for HTML-based diagrams. `role="img"` is appropriate for an atomic SVG or canvas with a complete accessible name; it should not flatten meaningful HTML descendants.

## Syntax-highlighted code

Use Shiki or an equivalent production highlighter at generation time and embed its rendered HTML and token styles. The delivered artifact remains self-contained; highlighting does not run in the browser.

Every non-trivial excerpt needs:

- preserved indentation with `white-space: pre`;
- horizontal scrolling;
- a theme with readable contrast in the surrounding document;
- enough surrounding code to understand the mechanism;
- placement beside the explanation it supports;
- a file/symbol label only when code location matters.

```css
.code-file { min-width: 0; border: 1px solid #30363d; background: #0d1117; }
.code-file__head { padding: 7px 10px; border-bottom: 1px solid #30363d; color: #8b949e; font: 12px var(--mono); }
.code-file pre.shiki { margin: 0; max-height: 440px; overflow: auto; padding: 14px; background: #0d1117 !important; font: 12.5px/1.58 var(--mono); tab-size: 4; white-space: pre; }
```

Do not approximate highlighting with a handful of generic token classes. Do not use `pre-wrap` for source code.

## Exact inventories

Use tables only when row/column scanning is the clearest representation. Add filtering, sorting, or relationship highlighting when the table is large or central to the explanation.

```html
<div class="table-wrap" role="region" aria-label="Source locations" tabindex="0">
  <table>...</table>
</div>
```

```css
.table-wrap { overflow: auto; border: 1px solid var(--border); }
.table-wrap table { width: 100%; min-width: 760px; border-collapse: collapse; background: var(--surface); }
th, td { border: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; }
th { background: var(--surface-2); font: 600 12.5px var(--mono); }
```

The wrapper owns overflow. For central comparisons, prefer a narrow-layout recomposition over horizontal panning.

## Adjacent explanation

Use a narrow rule to connect an explanation to its diagram or code. Do not turn paragraphs into cards.

```css
.explanation { border-left: 3px solid var(--accent); padding-left: 14px; }
```

## Reduced motion

Disable smooth scrolling and nonessential transitions when the reader requests reduced motion.

```css
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
```
