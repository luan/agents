---
name: improve-codebase-architecture
description: 'Find architecture-deepening refactor opportunities grounded in vault docs and code evidence. Use when the user asks to improve codebase architecture, module boundaries, cohesion, or AI navigability.'
user-invocable: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

## Glossary

Use these terms exactly in every suggestion. Consistent language is the point — don't drift into "component," "service," "API," or "boundary." Full definitions in [LANGUAGE.md](LANGUAGE.md).

- **Module** — anything with an interface and an implementation (function, class, package, slice).
- **Interface** — everything a caller must know to use the module: types, invariants, error modes, ordering, config. Not just the type signature.
- **Implementation** — the code inside.
- **Depth** — leverage at the interface: a lot of behaviour behind a small interface. **Deep** = high leverage. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place. (Use this, not "boundary.")
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, knowledge concentrated in one place.

Key principles (see [LANGUAGE.md](LANGUAGE.md) for the full list):

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

This skill is _informed_ by the project's domain model. Vault domain docs give names to good seams; vault decision docs record decisions the skill should not re-litigate.

## Process

### 1. Explore

Search/read relevant blueprints vault domain and decision artifacts for the area you're touching first. If no relevant vault docs exist, proceed silently.

Then use the Agent tool with `subagent_type=Explore` to walk the codebase. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Present candidates

Present a numbered list of deepening opportunities. For each candidate:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and also in how tests would improve

**Use vault domain vocabulary for the domain, and [LANGUAGE.md](LANGUAGE.md) vocabulary for the architecture.** If a vault domain doc defines "Order," talk about "the Order intake module" — not "the FooBarHandler," and not "the Order service."

**Decision conflicts**: if a candidate contradicts an existing vault decision artifact, only surface it when the friction is real enough to warrant revisiting the decision. Mark it clearly (e.g. _"contradicts [[event-sourced-orders]] — but worth reopening because…"_). Don't list every theoretical refactor a decision forbids.

Do NOT propose interfaces yet. Ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, drop into a grilling conversation. Walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Side effects happen inline as decisions crystallize:

- **Naming a deepened module after an undocumented domain concept?** Create or update the relevant vault domain doc — same discipline as `$grill-with-docs` (see [VAULT-DOMAIN-DOC-FORMAT.md](../grill-with-docs/VAULT-DOMAIN-DOC-FORMAT.md)). Create the vault doc lazily only when there is a resolved term to record.
- **Sharpening a fuzzy term during the conversation?** Update the relevant vault domain doc right there.
- **User rejects the candidate with a load-bearing reason?** Offer a vault decision doc, framed as: _"Want me to record this as a decision doc so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones. See [VAULT-DECISION-DOC-FORMAT.md](../grill-with-docs/VAULT-DECISION-DOC-FORMAT.md).
- **Want to explore alternative interfaces for the deepened module?** See [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md).

### 4. Follow-up tasks

If the user asks for executable follow-up work, create persisted tasks with `ct task`; do not add planning files to the repo or vault unless explicitly asked.
