---
name: grill-with-docs
description: "Challenge a plan against vault domain and decision docs, then update vault docs inline when approved. Use when the user asks to grill a plan with documented project context."
user-invocable: true
disable-model-invocation: true
---

# Grill With Docs

Interrogate the plan against existing project vocabulary, decisions, and code reality. Ask in small batches and give a recommended answer for each question.

## Gather context

Before questioning, read relevant vault artifacts with `vault_*` tools:

- domain docs for vocabulary and boundaries
- decision docs and research artifacts for recorded choices
- related plans for historical implementation intent

If a question can be answered by code exploration, inspect the code instead of asking.

## Questioning style

- Challenge terms that conflict with vault language.
- Replace vague language with precise candidate terms.
- Use concrete scenarios to test boundaries and edge cases.
- Check code when the user claims current behavior.
- Keep each batch small enough for the user to answer carefully.

## Updating docs

When a domain term is resolved, update the relevant vault domain doc immediately using [VAULT-DOMAIN-DOC-FORMAT.md](./VAULT-DOMAIN-DOC-FORMAT.md). Capture concepts meaningful to domain experts; do not couple domain docs to implementation details.

Offer a decision doc only when the decision is hard to reverse, surprising without context, and the result of a real trade-off. Use [VAULT-DECISION-DOC-FORMAT.md](./VAULT-DECISION-DOC-FORMAT.md).
