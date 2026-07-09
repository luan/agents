# Writing Agent Briefs

An agent brief is a `brief` vault artifact linked to a source artifact when that work reaches `ready-for-agent` or `ready-for-human`. It is the durable contract for the next session.

## Principles

### Durability over incidental precision

Describe interfaces, domain types, and behavioral contracts. Prefer stable concepts over file paths and line numbers.

### Behavioral direction

Describe what the system should do and which observable boundaries matter. Leave implementation mechanics to the implementing agent unless a mechanism is itself a settled decision.

### Complete acceptance criteria

Give every criterion an independent pass/fail signal. Include error cases and important boundaries.

### Explicit scope

State adjacent behavior that remains outside this piece of work.

## Template

```markdown
## Agent Brief

**Category:** bug | enhancement
**Summary:** one-line desired outcome

## Current behavior

What happens now, backed by verification.

## Desired behavior

What should happen, including important edge cases.

## Key interfaces

- `DomainConcept` — behavioral contract that changes

## Acceptance criteria

- [ ] Independently verifiable criterion

## Out of scope

- Adjacent behavior excluded from this work

## Verification

- Concrete command or manual check
```

Create the artifact with:

```bash
vlt create --type brief --topic "<brief title>" --source <source-stem> --tags "stage/ready-for-agent" --json
vlt update <brief-stem> --stdin --json
vlt link <brief-stem> <source-stem> --type briefs --annotation "Agent-ready contract"
```
