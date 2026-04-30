---
name: grill-with-docs
description: Grill a plan against vault domain/decision docs; sharpen terminology and update vault docs inline.
user-invocable: true
disable-model-invocation: true
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead.

## Domain awareness

During codebase exploration, also search/read relevant blueprints vault artifacts:

- Domain docs that define project vocabulary and context boundaries.
- Decision docs/specs that record architectural choices for the touched area.
- Related specs/plans that capture active or historical product intent.

Use `ct vault`. Create or update vault artifacts lazily — only when you have a resolved term or decision to record.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with existing vault domain language, call it out immediately. "The vault domain doc defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update vault domain docs inline

When a term is resolved, update the relevant vault domain doc right there. Don't batch these up — capture them as they happen. Use the format in [VAULT-DOMAIN-DOC-FORMAT.md](./VAULT-DOMAIN-DOC-FORMAT.md).

Don't couple domain docs to implementation details. Only include terms that are meaningful to domain experts.

### Offer decision docs sparingly

Only offer to create a decision doc when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the decision doc. Use the format in [VAULT-DECISION-DOC-FORMAT.md](./VAULT-DECISION-DOC-FORMAT.md).
