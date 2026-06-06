---
name: grill
description: Grilling session that challenges a plan one decision at a time against the existing domain model, code reality, and durable decisions. Use when the user wants to stress-test a plan against their project's language and documented decisions while sharpening terminology and capturing resolved context inline.
---

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each decision, provide your recommended answer.

Resolve one decision at a time. Default to one question, but include tightly related subquestions when they are part of the same decision.

Act as a domain-model governor, plan interrogator, collaborative design partner, and documentation capture agent: challenge the plan, recommend concrete answers, validate claims against code, and preserve durable knowledge as decisions crystallise.

If a question can be answered by exploring the codebase, explore the codebase instead. Keep code checks lightweight unless the current decision depends on deeper investigation.

</what-to-do>

<supporting-info>

## Domain awareness

During codebase exploration, also look for existing documentation in the $vault. Use `vlt context ...` for glossary/context structure and normal `vlt` artifact commands for research, briefs, plans, decisions, and reviews.

Start with:

```sh
vlt context list
vlt context check
vlt context show
vlt list
vlt search "<topic>"
```

### File structure

Most vaults have a single context:

```
/
├── CONTEXT.md
├── decision/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
```

If a `CONTEXT-MAP.md` exists at the root, the vault has multiple contexts. The map points to where each one lives:

```
/
├── CONTEXT-MAP.md
├── decision/                     ← normal typed artifacts for system-wide decisions
├── contexts/
│   ├── ordering/
│   │   └── CONTEXT.md
│   └── billing/
│       └── CONTEXT.md
```

Create files lazily — only when you have something to write. If no `CONTEXT.md` exists, `vlt context set ...` creates it when the first term is resolved. If a durable decision threshold is met, create a normal typed artifact with `vlt create --type decision --topic "..."`.

## During the session

### Challenge against the glossary

Read the applicable context with `vlt context show` or `vlt context show <name>`. Treat the glossary as a starting point, not law. When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately, then resolve whether the user is misusing the term or the context has evolved. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. Distinguish neighboring concepts, lifecycle states, roles, ownership boundaries, and avoided or confusing synonyms. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Focus on edge cases and role/state matrices that expose unclear permissions, lifecycle ambiguity, hidden assumptions, and boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. Prioritize contradictions between the plan and implementation reality. Verify relevant code reality before durable documentation updates. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Visual Collaboration

Use visuals only when they reduce ambiguity faster than more prose, especially for workflow, UI, state, approval-flow, data-layout, or information-architecture decisions.

- Ask a focused visual-choice question with 2-4 options.
- Generate a disposable image with `image_gen` when the user needs a quick mock, mood, layout direction, or visual metaphor.
- Load/use `$visual-doc` for temporary Plannotator HTML when interaction states,
  data layout, or multi-step flows matter.

### Update CONTEXT.md inline

When a term or distinction is resolved, update `CONTEXT.md` right there with `vlt context set`. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

Examples:

```sh
vlt context set Customer --definition "A person or organization that places orders." --avoid Client,buyer
vlt context set Order --context ordering --definition "A commercial request placed by a Customer."
vlt context check
```

`CONTEXT.md` should be totally devoid of implementation details. Do not treat `CONTEXT.md` as a spec, a scratch pad, a repository for implementation decisions, or a place for acceptance criteria. It is a glossary and nothing else.

Durable domain context and decisions are first-class project knowledge assets. Keep them current as the conversation resolves real terminology and trade-offs.

### Create decision artifacts when warranted

Create a decision artifact when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the decision artifact. When creating one, include the serious rejected options and why they were rejected. Use `vlt create --type decision --topic "..." --json`, edit the returned file, then `vlt commit`. Use the content format in [ADR-FORMAT.md](./ADR-FORMAT.md).

</supporting-info>
