# Guided Exploration

Use interaction to teach a system in a deliberate order. The reader should understand more after each action, not merely see a different subset of the same diagram.

## Learning sequence

Derive the sequence from the private source ledger. Start with the minimum state needed to understand the first transition. Each next step introduces one source event, state change, relationship, or explicit branch.

Keep learned context visible. The adjacent explanation names the new relationship and the behavior it predicts.

## Stepper layout

Keep controls, visual, and detail together:

```html
<section class="guided-view" data-stepper>
  <ol class="step-controls" aria-label="[Walkthrough name]">
    <li><button data-step="0" aria-current="step"
                aria-controls="guided-stage guided-detail" tabindex="0">[Step 1]</button></li>
    <li><button data-step="1" aria-controls="guided-stage guided-detail"
                tabindex="-1">[Step 2]</button></li>
    <li><button data-step="2" aria-controls="guided-stage guided-detail"
                tabindex="-1">[Step 3]</button></li>
  </ol>

  <div id="guided-stage" class="guided-stage">
    <svg><!-- elements carry data-enter-step="N" --></svg>
    <aside id="guided-detail" class="step-detail" aria-live="polite">
      <h3 data-step-title>[Current mechanism]</h3>
      <div data-step-copy>[Explain the new relationship and its consequence.]</div>
    </aside>
  </div>
</section>
```

```css
.guided-stage {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(280px, .65fr);
  gap: 14px;
}
.step-controls { display: flex; gap: 6px; margin: 0 0 10px; padding: 0; list-style: none; }
[data-enter-step] { opacity: 0; visibility: hidden; transition: opacity .18s ease, transform .18s ease; }
[data-enter-step].learned { opacity: .62; visibility: visible; }
[data-enter-step].current { opacity: 1; visibility: visible; }
.step-detail { border-left: 3px solid var(--accent); padding: 12px 14px; background: var(--panel); }
@media (max-width: 850px) { .guided-stage { grid-template-columns: 1fr; } }
```

The active step introduces a visible relationship: new nodes or edges enter, a path advances, geometry expands, or the adjacent detail changes. Previous steps remain legible as learned context.

The step controls use roving `tabindex`. Arrow keys activate adjacent steps; Home and End activate the first and last. Pointer and keyboard activation run the same state transition.

Each step maps to one source event or state transition. Preserve chronology; use separate guided views when ownership, persistence, and teardown occur on different axes.

Build the step sequence from a private hierarchical source ledger. Outer stages become the overview; nested ordered systems receive a scoped expansion. Completion, failure, cancellation, and continuation use explicit decision branches when their effects differ.

## Linked selection

For ownership maps, selecting an entity or resource should update both the visual and an adjacent relationship panel:

- selected construct remains fully emphasized;
- direct producers and consumers are emphasized;
- unrelated constructs recede strongly but remain locatable;
- the adjacent panel lists state, writers, readers, invariants, and teardown;
- Arrow keys activate adjacent selections; Home and End activate the first and last;
- tabs use stable IDs, `aria-controls`, `aria-labelledby`, and roving `tabindex`.

Keep the detail panel beside the visual on desktop and immediately after it on narrow layouts.

## Drill-down

Use drill-down when the overview and internals have different useful geometries:

- overview establishes component boundaries;
- selecting a component replaces or expands the visual with its internals;
- a visible breadcrumb/back control preserves orientation;
- the detail view explains how its inputs and outputs connect to the overview.

Create a focused internal view instead of zooming a universal diagram.

## Generated visual integration

A generated visual can support guided exploration only when it passes `./generated-visuals.md`; load `$imagegen` after the teaching job and art direction are concrete.

## Completion

The guided view is complete when:

- each control names a learning step;
- each step introduces a visible relationship and adjacent explanation;
- prior context remains understandable;
- the final step covers the important exception, failure, or teardown behavior;
- keyboard and pointer navigation select the same states;
- narrow layouts keep each control close to its changed content.
