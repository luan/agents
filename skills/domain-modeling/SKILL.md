---
name: domain-modeling
description: Build and sharpen a project's vault-backed domain model. Use when the user wants to pin down domain terminology, record a durable decision, or when another skill needs to maintain project language.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. Challenge terms, invent edge-case scenarios, and update vault context and decision artifacts the moment they crystallise. Reading existing vocabulary is ordinary context gathering; this skill is for changing the model.

## Vault structure

Load `$vault`, then follow its context routing before inspecting or changing project language. Read `vault://current/context#check` after context edits. Use `read`, `search`, `find`, `write`, and `edit` on vault resources. Use `vlt` only for explicit CLI workflows.

Store durable trade-offs as typed vault artifacts:

```bash
vlt create --type decision --topic "<decision topic>" --json
vlt update <decision-stem> --stdin --json
```

Create context entries and decision artifacts lazily, only when something has resolved.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with vault context, call it out immediately. "The project glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update vault context inline

When a term is resolved, edit the relevant `vault://current/context` resource immediately. Use `vlt context set` only when the user explicitly requests its CLI workflow.

Keep vault context as a glossary: canonical vocabulary and tight definitions. Put behavior in specs and trade-offs in decision artifacts.

### Offer decision artifacts sparingly

Only offer to create a decision artifact when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, leave the choice in the conversation or its owning spec. Use [DECISION-FORMAT.md](./DECISION-FORMAT.md).
